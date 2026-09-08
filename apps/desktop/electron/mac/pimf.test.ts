import { describe, expect, it } from 'vitest';
import { encodePimf, type PimfHeader, PimfParser } from './pimf';

function header(patch: Partial<PimfHeader> = {}): PimfHeader {
  return {
    seq: 1,
    t: 1_700_000_000_000,
    w: 1200,
    h: 800,
    scale: 2,
    rect: { x: 100, y: 60, w: 600, h: 400 },
    display: { w: 1512, h: 982 },
    windows: [{ windowId: 7, title: 'Untitled', frame: { x: 100, y: 60, w: 600, h: 400 } }],
    ...patch,
  };
}

const jpeg = (n: number, fill = 0xab): Uint8Array => new Uint8Array(n).fill(fill);

describe('PimfParser', () => {
  it('reads one whole frame from one chunk', () => {
    const p = new PimfParser();
    const frames = p.push(encodePimf(header(), jpeg(64)));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.header.seq).toBe(1);
    expect(frames[0]?.header.rect).toEqual({ x: 100, y: 60, w: 600, h: 400 });
    expect(frames[0]?.payload).toHaveLength(64);
    expect(p.pending).toBe(0);
  });

  it('reassembles a frame split across many arbitrary chunks', () => {
    const p = new PimfParser();
    const bytes = encodePimf(header({ seq: 42 }), jpeg(3000));
    let offset = 0;
    // Deliberately awkward cuts: mid-magic, mid-length, mid-header, mid-payload.
    const cuts = [2, 3, 7, 1, 40, 900, 1];
    for (const size of cuts) {
      const end = Math.min(bytes.length, offset + size);
      expect(p.push(bytes.subarray(offset, end))).toEqual([]);
      offset = end;
    }
    const frames = p.push(bytes.subarray(offset));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.header.seq).toBe(42);
    expect(frames[0]?.payload).toHaveLength(3000);
    expect(p.pending).toBe(0);
  });

  it('returns several frames when one chunk carries them all', () => {
    const p = new PimfParser();
    const bytes = Buffer.concat([
      encodePimf(header({ seq: 1 }), jpeg(10)),
      encodePimf(header({ seq: 2 }), jpeg(20)),
      encodePimf(header({ seq: 3 }), jpeg(30)),
    ]);
    const frames = p.push(bytes);
    expect(frames.map((f) => f.header.seq)).toEqual([1, 2, 3]);
    expect(frames.map((f) => f.payload.length)).toEqual([10, 20, 30]);
  });

  it('carries a partial trailing frame across pushes', () => {
    const p = new PimfParser();
    const a = encodePimf(header({ seq: 1 }), jpeg(10));
    const b = encodePimf(header({ seq: 2 }), jpeg(500));
    const first = p.push(Buffer.concat([a, b.subarray(0, 30)]));
    expect(first.map((f) => f.header.seq)).toEqual([1]);
    expect(p.pending).toBe(30);
    const second = p.push(b.subarray(30));
    expect(second.map((f) => f.header.seq)).toEqual([2]);
    expect(p.pending).toBe(0);
  });

  it('accepts the 0-byte payload "no window" frame (not a truncation)', () => {
    const p = new PimfParser();
    const frames = p.push(encodePimf(header({ seq: 9, windows: [], w: 0, h: 0 }), jpeg(0)));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toHaveLength(0);
    expect(frames[0]?.header.windows).toEqual([]);
    // …and the stream keeps going straight after it.
    const next = p.push(encodePimf(header({ seq: 10 }), jpeg(8)));
    expect(next.map((f) => f.header.seq)).toEqual([10]);
  });

  it('resyncs past junk on stdout instead of wedging', () => {
    const p = new PimfParser();
    const bytes = Buffer.concat([
      Buffer.from('pi-mac: warning, retrying capture\n', 'utf8'),
      encodePimf(header({ seq: 5 }), jpeg(16)),
    ]);
    const frames = p.push(bytes);
    expect(frames.map((f) => f.header.seq)).toEqual([5]);
  });

  it('drops a frame whose header is not JSON and keeps reading', () => {
    const p = new PimfParser();
    const good = encodePimf(header({ seq: 2 }), jpeg(4));
    // Hand-build a frame whose header bytes are not JSON.
    const badHeader = Buffer.from('{not json', 'utf8');
    const bad = Buffer.alloc(12 + badHeader.length + 4);
    bad.write('PIMF', 0, 'ascii');
    bad.writeUInt32BE(badHeader.length, 4);
    bad.writeUInt32BE(4, 8);
    badHeader.copy(bad, 12);
    const frames = p.push(Buffer.concat([bad, good]));
    expect(frames.map((f) => f.header.seq)).toEqual([2]);
    expect(p.dropped).toBe(1);
  });

  it('refuses an absurd declared length and recovers on the next magic', () => {
    const p = new PimfParser();
    const bogus = Buffer.alloc(12);
    bogus.write('PIMF', 0, 'ascii');
    bogus.writeUInt32BE(0xffffffff, 4);
    bogus.writeUInt32BE(0xffffffff, 8);
    const frames = p.push(Buffer.concat([bogus, encodePimf(header({ seq: 77 }), jpeg(5))]));
    expect(frames.map((f) => f.header.seq)).toEqual([77]);
  });

  it('does not hoard bytes that can never begin a frame', () => {
    const p = new PimfParser();
    expect(p.push(Buffer.from('xy', 'utf8'))).toEqual([]);
    expect(p.pending).toBe(0);
    // A genuine split magic IS held.
    expect(p.push(Buffer.from('PI', 'utf8'))).toEqual([]);
    expect(p.pending).toBe(2);
  });

  it('normalizes sparse window entries rather than trusting them', () => {
    const p = new PimfParser();
    const raw = {
      ...header({ seq: 3 }),
      windows: [{ windowId: 1 }, null, { title: 'Save', sheet: true, frame: { x: 5 } }],
    } as unknown as PimfHeader;
    const frames = p.push(encodePimf(raw, jpeg(2)));
    expect(frames[0]?.header.windows).toEqual([
      { windowId: 1, title: '', frame: { x: 0, y: 0, w: 0, h: 0 }, sheet: false, modal: false },
      { windowId: 0, title: 'Save', frame: { x: 5, y: 0, w: 0, h: 0 }, sheet: true, modal: false },
    ]);
  });

  it('copies payloads so a later push cannot mutate a delivered frame', () => {
    const p = new PimfParser();
    const bytes = encodePimf(header(), jpeg(32, 0x11));
    const frames = p.push(bytes);
    bytes.fill(0);
    expect(frames[0]?.payload.every((b) => b === 0x11)).toBe(true);
  });
});
