import { describe, expect, it } from 'vitest';
import { windowIdOfSource } from './window-capture';

describe('windowIdOfSource', () => {
  it('reads the CGWindowID out of a macOS window source id', () => {
    expect(windowIdOfSource('window:31712:0')).toBe(31712);
    expect(windowIdOfSource('window:7:1')).toBe(7);
  });

  it('refuses a screen source — a display is not a window', () => {
    expect(windowIdOfSource('screen:0:0')).toBeNull();
  });

  it('refuses anything it does not recognise rather than guessing', () => {
    // A future Chromium id shape must degrade to "no pixels", never to the
    // WRONG window: the id is what joins Chromium's pixels to the window
    // Accessibility told us about.
    for (const id of [
      'window:abc:0',
      'window:31712',
      'window:-1:0',
      'window:0:0',
      '',
      'window::0',
    ]) {
      expect(windowIdOfSource(id)).toBeNull();
    }
  });
});
