import { describe, expect, it } from 'vitest';
import {
  contentBox,
  figurePicture,
  OMNISVG_PICTURE_SIDE,
  omniSvgPicture,
  onWhite,
  type Pixels,
  resized,
  squared,
  withoutFlatBackground,
} from './omnisvg-picture';

/** A `w` × `h` picture of one RGBA colour. */
function flat(w: number, h: number, rgba: readonly number[]): Pixels {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
}
const pixel = (p: Pixels, x: number, y: number): number[] =>
  Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
/** One grey row, as PIL was handed it. */
function greys(values: readonly number[]): Pixels {
  const data = new Uint8Array(values.length * 4);
  for (const [i, v] of values.entries()) data.set([v, v, v, 255], i * 4);
  return { width: values.length, height: 1, data };
}

describe('a picture, as OmniSVG was trained to see it', () => {
  it('puts transparency on white — a clear pixel is white, not the black it hides', () => {
    const p: Pixels = {
      width: 3,
      height: 1,
      data: Uint8Array.from([0, 0, 0, 0, 255, 0, 0, 128, 10, 20, 30, 255]),
    };
    const out = onWhite(p);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 1, 0)).toEqual([255, 127, 127, 255]);
    expect(pixel(out, 2, 0)).toEqual([10, 20, 30, 255]);
  });

  it('whitens a flat background, and leaves a white-edged picture alone', () => {
    const navy = [20, 30, 90, 255];
    const p = flat(40, 40, navy);
    for (let y = 10; y < 20; y += 1)
      for (let x = 10; x < 20; x += 1) p.data.set([250, 200, 0, 255], (y * 40 + x) * 4);
    p.data.set([30, 40, 100, 255], (30 * 40 + 30) * 4); // near the navy: whitened too, as theirs does
    const out = withoutFlatBackground(p);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 30, 30)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 15, 15)).toEqual([250, 200, 0, 255]);
    const white = flat(40, 40, [250, 250, 250, 255]);
    expect(withoutFlatBackground(white)).toBe(white);
  });

  it('pads a wide picture to a square with white, the picture centred', () => {
    const out = squared(flat(20, 10, [0, 0, 0, 255]));
    expect([out.width, out.height]).toEqual([20, 20]);
    expect(pixel(out, 10, 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 10, 10)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 10, 17)).toEqual([255, 255, 255, 255]);
  });

  it('resamples as PIL’s Lanczos does, down and up (within one level)', () => {
    const row = greys([0, 32, 64, 96, 128, 160, 192, 224, 255, 255]);
    const near = (got: Pixels, want: number[]): void => {
      for (const [i, v] of want.entries()) {
        expect(Math.abs((got.data[i * 4] ?? 0) - v)).toBeLessThanOrEqual(1);
      }
    };
    // PIL 12: Image.resize((4, 1) / (16, 1), Image.Resampling.LANCZOS) on the same row.
    near(resized(row, 4, 1), [24, 101, 188, 251]);
    near(
      resized(row, 16, 1),
      [0, 10, 34, 56, 73, 94, 114, 133, 155, 174, 194, 214, 235, 254, 255, 254],
    );
  });

  it('makes every picture 448 × 448 on white — a transparent 1,000-px icon included', () => {
    const icon = flat(1000, 1000, [0, 0, 0, 0]);
    for (let y = 300; y < 700; y += 1)
      for (let x = 300; x < 700; x += 1) icon.data.set([220, 40, 40, 255], (y * 1000 + x) * 4);
    const out = omniSvgPicture(icon);
    expect([out.width, out.height]).toEqual([OMNISVG_PICTURE_SIDE, OMNISVG_PICTURE_SIDE]);
    expect(pixel(out, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 224, 224)).toEqual([220, 40, 40, 255]);
    const wide = omniSvgPicture(flat(520, 330, [255, 255, 255, 255]));
    expect([wide.width, wide.height]).toEqual([OMNISVG_PICTURE_SIDE, OMNISVG_PICTURE_SIDE]);
  });
});

describe('where a picture has ink', () => {
  it('is the box around everything darker than white', () => {
    const p = flat(100, 50, [255, 255, 255, 255]);
    for (let y = 10; y < 20; y += 1)
      for (let x = 30; x < 60; x += 1) p.data.set([200, 30, 30, 255], (y * 100 + x) * 4);
    expect(contentBox(p)).toEqual({ x0: 0.3, y0: 0.2, x1: 0.6, y1: 0.4 });
    expect(contentBox(flat(10, 10, [255, 255, 255, 255]))).toBeNull();
  });
});

describe('a figure, as VFIG is sent it', () => {
  it('is put on white and kept at its own proportions — shrunk only past 1,600 px', () => {
    const small = figurePicture(flat(520, 330, [0, 0, 0, 0]));
    expect([small.width, small.height]).toEqual([520, 330]);
    expect(pixel(small, 0, 0)).toEqual([255, 255, 255, 255]);
    const big = figurePicture(flat(3200, 1000, [10, 10, 10, 255]));
    expect([big.width, big.height]).toEqual([1600, 500]);
  });
});
