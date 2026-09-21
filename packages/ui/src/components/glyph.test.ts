import { describe, expect, it } from 'vitest';
import { fileLabel, LETTERS, layoutLabel, shiftPath } from './file-glyph.tsx';
import { GLYPHS } from './glyph.tsx';

/**
 * Every point a path visits (absolute M/L/H/V/C/A/Z), including the ones H and
 * V reach and an arc's end point — the control points of a C are included
 * too, since they bound the drawing.
 */
function points(d: string): [number, number][] {
  const out: [number, number][] = [];
  let cx = 0;
  let cy = 0;
  for (const m of d.matchAll(/([MLHVCAZ])([^MLHVCAZ]*)/g)) {
    const cmd = m[1] as string;
    const nums = (m[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter((t) => t.length > 0)
      .map(Number);
    if (cmd === 'Z') continue;
    if (cmd === 'H') {
      for (const x of nums) {
        cx = x;
        out.push([cx, cy]);
      }
    } else if (cmd === 'V') {
      for (const y of nums) {
        cy = y;
        out.push([cx, cy]);
      }
    } else if (cmd === 'A') {
      for (let i = 0; i + 6 < nums.length; i += 7) {
        cx = nums[i + 5] as number;
        cy = nums[i + 6] as number;
        out.push([cx, cy]);
      }
    } else {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cx = nums[i] as number;
        cy = nums[i + 1] as number;
        out.push([cx, cy]);
      }
    }
  }
  return out;
}

describe('the glyph set', () => {
  it('draws every glyph on the 24 grid — nothing outside it, nothing empty', () => {
    for (const [name, paths] of Object.entries(GLYPHS)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const p of paths) {
        for (const [x, y] of points(p.d)) {
          expect(x, `${name}: x ${x}`).toBeGreaterThanOrEqual(0);
          expect(x, `${name}: x ${x}`).toBeLessThanOrEqual(24);
          expect(y, `${name}: y ${y}`).toBeGreaterThanOrEqual(0);
          expect(y, `${name}: y ${y}`).toBeLessThanOrEqual(24);
        }
      }
    }
  });

  it('the calendar lost its two binding pins and sits centred (the user)', () => {
    const d = GLYPHS.scheduled.map((p) => p.d).join(' ');
    expect(d).not.toContain('M16 2V6');
    const ys = GLYPHS.scheduled.flatMap((p) => points(p.d).map(([, y]) => y));
    // Box from 3 to 21: the same margin above and below.
    expect(Math.min(...ys)).toBe(3);
    expect(Math.max(...ys)).toBe(21);
  });

  it('the arrow back into the thread is the canvas arrow turned 180° about the centre', () => {
    const fwd = points(GLYPHS.toCanvas[0]?.d ?? '');
    const back = points(GLYPHS.toInline[0]?.d ?? '');
    expect(back.length).toBe(fwd.length);
    for (let i = 0; i < fwd.length; i += 1) {
      const [x, y] = fwd[i] as [number, number];
      const [bx, by] = back[i] as [number, number];
      expect(bx).toBeCloseTo(24 - x, 3);
      expect(by).toBeCloseTo(24 - y, 3);
    }
  });
});

describe('the file glyph', () => {
  it('spells an extension in the letters the alphabet has, four at most', () => {
    expect(fileLabel('.wav')).toBe('WAV');
    expect(fileLabel('pptx')).toBe('PPTX');
    expect(fileLabel('sqlite')).toBe('SQLI');
    expect(fileLabel('mp4')).toBe('MP4');
    expect(fileLabel('')).toBe('');
    expect(fileLabel(undefined)).toBe('');
    // Every letter and digit is set.
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') expect(LETTERS[c], c).toBeDefined();
  });

  it('every letter sits on the baseline at 19 with its cap at 14, its left edge at 0', () => {
    for (const [c, letter] of Object.entries(LETTERS)) {
      const pts = points(letter.d);
      const xs = pts.map(([x]) => x);
      const ys = pts.map(([, y]) => y);
      expect(Math.min(...xs), `${c} left edge`).toBeCloseTo(0, 5);
      expect(Math.max(...xs), `${c} width`).toBeLessThanOrEqual(letter.w + 0.5);
      expect(Math.min(...ys), `${c} cap`).toBeGreaterThanOrEqual(14 - 0.01);
      expect(Math.max(...ys), `${c} baseline`).toBeLessThanOrEqual(19.25);
    }
  });

  it('lays a label out the way the drawn file icons are: right-aligned, the page stepping back for a wide one', () => {
    const xml = layoutLabel('XML');
    expect(xml.letters).toHaveLength(3);
    // XML ends at 21 and its page keeps its right edge at 19.
    const xmlRight = Math.max(...xml.letters.flatMap((d) => points(d).map(([x]) => x)));
    expect(xmlRight).toBeCloseTo(21, 3);
    expect(xml.page.startsWith('M19 11')).toBe(true);

    const wav = layoutLabel('WAV');
    const wavRight = Math.max(...wav.letters.flatMap((d) => points(d).map(([x]) => x)));
    const wavLeft = Math.min(...wav.letters.flatMap((d) => points(d).map(([x]) => x)));
    expect(wavRight).toBeCloseTo(22, 3);
    expect(wavLeft).toBeLessThanOrEqual(6.01);
    expect(wav.page.startsWith('M18 11')).toBe(true);

    // Four wide letters squeeze rather than run off the page.
    const wide = layoutLabel('WWWW');
    const xs = wide.letters.flatMap((d) => points(d).map(([x]) => x));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(4.4);
    expect(Math.max(...xs)).toBeLessThanOrEqual(22.01);

    expect(layoutLabel('')).toEqual({ letters: [], page: expect.stringMatching(/^M19 11/) });
  });

  it('shiftPath moves x only, and squeezes it when asked', () => {
    expect(shiftPath('M0 14V19H2', 7)).toBe('M7 14V19H9');
    expect(shiftPath('M0 14L4 19C4 19 2 17 0 14Z', 10, 0.5)).toBe(
      'M10 14L12 19C12 19 11 17 10 14Z',
    );
  });
});
