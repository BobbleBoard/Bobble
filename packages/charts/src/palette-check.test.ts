import { describe, expect, it } from 'vitest';
import {
  checkPalette,
  contrastRatio,
  cyclicPairs,
  deltaE,
  fromOklch,
  judgePairs,
  lookPairs,
  measurePair,
  normalizeHex,
  oklch,
  PALETTE_GATES,
} from './palette-check.ts';

/*
 * The numbers below are the data-viz method's own validator
 * (validate_palette.js) on the same colours — the research ran the looks
 * through it, and these checks must agree with it to the reported decimal.
 */
describe('the palette maths agree with the reference validator', () => {
  it('reproduces the research’s worst pairs to one decimal', () => {
    // clean (before VQ-03): lime beside gold — "ΔE 2.0 (protan) · tritan 11.3", normal 8.7.
    const lime = measurePair('#9AC05F', '#D9B44A');
    expect(lime.protan.toFixed(1)).toBe('2.0');
    expect(lime.tritan.toFixed(1)).toBe('11.3');
    expect(lime.normal.toFixed(1)).toBe('8.7');
    // editorial (before): olive beside brick — "ΔE 3.8 (deutan) · tritan 21.5", normal 22.1.
    const olive = measurePair('#6B8E23', '#C0504D');
    expect(olive.deutan.toFixed(1)).toBe('3.8');
    expect(olive.cvd.toFixed(1)).toBe('3.8');
    expect(olive.tritan.toFixed(1)).toBe('21.5');
    expect(olive.normal.toFixed(1)).toBe('22.1');
  });

  it('reproduces the method’s reference palette: adjacent CVD 9.1, normal 19.6', () => {
    const ref = [
      '#2a78d6',
      '#eb6834',
      '#1baf7a',
      '#eda100',
      '#e87ba4',
      '#008300',
      '#4a3aa7',
      '#e34948',
    ];
    const adjacent = ref.slice(0, -1).map((a, i) => measurePair(a, ref[i + 1] as string));
    const v = judgePairs(adjacent);
    expect(v.worstCvd?.cvd.toFixed(1)).toBe('9.1');
    expect(v.worstNormal?.normal.toFixed(1)).toBe('19.6');
    expect(v.cvd).toBe('pass');
    expect(v.normal).toBe(true);
  });

  it('WCAG contrast: white on black is 21, a colour on itself is 1', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#2F6FE4', '#2F6FE4')).toBeCloseTo(1, 6);
    expect(contrastRatio('#2F6FE4', '#FFFFFF')).toBeCloseTo(4.6512, 3);
  });

  it('ΔE is zero for a colour and itself, and symmetric', () => {
    expect(deltaE('#123456', '#123456')).toBe(0);
    expect(deltaE('#123456', '#654321', 'deutan')).toBeCloseTo(
      deltaE('#654321', '#123456', 'deutan'),
      9,
    );
  });
});

describe('inputs', () => {
  it('normalises #abc / aabbcc / #AaBbCc and refuses anything else (never NaN)', () => {
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(normalizeHex('aabbcc')).toBe('#AABBCC');
    expect(normalizeHex(' #AaBbCc ')).toBe('#AABBCC');
    expect(() => normalizeHex('teal')).toThrow(/not a hex colour/);
  });

  it('fromOklch round-trips an in-gamut colour and pulls an impossible one into gamut by chroma', () => {
    const { l, c, h } = oklch('#2F6FE4');
    expect(fromOklch(l, c, h)).toBe('#2F6FE4');
    const wild = fromOklch(0.6, 0.5, 30); // far outside sRGB
    const back = oklch(wild);
    expect(back.l).toBeCloseTo(0.6, 2);
    expect(Math.abs(back.h - 30)).toBeLessThan(3);
    expect(back.c).toBeLessThan(0.5);
  });
});

describe('neighbours', () => {
  it('are cyclic: the last colour meets the first (series wrap, a donut closes)', () => {
    expect(cyclicPairs(['a', 'b', 'c']).map(([x, y]) => `${x}${y}`)).toEqual(['ab', 'bc', 'ca']);
    expect(cyclicPairs(['a', 'b']).map(([x, y]) => `${x}${y}`)).toEqual(['ab']);
    expect(cyclicPairs(['a'])).toEqual([]);
  });

  it('a look is also measured where its accent meets its colours', () => {
    const pal = ['#2F6FE4', '#DD6A1A', '#007A6C', '#0095D0', '#A8325C', '#7B8598'];
    const pairs = lookPairs(pal, '#DD6A1A');
    const where = pairs.map((p) => p.where);
    expect(where).toContain('highlight ↔ series 1');
    // The accent is series 2 here: a donut with a highlight draws the rest
    // without it, so series 1 meets series 3.
    expect(where).toContain('donut with a highlight: series 1 ↔ 3');
    expect(where.filter((w) => w.startsWith('highlight ↔')).length).toBe(5);
  });

  it('an accent that IS the first colour fails at ΔE 0 — the highlight nobody could see', () => {
    const pairs = lookPairs(['#FF5C8A', '#FFB84C', '#4CD4B0'], '#FF5C8A');
    const first = pairs.find((p) => p.where === 'highlight ↔ series 1');
    expect(first?.normal).toBe(0);
    expect(judgePairs(pairs).cvd).toBe('fail');
  });
});

describe('checkPalette', () => {
  it('passes a palette that clears every gate and fails one that does not', () => {
    const good = checkPalette(
      ['#2F6FE4', '#DD6A1A', '#007A6C', '#0095D0', '#A8325C', '#7B8598'],
      '#FFFFFF',
    );
    expect(good.ok).toBe(true);
    // The same colours in another order: teal beside wine is one grey to a
    // deuteranope (ΔE 3.1) — the order is part of the palette.
    const reordered = checkPalette(['#2F6FE4', '#DD6A1A', '#007A6C', '#A8325C'], '#FFFFFF');
    expect(reordered.ok).toBe(false);
    expect(reordered.worstCvd?.where).toBe('series 3 ↔ 4');
    const pastel = checkPalette(['#7FB3F5', '#F5B48A', '#8FD3C9', '#F2D98A'], '#FFFFFF');
    expect(pastel.ok).toBe(false);
    expect(pastel.lowContrast.length).toBe(4);
  });

  it('the 6–8 colour-blind band passes only with direct labels', () => {
    // bold's palette: teal beside magenta sits at 7.2 for a deuteranope.
    const floor = ['#1F5EFF', '#009D90', '#C2187A', '#0894D9', '#F2541B', '#007C5C'];
    const report = checkPalette(floor, '#FFFFFF');
    expect(report.cvd).toBe('floor');
    expect(report.ok).toBe(false);
    expect(checkPalette(floor, '#FFFFFF', { directLabels: true }).ok).toBe(true);
    expect(PALETTE_GATES).toEqual({ cvdTarget: 8, cvdFloor: 6, normalFloor: 15, markContrast: 3 });
  });
});
