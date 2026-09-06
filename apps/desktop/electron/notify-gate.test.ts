import { describe, expect, it } from 'vitest';
import { notifyDecision } from './notify-gate';

/**
 * The rules a probe could not reach, now reachable without a window.
 *
 * Each of these was previously only assertable by making the app frontmost —
 * which is what notify-probe was doing on every suite run, over whatever the
 * user happened to be reading.
 */
describe('notifyDecision', () => {
  it('never posts during a test run, whatever else is true', () => {
    expect(notifyDecision({ backgroundMode: true, windowFocused: false, supported: true })).toEqual(
      { shown: false, reason: 'suppressed: background test mode' },
    );
  });

  it('suppression beats the focus gate — a suite must not notify even when nobody is looking', () => {
    const d = notifyDecision({ backgroundMode: true, windowFocused: false, supported: false });
    expect(d.shown).toBe(false);
    expect(d.reason).toContain('background test mode');
  });

  it('does not interrupt someone already looking at the window', () => {
    expect(notifyDecision({ backgroundMode: false, windowFocused: true, supported: true })).toEqual(
      { shown: false, reason: 'the window is focused' },
    );
  });

  it('says so when the platform cannot post at all, rather than pretending', () => {
    expect(
      notifyDecision({ backgroundMode: false, windowFocused: false, supported: false }),
    ).toEqual({ shown: false, reason: 'notifications are unavailable here' });
  });

  it('notifies when the user is away, the app can, and it is not a test', () => {
    expect(
      notifyDecision({ backgroundMode: false, windowFocused: false, supported: true }),
    ).toEqual({ shown: true });
  });
});
