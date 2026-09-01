/**
 * the user's key map, written down as a test so it stays what he asked for:
 *
 *   "play button/pause for video l/r arrows skip 5 seconds directionally
 *    j and l 10s k and space pause for the videos"
 *
 * Pure, because the mapping is the part that can silently drift — the seeking
 * itself is one line of `currentTime` arithmetic that the e2e probe drives
 * against a real 40-second clip.
 */
import { describe, expect, it } from 'vitest';
import { seekForKey } from './VideoSurface';

describe('seekForKey', () => {
  it('skips 5 seconds directionally on the arrows', () => {
    expect(seekForKey('ArrowLeft')).toBe(-5);
    expect(seekForKey('ArrowRight')).toBe(5);
  });

  it('skips 10 seconds on J and L', () => {
    expect(seekForKey('j')).toBe(-10);
    expect(seekForKey('l')).toBe(10);
    // Caps too — a shortcut that stops working with caps lock on is a bug
    // report nobody can reproduce.
    expect(seekForKey('J')).toBe(-10);
    expect(seekForKey('L')).toBe(10);
  });

  it('toggles on K and Space', () => {
    expect(seekForKey('k')).toBe('toggle');
    expect(seekForKey('K')).toBe('toggle');
    expect(seekForKey(' ')).toBe('toggle');
    // Older engines report the spacebar this way; costs nothing to accept.
    expect(seekForKey('Spacebar')).toBe('toggle');
  });

  it('claims nothing else', () => {
    // The player must not swallow keys it does not own — Tab has to escape it,
    // Escape has to reach the expanded view, and typing must reach the composer.
    for (const key of ['Tab', 'Escape', 'a', 'Enter', 'ArrowUp', 'ArrowDown', 'm', '5']) {
      expect(seekForKey(key)).toBeNull();
    }
  });
});
