/**
 * ANIMATED PNG, IN PLAIN TYPESCRIPT — the one file a HyperFrames render becomes.
 *
 * the user: "attempting a hyperframes animation generation, rendered 120 induvidual
 * frames, each of which was placed as it's own png card in the chat, severely
 * cluttering it." The renderer returned one output per frame, the tool listed
 * every path, and the thread mounted every path as a card. The frames are one
 * animation, so they are delivered as one: an APNG, which an `<img>` in
 * Chromium plays natively — the same card every generated picture uses.
 *
 * WHY APNG AND NOT A VIDEO. HyperFrames is a still renderer with no encoder on
 * purpose: ffmpeg is not bundled (only a developer's Mac has it) and nothing
 * here may reach the network. An APNG needs neither. Its frames ARE the PNGs
 * the renderer already captured — the compressed image data is moved, never
 * decoded or re-encoded — so joining them costs file I/O and a CRC, and the
 * pixels in the animation are bit-for-bit the pixels in the frames.
 *
 * THE FORMAT (https://wiki.mozilla.org/APNG_Specification), as written here:
 *
 *   signature · IHDR · (frame 0's chunks before its data) · acTL
 *   fcTL(seq 0) · IDAT                       ← frame 0, also the default image
 *   fcTL(seq 1) · fdAT(seq 2)                ← frame 1
 *   fcTL(seq 3) · fdAT(seq 4)                ← frame 2 …
 *   IEND
 *
 * Every frame covers the whole canvas (offset 0,0, full size) with dispose NONE
 * and blend SOURCE, so each one simply replaces the last. A viewer that knows
 * nothing of APNG skips the ancillary acTL/fcTL/fdAT chunks and shows frame 0.
 */

import { open, readFile, rm, writeFile } from 'node:fs/promises';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The PNG spec's ceiling on one chunk's length (2^31 − 1). */
const MAX_CHUNK_LENGTH = 0x7fffffff;
/** IHDR's colour type for an indexed (palette) image. */
const INDEXED = 3;

/** The CRC-32 table (the ISO 3309 polynomial PNG uses, reflected: 0xEDB88320). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of `data`, continuing from `crc` — the CRC of everything before it, as
 * zlib's `crc32(crc, buf)` does — so a chunk's CRC can run over its type and
 * then its pieces without ever joining them into one buffer.
 */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One chunk of a PNG: its four-letter type and a view of its data. */
export interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * Every chunk of a PNG, in file order, through IEND.
 *
 * Strict on purpose: a bad signature, a chunk running past the end, a failed
 * CRC or a missing IEND throws. A frame is joined into the animation without
 * being decoded, so this is the only point a truncated or corrupted capture can
 * be caught — and the caller falls back to something honest rather than
 * shipping an animation with a broken frame in the middle of it.
 */
export function readPngChunks(png: Uint8Array): PngChunk[] {
  const buf = asBuffer(png);
  if (buf.length < SIGNATURE.length || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  const chunks: PngChunk[] = [];
  let at = SIGNATURE.length;
  for (;;) {
    if (at + 12 > buf.length) throw new Error('truncated PNG (no IEND)');
    const length = buf.readUInt32BE(at);
    if (length > MAX_CHUNK_LENGTH) throw new Error(`corrupt PNG (chunk length ${length})`);
    const typeBytes = buf.subarray(at + 4, at + 8);
    const type = typeBytes.toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('corrupt PNG (bad chunk type)');
    const end = at + 12 + length;
    if (end > buf.length) throw new Error(`truncated PNG (${type} runs past the end)`);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (crc32(data, crc32(typeBytes)) !== buf.readUInt32BE(at + 8 + length)) {
      throw new Error(`corrupt PNG (bad CRC on ${type})`);
    }
    chunks.push({ type, data });
    at = end;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR') throw new Error('corrupt PNG (IHDR is not first)');
  return chunks;
}

/** One still, as the animation needs it. */
export interface PngFrame {
  readonly width: number;
  readonly height: number;
  /** IHDR's 13 bytes: size, bit depth, colour type, compression, filter, interlace. */
  readonly header: Buffer;
  /** The chunks between IHDR and the image data (palette, colour space…), in order. */
  readonly preamble: readonly PngChunk[];
  /** The compressed image data: every IDAT payload, concatenated. */
  readonly data: Buffer;
}

/** Read one still PNG into the parts an animation frame is built from. */
export function readPngFrame(png: Uint8Array): PngFrame {
  const chunks = readPngChunks(png);
  const header = (chunks[0] as PngChunk).data;
  if (header.length !== 13) throw new Error('corrupt PNG (IHDR is not 13 bytes)');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (width === 0 || height === 0) throw new Error('corrupt PNG (zero size)');
  const preamble: PngChunk[] = [];
  const idat: Buffer[] = [];
  for (const chunk of chunks.slice(1)) {
    if (chunk.type === 'acTL' || chunk.type === 'fcTL' || chunk.type === 'fdAT') {
      throw new Error('this PNG is already animated; a frame must be a still');
    }
    if (chunk.type === 'IDAT') idat.push(chunk.data);
    // Text, time and the like after the image data describe that one file,
    // not the animation, and are left behind with it.
    else if (chunk.type !== 'IEND' && idat.length === 0) preamble.push(chunk);
  }
  if (idat.length === 0) throw new Error('corrupt PNG (no image data)');
  return {
    width,
    height,
    header: Buffer.from(header),
    preamble,
    data: idat.length === 1 ? (idat[0] as Buffer) : Buffer.concat(idat),
  };
}

/**
 * How long each frame shows, as the fcTL's `delay_num / delay_den` seconds.
 *
 * An integer rate is exact — 1/24 s at 24 fps. Anything else is the nearest
 * whole number of milliseconds (then hundredths, tenths, seconds, for rates so
 * slow a frame outlasts 65 s), since both halves are 16-bit.
 */
export function frameDelay(fps: number): { readonly num: number; readonly den: number } {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError(`bad frame rate: ${fps}`);
  if (Number.isInteger(fps) && fps <= 0xffff) return { num: 1, den: fps };
  for (const den of [1000, 100, 10, 1]) {
    const num = Math.round(den / fps);
    if (num <= 0xffff) return { num: Math.max(1, num), den };
  }
  return { num: 0xffff, den: 1 };
}

/**
 * One chunk as the pieces to write, never joined: its length and type, the data
 * pieces as they were handed in, and the CRC over type + data computed across
 * them. A frame's data is most of the file, and this is what keeps it from being
 * copied on its way through.
 */
function chunkParts(type: string, pieces: readonly Uint8Array[]): Buffer[] {
  const typeBytes = Buffer.from(type, 'latin1');
  let length = 0;
  let crc = crc32(typeBytes);
  for (const piece of pieces) {
    length += piece.length;
    crc = crc32(piece, crc);
  }
  if (length > MAX_CHUNK_LENGTH) throw new Error(`${type} is too large for one PNG chunk`);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(length, 0);
  typeBytes.copy(head, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc, 0);
  return [head, ...pieces.map(asBuffer), tail];
}

function uint32s(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) out.writeUInt32BE(values[i] as number, i * 4);
  return out;
}

/**
 * What every later frame is checked against — frame 0's header and, for an
 * indexed image, its palette. Copied out so the encoder does not keep frame 0's
 * whole image alive for the length of the animation.
 */
interface FrameShape {
  readonly width: number;
  readonly height: number;
  readonly header: Buffer;
  readonly palette: Readonly<Record<'PLTE' | 'tRNS', Buffer | undefined>>;
}

function shapeOf(frame: PngFrame): FrameShape {
  const copy = (type: string): Buffer | undefined => {
    const data = frame.preamble.find((c) => c.type === type)?.data;
    return data === undefined ? undefined : Buffer.from(data);
  };
  return {
    width: frame.width,
    height: frame.height,
    header: Buffer.from(frame.header),
    palette: { PLTE: copy('PLTE'), tRNS: copy('tRNS') },
  };
}

/** Why `frame` cannot share an animation with frame 0, or undefined when it can. */
function mismatch(first: FrameShape, frame: PngFrame): string | undefined {
  if (!frame.header.equals(first.header)) {
    return (
      `its header differs from frame 0's (${frame.width}x${frame.height}, ` +
      `colour type ${frame.header[9]}, depth ${frame.header[8]} vs ${first.width}x${first.height}, ` +
      `colour type ${first.header[9]}, depth ${first.header[8]})`
    );
  }
  /*
   * An indexed frame's data means nothing without ITS palette, and the file has
   * room for one: frame 0's. A different palette would play in the wrong colours.
   */
  if (first.header[9] === INDEXED) {
    for (const type of ['PLTE', 'tRNS'] as const) {
      const theirs = frame.preamble.find((c) => c.type === type)?.data;
      const ours = first.palette[type];
      const same =
        ours === undefined || theirs === undefined ? ours === theirs : ours.equals(theirs);
      if (!same) return `its ${type} differs from frame 0's`;
    }
  }
  return undefined;
}

export interface ApngOptions {
  /** How many frames the file will hold — acTL states it before the first one arrives. */
  readonly frames: number;
  /** Playback rate: each frame shows for 1/fps s. */
  readonly fps: number;
  /** How many times to play; 0 (the default) loops forever. */
  readonly plays?: number;
}

/**
 * Builds an animated PNG one frame at a time, handing back the bytes to write
 * as it goes — so a caller can stream frames from disk into the file without
 * ever holding the whole animation in memory.
 *
 * All frames must share frame 0's IHDR (size, bit depth, colour type,
 * interlace), and an indexed one its palette too: an APNG has one header and one
 * palette. A frame that does not throws, naming which frame and why.
 */
export class ApngEncoder {
  readonly #frames: number;
  readonly #plays: number;
  readonly #delay: { readonly num: number; readonly den: number };
  #first: FrameShape | undefined;
  #added = 0;
  #sequence = 0;

  constructor(options: ApngOptions) {
    if (!Number.isInteger(options.frames) || options.frames < 1) {
      throw new RangeError(`an animation needs at least one frame (got ${options.frames})`);
    }
    const plays = options.plays ?? 0;
    if (!Number.isInteger(plays) || plays < 0) throw new RangeError(`bad play count: ${plays}`);
    this.#frames = options.frames;
    this.#plays = plays;
    this.#delay = frameDelay(options.fps);
  }

  /** The bytes for the next frame — on the first, preceded by the file's header. */
  add(png: Uint8Array): Buffer[] {
    const index = this.#added;
    if (index >= this.#frames) {
      throw new Error(`the animation was declared with ${this.#frames} frames; got more`);
    }
    const frame = readPngFrame(png);
    const parts: Buffer[] = [];
    const first = this.#first;
    if (first === undefined) {
      this.#first = shapeOf(frame);
      parts.push(Buffer.from(SIGNATURE), ...chunkParts('IHDR', [frame.header]));
      for (const chunk of frame.preamble) parts.push(...chunkParts(chunk.type, [chunk.data]));
      parts.push(...chunkParts('acTL', [uint32s(this.#frames, this.#plays)]));
    } else {
      const why = mismatch(first, frame);
      if (why !== undefined) throw new Error(`frame ${index} cannot join the animation: ${why}`);
    }
    const control = Buffer.alloc(26);
    control.writeUInt32BE(this.#sequence++, 0);
    control.writeUInt32BE(frame.width, 4);
    control.writeUInt32BE(frame.height, 8);
    control.writeUInt32BE(0, 12); // x offset
    control.writeUInt32BE(0, 16); // y offset
    control.writeUInt16BE(this.#delay.num, 20);
    control.writeUInt16BE(this.#delay.den, 22);
    control.writeUInt8(0, 24); // dispose: NONE
    control.writeUInt8(0, 25); // blend: SOURCE
    parts.push(...chunkParts('fcTL', [control]));
    if (index === 0) {
      // Frame 0's data stays IDAT, which is what makes it the default image.
      parts.push(...chunkParts('IDAT', [frame.data]));
    } else {
      parts.push(...chunkParts('fdAT', [uint32s(this.#sequence++), frame.data]));
    }
    this.#added = index + 1;
    return parts;
  }

  /** The bytes that close the file. Throws unless exactly the declared frames were added. */
  finish(): Buffer[] {
    if (this.#added !== this.#frames) {
      throw new Error(`the animation was declared with ${this.#frames} frames; got ${this.#added}`);
    }
    return chunkParts('IEND', []);
  }
}

/** Join still PNGs, in order, into one animated PNG in memory. */
export function encodeApng(
  frames: readonly Uint8Array[],
  options: Omit<ApngOptions, 'frames'>,
): Buffer {
  const encoder = new ApngEncoder({ ...options, frames: frames.length });
  const parts: Buffer[] = [];
  for (const frame of frames) parts.push(...encoder.add(frame));
  parts.push(...encoder.finish());
  return Buffer.concat(parts);
}

/** The file operations {@link writeApngFile} needs — the real ones unless a test says otherwise. */
export interface ApngFileIo {
  readonly readFile: (filePath: string) => Promise<Uint8Array>;
  readonly writeFile: (filePath: string, parts: AsyncIterable<Uint8Array>) => Promise<void>;
  readonly remove: (filePath: string) => Promise<void>;
}

const NODE_IO: ApngFileIo = {
  readFile: (filePath) => readFile(filePath),
  writeFile: (filePath, parts) => writeFile(filePath, parts),
  remove: (filePath) => rm(filePath, { force: true }),
};

/**
 * Join the still PNGs at `framePaths`, in order, into one animated PNG at
 * `outPath`.
 *
 * Streams: each frame is read, turned into its chunks and written before the
 * next is read, so memory holds one frame, not the animation (a 300-frame
 * render is hundreds of MB). A failure part-way removes the partial file rather
 * than leaving something at `outPath` that looks like a finished animation.
 */
export async function writeApngFile(
  framePaths: readonly string[],
  outPath: string,
  options: Omit<ApngOptions, 'frames'>,
  io: ApngFileIo = NODE_IO,
): Promise<void> {
  const encoder = new ApngEncoder({ ...options, frames: framePaths.length });
  async function* parts(): AsyncGenerator<Uint8Array> {
    for (const framePath of framePaths) yield* encoder.add(await io.readFile(framePath));
    yield* encoder.finish();
  }
  try {
    await io.writeFile(outPath, parts());
  } catch (err) {
    await io.remove(outPath).catch(() => undefined);
    throw err;
  }
}

/**
 * A PNG file read only as far as the end of its FIRST image — signature, header,
 * whatever precedes the data, and the first run of IDAT — then closed with IEND.
 *
 * For an animation that is its default image and nothing after it, so a caller
 * wanting one picture (the poster) does not read every frame to get it: a long
 * render at a large size is hundreds of MB, and this runs in the app's main
 * process. A still PNG comes back whole.
 */
export async function readPngHead(filePath: string): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    let at = 0;
    const read = async (length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await file.read(buf, 0, length, at);
      if (bytesRead !== length) throw new Error('truncated PNG (ends inside a chunk)');
      at += length;
      return buf;
    };
    const parts: Buffer[] = [await read(SIGNATURE.length)];
    let inImage = false;
    for (;;) {
      const head = await read(8);
      const length = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (inImage && type !== 'IDAT') break;
      if (length > MAX_CHUNK_LENGTH) throw new Error(`corrupt PNG (chunk length ${length})`);
      parts.push(head, await read(length + 4));
      if (type === 'IEND') return Buffer.concat(parts);
      if (type === 'IDAT') inImage = true;
    }
    parts.push(...chunkParts('IEND', []));
    return Buffer.concat(parts);
  } finally {
    await file.close();
  }
}

/** Is this PNG animated (does it carry an acTL chunk)? */
export function isApng(png: Uint8Array): boolean {
  return readPngChunks(png).some((c) => c.type === 'acTL');
}

/**
 * One still picture of an animated PNG: its default image, with the animation
 * chunks dropped — which, for every APNG written here, is exactly frame 0.
 *
 * For whatever wants a single picture of the animation without an APNG-aware
 * decoder: the chat model's poster frame is the case this exists for.
 * Undefined when the PNG is not animated — it is already a still.
 */
export function stillOfApng(png: Uint8Array): Buffer | undefined {
  const chunks = readPngChunks(png);
  if (!chunks.some((c) => c.type === 'acTL')) return undefined;
  const kept = chunks.filter((c) => c.type !== 'acTL' && c.type !== 'fcTL' && c.type !== 'fdAT');
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    ...kept.flatMap((c) => chunkParts(c.type, [c.data])),
  ]);
}
