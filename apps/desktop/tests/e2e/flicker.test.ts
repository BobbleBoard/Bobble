/**
 * The flicker guard's pure half: a PNG decoder, the grey grid, and the
 * A → B → A detector — proved on pictures this test draws itself.
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, findFlickers, greyGrid, gridDiff } from './flicker.mjs';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An RGBA PNG painted by a function of (x, y), with a Paeth-filtered row for coverage. */
function paint(
  width: number,
  height: number,
  px: (x: number, y: number) => [number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(width * 4);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = px(x, y);
      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = 255;
    }
    // Filter type 2 (Up) on odd rows, None on even — the decoder must unfilter both.
    const filter = y % 2 === 1 ? 2 : 0;
    const filtered = Buffer.alloc(width * 4);
    for (let i = 0; i < row.length; i += 1) {
      filtered[i] = filter === 2 ? (row[i] - prev[i]) & 0xff : row[i];
    }
    rows.push(Buffer.concat([Buffer.from([filter]), filtered]));
    prev = row;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE: [number, number, number] = [250, 250, 250];
const DARK: [number, number, number] = [20, 20, 20];

describe('decodePng + greyGrid', () => {
  it('decodes filtered rows and reduces a picture to a grey grid', () => {
    const png = decodePng(paint(64, 32, (x) => (x < 32 ? WHITE : DARK)));
    expect(png.width).toBe(64);
    expect(png.channels).toBe(4);
    expect(png.data[0]).toBe(250);
    expect(png.data[(1 * 64 + 40) * 4]).toBe(20);
    const grid = greyGrid(png);
    expect(grid.cols).toBe(160);
    expect(grid.grid[0]).toBeGreaterThan(240);
    expect(grid.grid[grid.cols - 1]).toBeLessThan(30);
  });
});

describe('findFlickers', () => {
  const frame = (at: number, hole: boolean) => ({
    at,
    data: '',
    grid: greyGrid(
      decodePng(
        paint(160, 100, (x, y) => (hole && x > 40 && x < 100 && y > 20 && y < 60 ? DARK : WHITE)),
      ),
    ),
  });

  it('catches a card that vanishes for a frame and comes back, with its region', () => {
    const frames = [
      frame(0, false),
      frame(33, false),
      frame(66, true),
      frame(100, false),
      frame(133, false),
    ];
    const found = findFlickers(frames);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ before: 1, during: 2, after: 3, ms: 34 });
    expect(found[0]?.bbox).toMatchObject({ c0: 41, r0: 21 });
  });

  it('a change that stays is not a flicker; motion inside a view transition is not either', () => {
    const stays = [
      frame(0, false),
      frame(33, false),
      frame(66, true),
      frame(100, true),
      frame(133, true),
    ];
    expect(findFlickers(stays)).toHaveLength(0);
    const flick = [
      frame(0, false),
      frame(33, false),
      frame(66, true),
      frame(100, false),
      frame(133, false),
    ];
    expect(findFlickers(flick, [{ start: 50, end: 120 }])).toHaveLength(0);
  });

  it('gridDiff counts changed cells and returns none for identical frames', () => {
    const a = frame(0, false).grid;
    expect(gridDiff(a, a).count).toBe(0);
    expect(gridDiff(a, frame(0, true).grid).count).toBeGreaterThan(100);
  });
});

describe('png.mjs crop', () => {
  it('cuts a region out and encodes it back as a PNG the decoder reads', async () => {
    const { cropPng } = await import('./png.mjs');
    const src = paint(64, 32, (x) => (x < 32 ? WHITE : DARK));
    const cut = cropPng(src, { x: 32, y: 0, width: 32, height: 32 });
    const png = decodePng(cut);
    expect(png.width).toBe(32);
    expect(png.height).toBe(32);
    expect(png.data[0]).toBe(20);
    expect(png.data[(31 * 32 + 31) * 4]).toBe(20);
  });
});
