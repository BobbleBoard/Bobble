import { describe, expect, it } from 'vitest';
import { PERCEPTIBLE_MS, PREFILL_PILL_DELAY_MS, prefillPillDelay } from './use-prefill-pill';

describe('prefillPillDelay', () => {
  it('says so at once when the wait will be felt', () => {
    // The pill's ABSENCE is the promise ("nothing is pending"), so a prime the
    // measured rate says takes seconds cannot spend the first fraction of one
    // pretending nothing is happening — that is the window a send lands in.
    expect(prefillPillDelay(4000)).toBe(0);
    expect(prefillPillDelay(PERCEPTIBLE_MS)).toBe(0);
  });

  it('keeps the anti-flicker delay for a wait nobody could notice', () => {
    expect(prefillPillDelay(PERCEPTIBLE_MS - 1)).toBe(PREFILL_PILL_DELAY_MS);
    expect(prefillPillDelay(0)).toBe(PREFILL_PILL_DELAY_MS);
  });

  it('does not guess that an unmeasured prime is slow', () => {
    // Before this machine has timed a prefill there is no rate; assuming "slow"
    // would flash a pill on every keystroke.
    expect(prefillPillDelay(null)).toBe(PREFILL_PILL_DELAY_MS);
  });
});
