/**
 * The rule is small on purpose, and each exclusion is a bug the user reported.
 */
import { describe, expect, it } from 'vitest';
import { isNavigationKey, nextFocusRingMode } from './focus-ring';

describe('isNavigationKey', () => {
  it('counts the keys that MOVE focus', () => {
    for (const k of ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(isNavigationKey(k), k).toBe(true);
    }
  });

  it('counts Enter and Space — activating a control is keyboard use', () => {
    expect(isNavigationKey('Enter')).toBe(true);
    expect(isNavigationKey(' ')).toBe(true);
  });

  it('does NOT count Escape — dismissing something is not navigating to it', () => {
    // The reproduced bug: open a menu with the mouse, press Escape to get rid
    // of it, and Radix hands focus back to the trigger with a blue ring on it.
    expect(isNavigationKey('Escape')).toBe(false);
  });

  it('does NOT count typing', () => {
    for (const k of ['a', 'Z', '1', '/', 'Shift']) expect(isNavigationKey(k), k).toBe(false);
  });
});

describe('nextFocusRingMode', () => {
  it('turns the ring on for a navigation key', () => {
    expect(nextFocusRingMode({ type: 'keydown', key: 'Tab' })).toBe('on');
  });

  it('leaves the mode ALONE for Escape and for typing', () => {
    // Not 'off' — a keyboard user who presses Escape keeps their ring.
    expect(nextFocusRingMode({ type: 'keydown', key: 'Escape' })).toBeNull();
    expect(nextFocusRingMode({ type: 'keydown', key: 'x' })).toBeNull();
  });

  it('turns it off on any pointer press', () => {
    for (const t of ['pointerdown', 'mousedown', 'touchstart']) {
      expect(nextFocusRingMode({ type: t }), t).toBe('off');
    }
  });

  it('ignores window focus changes entirely', () => {
    /*
     * The second reproduction: Chromium restores focus AND focus-visible when a
     * window regains focus, lighting up the last thing touched. Not touching
     * the mode is what makes that correct for BOTH users — the mouse user was
     * 'off' and stays 'off', the keyboard user was 'on' and keeps their ring.
     */
    expect(nextFocusRingMode({ type: 'focus' })).toBeNull();
    expect(nextFocusRingMode({ type: 'blur' })).toBeNull();
    expect(nextFocusRingMode({ type: 'focusin' })).toBeNull();
  });
});
