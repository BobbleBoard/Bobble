import { describe, expect, it } from 'vitest';
import { type Cell, composeGrid, regionIsBlank, sheetColumns } from './office-grid';

/** A cell of one colour (BGRA). */
const solid = (width: number, height: number, [r, g, b]: [number, number, number]): Cell => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([b, g, r, 255], i * 4);
  return { data, width, height };
};

const at = (c: Cell, x: number, y: number): number[] => {
  const i = (y * c.width + x) * 4;
  return [c.data[i + 2] ?? -1, c.data[i + 1] ?? -1, c.data[i] ?? -1];
};

describe('a contact sheet of slides', () => {
  it('lays the slides out in reading order on a ground, each in a slot', () => {
    const sheet = composeGrid(
      [solid(4, 2, [255, 0, 0]), solid(4, 2, [0, 255, 0]), solid(4, 2, [0, 0, 255])],
      { cols: 2, gap: 1, background: [9, 9, 9] },
    );
    // Two columns of 4 and three gaps; two rows of 2 and three gaps.
    expect([sheet.width, sheet.height]).toEqual([11, 7]);
    expect(at(sheet, 0, 0)).toEqual([9, 9, 9]);
    expect(at(sheet, 1, 1)).toEqual([255, 0, 0]); // first, top left
    expect(at(sheet, 6, 1)).toEqual([0, 255, 0]); // second, top right
    expect(at(sheet, 1, 4)).toEqual([0, 0, 255]); // third, next row
    expect(at(sheet, 6, 4)).toEqual([9, 9, 9]); // the empty slot is ground
  });

  it('centres a smaller picture in its slot', () => {
    const sheet = composeGrid([solid(4, 4, [255, 255, 255]), solid(2, 2, [255, 0, 0])], {
      cols: 2,
      gap: 0,
      background: [0, 0, 0],
    });
    expect([sheet.width, sheet.height]).toEqual([8, 4]);
    expect(at(sheet, 4, 0)).toEqual([0, 0, 0]);
    expect(at(sheet, 5, 1)).toEqual([255, 0, 0]);
  });

  it('two columns up to four slides, then three', () => {
    expect([1, 2, 4, 5, 8, 12].map(sheetColumns)).toEqual([1, 2, 2, 3, 3, 3]);
  });
});

describe('a picture that drew nothing', () => {
  it('is a region with no mark darker than the white cell, at the capture’s scale', () => {
    const white = solid(8, 8, [255, 255, 255]);
    expect(regionIsBlank(white, { x: 0, y: 0, width: 4, height: 4 }, 2)).toBe(true);
    // One dark pixel inside the box (page 3,3 → capture 6,6 at 2×).
    white.data.set([20, 20, 20, 255], (6 * 8 + 6) * 4);
    expect(regionIsBlank(white, { x: 0, y: 0, width: 4, height: 4 }, 2)).toBe(false);
    // …and outside a smaller box it does not count.
    expect(regionIsBlank(white, { x: 0, y: 0, width: 2, height: 2 }, 2)).toBe(true);
  });
});
