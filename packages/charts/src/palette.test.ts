import { describe, expect, it } from 'vitest';
import { paletteFromPixels } from './palette.ts';

/** A tiny picture: mostly white, with red and blue blocks and a green dot. */
function picture(): Uint8Array {
  const w = 40;
  const h = 40;
  const px = new Uint8Array(w * h * 4);
  const put = (x: number, y: number, r: number, g: number, b: number): void => {
    const i = (y * w + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x < 14 && y < 20) put(x, y, 220, 40, 40);
      else if (x >= 28 && y >= 20) put(x, y, 30, 80, 220);
      else if (x >= 18 && x < 22 && y >= 18 && y < 22) put(x, y, 40, 200, 90);
      else put(x, y, 250, 250, 250);
    }
  }
  return px;
}

describe('paletteFromPixels', () => {
  it('reads the picture’s colours, most present first, and its white ground', () => {
    const p = paletteFromPixels(picture(), 4);
    expect(p.palette[0]).toBe('#DC2828');
    expect(p.palette[1]).toBe('#1E50DC');
    expect(p.palette).toContain('#28C85A');
    expect(p.background).toBe('#FAFAFA');
    expect(p.accent).not.toBe(p.palette[0]);
  });

  it('a dark picture reports a dark ground; a grey picture still gives a palette', () => {
    const px = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 20;
      px[i + 1] = 22;
      px[i + 2] = 28;
      px[i + 3] = 255;
    }
    const p = paletteFromPixels(px, 4);
    expect(p.background).toBe('#14161C');
    expect(p.palette.length).toBeGreaterThan(0);
  });
});
