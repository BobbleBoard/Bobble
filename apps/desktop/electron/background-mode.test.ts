/**
 * When must a run be invisible?
 *
 * The rule that matters: ANY test run, not just one that remembered a flag.
 * 172 probes set `PI_E2E=1` and each was independently forgetting the separate
 * background flag, which is how a suite ends up putting a window over someone's
 * work sixteen times in a row.
 */
import { describe, expect, it } from 'vitest';
import { isBackgroundMode, isHiddenMode } from './background-mode';

describe('isBackgroundMode', () => {
  it('is on for any test run', () => {
    expect(isBackgroundMode({ PI_E2E: '1' })).toBe(true);
  });

  it('is on for an explicit opt-in outside the suite', () => {
    expect(isBackgroundMode({ PI_E2E_BACKGROUND: '1' })).toBe(true);
  });

  it('is off for an ordinary launch — the user is meant to see their app', () => {
    expect(isBackgroundMode({})).toBe(false);
    expect(isBackgroundMode({ PI_E2E: '0' })).toBe(false);
  });

  it('PI_E2E_VISIBLE wins over everything — that is how you watch a run', () => {
    expect(isBackgroundMode({ PI_E2E: '1', PI_E2E_VISIBLE: '1' })).toBe(false);
    expect(isBackgroundMode({ PI_E2E_BACKGROUND: '1', PI_E2E_VISIBLE: '1' })).toBe(false);
  });
});

describe('isHiddenMode', () => {
  it('tracks background mode — an unnoticeable run shows no window', () => {
    // A window that appears without focus is still a window that appeared.
    expect(isHiddenMode({ PI_E2E: '1' })).toBe(true);
    expect(isHiddenMode({ PI_E2E: '1', PI_E2E_VISIBLE: '1' })).toBe(false);
    expect(isHiddenMode({})).toBe(false);
  });
});
