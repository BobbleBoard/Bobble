import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  flatten,
  isPurple,
  parseHex,
  relativeLuminance,
  toHex,
} from './contrast.ts';

describe('hex parsing', () => {
  it('reads the four hex forms', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#f008')).toEqual({ r: 255, g: 0, b: 0, a: 0x88 / 255 });
    expect(parseHex('#1d1d1f')).toEqual({ r: 29, g: 29, b: 31, a: 1 });
    expect(parseHex('#ffffff0a').a).toBeCloseTo(10 / 255, 6);
  });

  it('refuses anything that is not a hex colour, loudly', () => {
    for (const bad of ['red', 'rgb(1,2,3)', '#12345', '', '#gggggg']) {
      expect(() => parseHex(bad), bad).toThrow();
    }
  });

  it('round-trips through toHex', () => {
    expect(toHex(parseHex('#a3236b'))).toBe('#a3236b');
  });
});

describe('compositing', () => {
  it('paints a translucent wash over its ground', () => {
    // The app's dark code-block wash over the bobble base: measured #1e1e20.
    expect(flatten('#ffffff0a', '#151517')).toBe('#1e1e20');
    // An opaque colour is unchanged by the ground.
    expect(flatten('#ff0000', '#00ff00')).toBe('#ff0000');
  });
});

describe('WCAG contrast', () => {
  it('reproduces the reference ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#0000ff', '#ffffff')).toBeCloseTo(8.59, 2);
    expect(relativeLuminance(parseHex('#ffffff'))).toBeCloseTo(1, 6);
    expect(relativeLuminance(parseHex('#000000'))).toBe(0);
  });

  it('judges translucent text as what it paints, not as its raw value', () => {
    // 30% black over white is a light grey, nowhere near 21:1.
    const ratio = contrastRatio('#0000004d', '#ffffff');
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(3);
  });

  it('composites a translucent ground over the stated underlay', () => {
    const onBlack = contrastRatio('#ffffff', '#ffffff0a', '#000000');
    const onWhite = contrastRatio('#ffffff', '#ffffff0a', '#ffffff');
    expect(onBlack).toBeGreaterThan(15);
    expect(onWhite).toBeCloseTo(1, 5);
  });

  it('is the number behind the complaint: xterm red on the dark ground fails 4.5', () => {
    expect(contrastRatio('#cd3131', '#1e1e20')).toBeLessThan(4.5);
  });
});

describe('purple, as the product defines it', () => {
  it('classifies the hues it is meant to', () => {
    for (const violet of ['#8b2fa8', '#d69bff', '#7a3ba8', '#e0a6ff', '#6c5ce7', '#4338ca']) {
      expect(isPurple(violet), violet).toBe(true);
    }
    for (const ok of [
      '#a3236b',
      '#ff9ac8',
      '#4a6fa5',
      '#9fbcd8',
      '#1a52c4',
      '#0a6b3d',
      '#ff79c6',
    ]) {
      expect(isPurple(ok), ok).toBe(false);
    }
  });
});
