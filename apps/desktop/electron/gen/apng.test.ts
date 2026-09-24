import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApngEncoder,
  crc32,
  encodeApng,
  frameDelay,
  isApng,
  readPngChunks,
  readPngFrame,
  readPngHead,
  stillOfApng,
  writeApngFile,
} from './apng.js';

/*
 * The checks below never trust apng.ts to check itself: CRCs are recomputed
 * with zlib's own crc32 (a separate implementation), chunks are walked by hand,
 * and every frame is inflated back to its raw scanlines and compared with the
 * pixels it was made from.
 */

/** zlib's CRC-32, when this Node has it; else a textbook bitwise one (still not apng.ts's). */
const refCrc = (data: Uint8Array): number => {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
  if (native !== undefined) return native(data) >>> 0;
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function rawChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(refCrc(body));
  return Buffer.concat([len, body, crc]);
}

/** Channels per pixel for a PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface TestPng {
  readonly png: Buffer;
  /** The filtered scanlines (filter byte 0 + pixels) the IDAT data inflates to. */
  readonly raw: Buffer;
}

/**
 * A minimal PNG encoder: filter-0 scanlines, deflated by zlib. `seed` varies
 * the pixels so every frame is distinct; `before`/`after` add chunks around the
 * image data; `split` cuts the IDAT data into that many chunks.
 */
function makePng(opts: {
  width: number;
  height: number;
  colorType?: number;
  bitDepth?: number;
  seed?: number;
  before?: ReadonlyArray<readonly [string, Buffer]>;
  after?: ReadonlyArray<readonly [string, Buffer]>;
  split?: number;
}): TestPng {
  const { width, height, colorType = 6, bitDepth = 8, seed = 0, split = 1 } = opts;
  const bytesPerPixel = ((CHANNELS[colorType] as number) * bitDepth) / 8;
  const stride = Math.ceil(width * bytesPerPixel);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      const v = (x * 31 + y * 17 + seed * 53) & 0xff;
      // Indexed pixels must stay inside the 4-entry palette the tests use.
      raw[y * (stride + 1) + 1 + x] = colorType === 3 ? v % 4 : v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const data = zlib.deflateSync(raw);
  const pieces: Buffer[] = [];
  const size = Math.ceil(data.length / split);
  for (let i = 0; i < data.length; i += size) pieces.push(data.subarray(i, i + size));
  const png = Buffer.concat([
    SIG,
    rawChunk('IHDR', ihdr),
    ...(opts.before ?? []).map(([t, d]) => rawChunk(t, d)),
    ...pieces.map((p) => rawChunk('IDAT', p)),
    ...(opts.after ?? []).map(([t, d]) => rawChunk(t, d)),
    rawChunk('IEND', Buffer.alloc(0)),
  ]);
  return { png, raw };
}

interface Walked {
  readonly type: string;
  readonly data: Buffer;
}

/** Walk the chunks by hand, asserting every length and CRC with the reference CRC. */
function walk(file: Buffer): Walked[] {
  expect(file.subarray(0, 8).equals(SIG)).toBe(true);
  const out: Walked[] = [];
  let at = 8;
  while (at < file.length) {
    const len = file.readUInt32BE(at);
    const type = file.subarray(at + 4, at + 8).toString('latin1');
    const data = file.subarray(at + 8, at + 8 + len);
    const crc = file.readUInt32BE(at + 8 + len);
    expect(crc, `CRC of ${type} at byte ${at}`).toBe(refCrc(file.subarray(at + 4, at + 8 + len)));
    out.push({ type, data });
    at += 12 + len;
  }
  expect(at).toBe(file.length); // nothing trailing, nothing cut short
  return out;
}

interface DecodedFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly delayNum: number;
  readonly delayDen: number;
  readonly dispose: number;
  readonly blend: number;
  /** The frame's compressed data, joined from its IDAT or fdAT chunks. */
  readonly data: Buffer;
  /** Sequence numbers of its fdAT chunks. */
  readonly dataSequences: number[];
}

/** A small APNG reader: acTL, and every frame with its control fields and data. */
function decodeApng(file: Buffer) {
  const chunks = walk(file);
  const actl = chunks.find((c) => c.type === 'acTL');
  if (actl === undefined) throw new Error('no acTL');
  const frames: DecodedFrame[] = [];
  let current: { -readonly [K in keyof DecodedFrame]: DecodedFrame[K] } | undefined;
  const pieces: Buffer[] = [];
  const flush = () => {
    if (current !== undefined) frames.push({ ...current, data: Buffer.concat(pieces) });
    pieces.length = 0;
  };
  for (const c of chunks) {
    if (c.type === 'fcTL') {
      flush();
      current = {
        sequence: c.data.readUInt32BE(0),
        width: c.data.readUInt32BE(4),
        height: c.data.readUInt32BE(8),
        x: c.data.readUInt32BE(12),
        y: c.data.readUInt32BE(16),
        delayNum: c.data.readUInt16BE(20),
        delayDen: c.data.readUInt16BE(22),
        dispose: c.data[24] as number,
        blend: c.data[25] as number,
        data: Buffer.alloc(0),
        dataSequences: [],
      };
    } else if (c.type === 'IDAT') {
      pieces.push(c.data);
    } else if (c.type === 'fdAT') {
      current?.dataSequences.push(c.data.readUInt32BE(0));
      pieces.push(c.data.subarray(4));
    }
  }
  flush();
  return {
    types: chunks.map((c) => c.type),
    ihdr: (chunks[0] as Walked).data,
    numFrames: actl.data.readUInt32BE(0),
    numPlays: actl.data.readUInt32BE(4),
    frames,
  };
}

describe('crc32', () => {
  it('matches zlib on assorted input, and the value PNG itself hard-codes for IEND', () => {
    for (const s of ['', 'a', 'IEND', 'The quick brown fox jumps over the lazy dog']) {
      expect(crc32(Buffer.from(s))).toBe(refCrc(Buffer.from(s)));
    }
    const noise = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) & 0xff));
    expect(crc32(noise)).toBe(refCrc(noise));
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });

  it('continues across pieces exactly as over the joined bytes', () => {
    const a = Buffer.from('fdAT');
    const b = Buffer.from([0, 0, 0, 2, 9, 8, 7]);
    expect(crc32(b, crc32(a))).toBe(crc32(Buffer.concat([a, b])));
  });
});

describe('reading a PNG', () => {
  it('reads every chunk and joins split image data', () => {
    const { png, raw } = makePng({ width: 5, height: 4, split: 3 });
    expect(readPngChunks(png).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IDAT', 'IDAT', 'IEND']);
    const frame = readPngFrame(png);
    expect(frame.width).toBe(5);
    expect(frame.height).toBe(4);
    expect(zlib.inflateSync(frame.data).equals(raw)).toBe(true);
  });

  it('keeps the chunks before the image data, and drops the ones after it', () => {
    const { png } = makePng({
      width: 2,
      height: 2,
      before: [['sRGB', Buffer.from([0])]],
      after: [['tEXt', Buffer.from('Comment\0frame 0')]],
    });
    expect(readPngFrame(png).preamble.map((c) => c.type)).toEqual(['sRGB']);
  });

  it('refuses what is not a whole, intact PNG', () => {
    const { png } = makePng({ width: 3, height: 3 });
    expect(() => readPngChunks(Buffer.from('PNG-1'))).toThrow(/not a PNG/);
    // Cut off before IEND: a capture that was still being written.
    expect(() => readPngChunks(png.subarray(0, png.length - 12))).toThrow(/truncated/);
    // One flipped bit in the image data.
    const flipped = Buffer.from(png);
    flipped[45] = (flipped[45] as number) ^ 0x01;
    expect(() => readPngChunks(flipped)).toThrow(/bad CRC/);
  });

  it('refuses a frame that is already animated', () => {
    const apng = encodeApng([makePng({ width: 2, height: 2 }).png], { fps: 10 });
    expect(() => readPngFrame(apng)).toThrow(/already animated/);
  });
});

describe('frameDelay', () => {
  it('is exact for a whole frame rate', () => {
    expect(frameDelay(24)).toEqual({ num: 1, den: 24 });
    expect(frameDelay(1)).toEqual({ num: 1, den: 1 });
  });

  it('rounds any other rate to the millisecond', () => {
    expect(frameDelay(12.5)).toEqual({ num: 80, den: 1000 });
    expect(frameDelay(29.97)).toEqual({ num: 33, den: 1000 });
    expect(frameDelay(0.5)).toEqual({ num: 2000, den: 1000 });
  });

  it('keeps both halves inside 16 bits for a very slow rate', () => {
    const d = frameDelay(0.001); // one frame every 1000 s
    expect(d.num).toBeLessThanOrEqual(0xffff);
    expect(d.num / d.den).toBeCloseTo(1000, 0);
  });

  it('refuses a rate that is not a rate', () => {
    expect(() => frameDelay(0)).toThrow(RangeError);
    expect(() => frameDelay(Number.NaN)).toThrow(RangeError);
  });
});

describe('encodeApng', () => {
  const three = [0, 1, 2].map((seed) => makePng({ width: 4, height: 3, seed }));

  it('writes the APNG chunk sequence: acTL, then fcTL + IDAT, then fcTL + fdAT per frame', () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    expect(apng.types).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fcTL',
      'fdAT',
      'fcTL',
      'fdAT',
      'IEND',
    ]);
  });

  it('declares the frame count and loops forever by default', () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    expect(apng.numFrames).toBe(3);
    expect(apng.numPlays).toBe(0);
    expect(apng.frames).toHaveLength(3);
  });

  it('numbers fcTL and fdAT from 0 with no gaps, shared across both', () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    expect(apng.frames.map((f) => f.sequence)).toEqual([0, 1, 3]);
    expect(apng.frames.map((f) => f.dataSequences)).toEqual([[], [2], [4]]);
  });

  it('gives every frame the whole canvas, 1/fps s, dispose NONE and blend SOURCE', () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    for (const f of apng.frames) {
      expect(f).toMatchObject({
        width: 4,
        height: 3,
        x: 0,
        y: 0,
        delayNum: 1,
        delayDen: 12,
        dispose: 0,
        blend: 0,
      });
    }
  });

  it("carries frame 0's IHDR as the file's", () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    expect(apng.ihdr.equals(readPngFrame(three[0]?.png as Buffer).header)).toBe(true);
  });

  it('decodes back to exactly the pixels every frame was made from', () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    apng.frames.forEach((f, i) => {
      expect(zlib.inflateSync(f.data).equals(three[i]?.raw as Buffer), `frame ${i}`).toBe(true);
    });
  });

  it("moves each frame's compressed data unchanged — nothing is re-encoded", () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12 },
      ),
    );
    apng.frames.forEach((f, i) => {
      expect(f.data.equals(readPngFrame(three[i]?.png as Buffer).data), `frame ${i}`).toBe(true);
    });
  });

  it('joins a frame whose data was split over several IDAT chunks', () => {
    const split = [
      makePng({ width: 6, height: 5, split: 4 }),
      makePng({ width: 6, height: 5, seed: 9, split: 2 }),
    ];
    const apng = decodeApng(
      encodeApng(
        split.map((f) => f.png),
        { fps: 5 },
      ),
    );
    expect(apng.types.filter((t) => t === 'IDAT' || t === 'fdAT')).toEqual(['IDAT', 'fdAT']);
    apng.frames.forEach((f, i) => {
      expect(zlib.inflateSync(f.data).equals(split[i]?.raw as Buffer)).toBe(true);
    });
  });

  it("keeps frame 0's colour-space chunks, ahead of acTL", () => {
    const frames = [0, 1].map((seed) =>
      makePng({ width: 2, height: 2, seed, before: [['gAMA', Buffer.from([0, 0, 0xb1, 0x8f])]] }),
    );
    const apng = decodeApng(
      encodeApng(
        frames.map((f) => f.png),
        { fps: 2 },
      ),
    );
    expect(apng.types.slice(0, 4)).toEqual(['IHDR', 'gAMA', 'acTL', 'fcTL']);
    // One gAMA for the file — frame 1's copy is not repeated mid-stream.
    expect(apng.types.filter((t) => t === 'gAMA')).toHaveLength(1);
  });

  it('round-trips every colour type and depth PNG has', () => {
    const palette = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const cases = [
      { colorType: 0, bitDepth: 8 },
      { colorType: 2, bitDepth: 8 },
      { colorType: 3, bitDepth: 8, before: [['PLTE', palette] as const] },
      { colorType: 4, bitDepth: 8 },
      { colorType: 6, bitDepth: 8 },
      { colorType: 6, bitDepth: 16 },
    ];
    for (const c of cases) {
      const frames = [0, 1, 2].map((seed) => makePng({ width: 7, height: 3, seed, ...c }));
      const apng = decodeApng(
        encodeApng(
          frames.map((f) => f.png),
          { fps: 30 },
        ),
      );
      expect(apng.ihdr[9]).toBe(c.colorType);
      apng.frames.forEach((f, i) => {
        expect(zlib.inflateSync(f.data).equals(frames[i]?.raw as Buffer)).toBe(true);
      });
    }
  });

  it('honours a play count', () => {
    const apng = decodeApng(
      encodeApng(
        three.map((f) => f.png),
        { fps: 12, plays: 3 },
      ),
    );
    expect(apng.numPlays).toBe(3);
  });

  it('is a valid one-frame file too', () => {
    const apng = decodeApng(encodeApng([three[0]?.png as Buffer], { fps: 12 }));
    expect(apng.types).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND']);
    expect(apng.numFrames).toBe(1);
  });
});

describe('frames that cannot share one animation', () => {
  it('refuses a frame of another size, naming which frame', () => {
    const a = makePng({ width: 4, height: 3 }).png;
    const b = makePng({ width: 4, height: 4, seed: 1 }).png;
    expect(() => encodeApng([a, a, b], { fps: 2 })).toThrow(/frame 2 cannot join the animation/);
  });

  it('refuses a frame of another colour type', () => {
    const a = makePng({ width: 4, height: 3, colorType: 6 }).png;
    const b = makePng({ width: 4, height: 3, colorType: 2 }).png;
    expect(() => encodeApng([a, b], { fps: 2 })).toThrow(/colour type 2/);
  });

  it('refuses an indexed frame with a different palette, and takes one with the same', () => {
    const plte = (r: number) => Buffer.from([r, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const frame = (seed: number, r: number) =>
      makePng({ width: 3, height: 2, colorType: 3, seed, before: [['PLTE', plte(r)]] }).png;
    expect(() => encodeApng([frame(0, 1), frame(1, 2)], { fps: 2 })).toThrow(/PLTE differs/);
    expect(() => encodeApng([frame(0, 1), frame(1, 1)], { fps: 2 })).not.toThrow();
  });

  it('refuses more frames than it declared, and fewer', () => {
    const png = makePng({ width: 2, height: 2 }).png;
    const over = new ApngEncoder({ frames: 1, fps: 2 });
    over.add(png);
    expect(() => over.add(png)).toThrow(/declared with 1 frames/);
    const under = new ApngEncoder({ frames: 2, fps: 2 });
    under.add(png);
    expect(() => under.finish()).toThrow(/declared with 2 frames; got 1/);
  });

  it('refuses a frame that is not a PNG at all', () => {
    expect(() => encodeApng([Buffer.from('PNG-1')], { fps: 2 })).toThrow(/not a PNG/);
  });
});

describe('isApng / stillOfApng', () => {
  const frames = [0, 1, 2].map((seed) =>
    makePng({ width: 5, height: 2, seed, before: [['sRGB', Buffer.from([0])]] }),
  );
  const apng = encodeApng(
    frames.map((f) => f.png),
    { fps: 8 },
  );

  it('tells an animation from a still', () => {
    expect(isApng(apng)).toBe(true);
    expect(isApng(frames[0]?.png as Buffer)).toBe(false);
  });

  it('lifts frame 0 out as a plain, valid still PNG', () => {
    const still = stillOfApng(apng) as Buffer;
    const chunks = walk(still);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    const data = chunks.find((c) => c.type === 'IDAT')?.data as Buffer;
    expect(zlib.inflateSync(data).equals(frames[0]?.raw as Buffer)).toBe(true);
    expect(isApng(still)).toBe(false);
  });

  it('has nothing to lift from a PNG that is not animated', () => {
    expect(stillOfApng(frames[0]?.png as Buffer)).toBeUndefined();
  });
});

describe('writeApngFile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const scratch = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'apng-test-'));
    dirs.push(d);
    return d;
  };

  it('streams the frames from disk into the same file encodeApng builds in memory', async () => {
    const dir = scratch();
    const frames = [0, 1, 2, 3].map((seed) => makePng({ width: 8, height: 6, seed }).png);
    const paths = frames.map((png, i) => {
      const p = path.join(dir, `frame_${i}.png`);
      writeFileSync(p, png);
      return p;
    });
    const out = path.join(dir, 'animation.png');
    await writeApngFile(paths, out, { fps: 24 });
    const written = readFileSync(out);
    expect(written.equals(encodeApng(frames, { fps: 24 }))).toBe(true);
    expect(decodeApng(written).numFrames).toBe(4);
  });

  it('reads one frame at a time, writing each before reading the next', async () => {
    const frames = [0, 1, 2].map((seed) => makePng({ width: 4, height: 4, seed }).png);
    const events: string[] = [];
    await writeApngFile(
      ['f0', 'f1', 'f2'],
      'out',
      { fps: 3 },
      {
        readFile: async (p) => {
          events.push(`read ${p}`);
          return frames[Number(p.slice(1))] as Buffer;
        },
        writeFile: async (_p, parts) => {
          let bytes = 0;
          for await (const part of parts) {
            bytes += part.length;
            if (events.at(-1)?.startsWith('read')) events.push('write');
          }
          events.push(`closed ${bytes > 0}`);
        },
        remove: async () => undefined,
      },
    );
    expect(events).toEqual([
      'read f0',
      'write',
      'read f1',
      'write',
      'read f2',
      'write',
      'closed true',
    ]);
  });

  it('leaves no file behind when a frame part-way through is bad', async () => {
    const dir = scratch();
    const good = makePng({ width: 4, height: 4 }).png;
    const bad = good.subarray(0, good.length - 20); // truncated mid-capture
    const paths = [good, good, bad].map((png, i) => {
      const p = path.join(dir, `frame_${i}.png`);
      writeFileSync(p, png);
      return p;
    });
    const out = path.join(dir, 'animation.png');
    await expect(writeApngFile(paths, out, { fps: 2 })).rejects.toThrow(/truncated/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('readPngHead', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = (name: string, bytes: Buffer): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'apng-head-'));
    dirs.push(d);
    const p = path.join(d, name);
    writeFileSync(p, bytes);
    return p;
  };

  it("reads an animation only as far as frame 0's data, and that is enough for its still", async () => {
    const frames = [0, 1, 2, 3].map((seed) => makePng({ width: 40, height: 30, seed, split: 2 }));
    const apng = encodeApng(
      frames.map((f) => f.png),
      { fps: 10 },
    );
    const head = await readPngHead(file('animation.png', apng));
    expect(walk(head).map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND']);
    expect(head.length).toBeLessThan(apng.length / 2);
    const still = stillOfApng(head) as Buffer;
    const data = walk(still).find((c) => c.type === 'IDAT')?.data as Buffer;
    expect(zlib.inflateSync(data).equals(frames[0]?.raw as Buffer)).toBe(true);
  });

  it('reads a still PNG whole', async () => {
    const { png } = makePng({ width: 9, height: 9, split: 3 });
    expect((await readPngHead(file('frame.png', png))).equals(png)).toBe(true);
  });

  it('refuses a file cut off inside its image data', async () => {
    const { png } = makePng({ width: 9, height: 9 });
    await expect(readPngHead(file('cut.png', png.subarray(0, 45)))).rejects.toThrow(/truncated/);
  });
});
