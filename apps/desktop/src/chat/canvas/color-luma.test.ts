import { describe, expect, it } from 'vitest';
import { isDarkColor, parseCssColor } from './color-luma';

describe('isDarkColor', () => {
  /* The bug: "#f5f5f7" scraped to 5,5,7 and themed the office editors dark
   * inside a light app. */
  it('reads a light hex as light and a dark hex as dark', () => {
    expect(isDarkColor('#f5f5f7')).toBe(false);
    expect(isDarkColor('#fff')).toBe(false);
    expect(isDarkColor('#151517')).toBe(true);
    expect(isDarkColor('#1e1e21')).toBe(true);
  });
  it('handles rgb(), rgba() and color(srgb …)', () => {
    expect(isDarkColor('rgb(245, 245, 247)')).toBe(false);
    expect(isDarkColor('rgba(21, 21, 23, 0.9)')).toBe(true);
    expect(isDarkColor('color(srgb 0.96 0.96 0.97)')).toBe(false);
    expect(isDarkColor('color(srgb 0.08 0.08 0.09 / 1)')).toBe(true);
  });
  it('treats an unparseable colour as light, the default theme', () => {
    expect(isDarkColor('var(--nope)')).toBe(false);
    expect(parseCssColor('oklch(0.2 0 0)')).toBeNull();
  });
});
