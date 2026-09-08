/**
 * PIMF — the length-prefixed frame framing `pi-mac --stream` writes to stdout.
 *
 * Wire format (round-21 computer-use contract, Lane N):
 *
 *   frame := "PIMF" | uint32be headerLen | uint32be payloadLen
 *          | header(JSON utf8) | payload(JPEG)
 *
 * A payload of ZERO bytes is legal and meaningful: it is the once-only
 * `{ …, windows: [] }` frame the helper emits when the controlled app has no
 * on-screen window, so the consumer can show "no window" instead of freezing on
 * the last picture. It must NOT be mistaken for a truncated frame.
 *
 * This module is deliberately pure (Buffers in, frames out, no process, no
 * electron) because framing bugs are the kind that only appear under real
 * chunking: a 150 KB JPEG at 12fps arrives as a dozen arbitrary pipe reads, a
 * header can be split down the middle, and two frames routinely share one
 * chunk. Those are exactly the cases the unit tests drive.
 */

/** One window in a frame header (screen POINTS, top-left origin). */
export interface PimfWindow {
  windowId: number;
  title: string;
  frame: { x: number; y: number; w: number; h: number };
  sheet?: boolean;
  modal?: boolean;
}

/** The JSON header carried by every frame. */
export interface PimfHeader {
  seq: number;
  /** ms epoch. */
  t: number;
  /** Pixel size of the JPEG payload. */
  w: number;
  h: number;
  /** Backing scale (2 on retina) — `w/scale` is the point width. */
  scale: number;
  /** Union rect of the app's windows in screen POINTS — the real size to draw. */
  rect: { x: number; y: number; w: number; h: number };
  /** Main display size in points. */
  display: { w: number; h: number };
  windows: PimfWindow[];
}

export interface PimfFrame {
  header: PimfHeader;
  /** JPEG bytes; length 0 for the "no window" frame. */
  payload: Uint8Array;
}

const MAGIC = Buffer.from('PIMF', 'ascii');
const PREFIX_BYTES = MAGIC.length + 8;

/**
 * Sanity caps. A header is a small JSON object and a frame is a JPEG of a
 * screen; anything wildly outside that means we are reading garbage (helper
 * crashed mid-frame, a stray log line on stdout), and the parser should resync
 * on the next magic rather than allocate on a bogus length.
 */
const MAX_HEADER_BYTES = 1 << 20; // 1 MiB
const MAX_PAYLOAD_BYTES = 64 << 20; // 64 MiB

/** Shape-check a decoded header — a malformed one is dropped, never trusted. */
function isHeader(value: unknown): value is PimfHeader {
  if (value === null || typeof value !== 'object') return false;
  const h = value as Record<string, unknown>;
  const rect = h.rect as Record<string, unknown> | undefined;
  const display = h.display as Record<string, unknown> | undefined;
  return (
    typeof h.seq === 'number' &&
    rect !== undefined &&
    rect !== null &&
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.w === 'number' &&
    typeof rect.h === 'number' &&
    display !== undefined &&
    display !== null &&
    typeof display.w === 'number' &&
    typeof display.h === 'number' &&
    Array.isArray(h.windows)
  );
}

/** Normalize a decoded header so consumers never have to re-check optionals. */
function normalize(raw: PimfHeader): PimfHeader {
  const windows: PimfWindow[] = [];
  for (const w of raw.windows as unknown[]) {
    if (w === null || typeof w !== 'object') continue;
    const rec = w as Record<string, unknown>;
    const f = (rec.frame ?? {}) as Record<string, unknown>;
    windows.push({
      windowId: typeof rec.windowId === 'number' ? rec.windowId : 0,
      title: typeof rec.title === 'string' ? rec.title : '',
      frame: {
        x: typeof f.x === 'number' ? f.x : 0,
        y: typeof f.y === 'number' ? f.y : 0,
        w: typeof f.w === 'number' ? f.w : 0,
        h: typeof f.h === 'number' ? f.h : 0,
      },
      sheet: rec.sheet === true,
      modal: rec.modal === true,
    });
  }
  return {
    seq: raw.seq,
    t: typeof raw.t === 'number' ? raw.t : 0,
    w: typeof raw.w === 'number' ? raw.w : 0,
    h: typeof raw.h === 'number' ? raw.h : 0,
    scale: typeof raw.scale === 'number' && raw.scale > 0 ? raw.scale : 1,
    rect: raw.rect,
    display: raw.display,
    windows,
  };
}

/**
 * Incremental PIMF reader. Feed it every stdout chunk; it returns whichever
 * complete frames that chunk finished (often zero, sometimes several).
 *
 * Resync is deliberate rather than fatal: if the leading bytes are not the
 * magic (the helper printed a warning to stdout, or we attached mid-stream) the
 * parser scans forward to the next "PIMF" and carries on, so one bad byte can
 * never wedge the stream forever.
 */
export class PimfParser {
  #buf: Buffer = Buffer.alloc(0);
  /** Frames whose header failed to decode (diagnostics only). */
  #dropped = 0;

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.#buf.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  reset(): void {
    this.#buf = Buffer.alloc(0);
  }

  push(chunk: Uint8Array): PimfFrame[] {
    this.#buf =
      this.#buf.length === 0
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.concat([this.#buf, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
    const out: PimfFrame[] = [];
    for (;;) {
      const frame = this.#next(out);
      if (frame === 'wait') break;
    }
    return out;
  }

  /** One step of the state machine. Returns 'wait' when it needs more bytes. */
  #next(out: PimfFrame[]): 'wait' | 'again' {
    const buf = this.#buf;
    if (buf.length < PREFIX_BYTES) {
      // Not even a prefix. If what we DO have cannot be the start of a magic,
      // drop the junk now instead of waiting for bytes that will never help.
      if (buf.length > 0 && !couldStartMagic(buf)) {
        this.#resync();
        return 'again';
      }
      return 'wait';
    }
    if (buf.compare(MAGIC, 0, MAGIC.length, 0, MAGIC.length) !== 0) {
      this.#resync();
      return 'again';
    }
    const headerLen = buf.readUInt32BE(4);
    const payloadLen = buf.readUInt32BE(8);
    if (headerLen === 0 || headerLen > MAX_HEADER_BYTES || payloadLen > MAX_PAYLOAD_BYTES) {
      // A length we will never believe: skip this magic and hunt for the next.
      this.#buf = buf.subarray(1);
      this.#resync();
      return 'again';
    }
    const total = PREFIX_BYTES + headerLen + payloadLen;
    if (buf.length < total) return 'wait';

    const headerText = buf.toString('utf8', PREFIX_BYTES, PREFIX_BYTES + headerLen);
    // Copy the payload: the accumulation Buffer is sliced/reused, and a
    // subarray would alias memory we are about to drop on the floor.
    const payload = Uint8Array.prototype.slice.call(
      buf,
      PREFIX_BYTES + headerLen,
      total,
    ) as Uint8Array;
    this.#buf = buf.subarray(total);

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerText);
    } catch {
      this.#dropped += 1;
      return 'again';
    }
    if (!isHeader(parsed)) {
      this.#dropped += 1;
      return 'again';
    }
    out.push({ header: normalize(parsed), payload });
    return 'again';
  }

  /** Drop bytes up to the next magic (keeping a possible split magic tail). */
  #resync(): void {
    const at = this.#buf.indexOf(MAGIC);
    if (at > 0) {
      this.#buf = this.#buf.subarray(at);
      return;
    }
    if (at === 0) return;
    // No magic in the buffer: keep only a tail that could be its prefix.
    const keep = Math.min(this.#buf.length, MAGIC.length - 1);
    const tail = this.#buf.subarray(this.#buf.length - keep);
    this.#buf = couldStartMagic(tail) ? tail : Buffer.alloc(0);
  }
}

/** Could `buf`'s first bytes be the beginning of the magic? */
function couldStartMagic(buf: Buffer): boolean {
  const n = Math.min(buf.length, MAGIC.length);
  for (let i = 0; i < n; i++) {
    if (buf[i] !== MAGIC[i]) return false;
  }
  return true;
}

/**
 * Encode one PIMF frame. The mock frame source uses it, and so do the parser
 * tests — writing the encoder once means the tests exercise the real framing
 * rather than a hand-rolled approximation of it.
 */
export function encodePimf(header: PimfHeader, payload: Uint8Array): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.length, 4);
  prefix.writeUInt32BE(payload.length, 8);
  return Buffer.concat([prefix, headerBytes, Buffer.from(payload)]);
}
