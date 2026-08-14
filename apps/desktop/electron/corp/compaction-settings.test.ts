import { describe, expect, it } from 'vitest';
import {
  type CompactionSettings,
  compactionDeadBand,
  compactionSettingsFor,
  PI_DEFAULT_COMPACTION,
} from './compaction-settings.js';

/** The window the app reports for qwen3.5-4b-mtp, which is what roles actually run on. */
const LOCAL = 32768;

describe('the defect this module exists for', () => {
  /*
   * MEASURED against pi's own shouldCompact/findCutPoint: on a 32,768 window
   * pi's defaults first fire at ~16,800 tokens and do not free a single token
   * until ~20,800. This asserts the arithmetic that produces that gap, so the
   * regression can never come back silently.
   */
  it("pi's defaults leave a 4k dead band on our window", () => {
    expect(compactionDeadBand(LOCAL, PI_DEFAULT_COMPACTION)).toBe(20000 - (32768 - 16384));
    expect(compactionDeadBand(LOCAL, PI_DEFAULT_COMPACTION)).toBe(3616);
  });

  it('...and are perfectly fine on the cloud window they were written for', () => {
    expect(compactionDeadBand(200_000, PI_DEFAULT_COMPACTION)).toBe(0);
  });

  /*
   * WORSE STILL AT 16384, which is what DEFAULT_CONTEXT_WINDOW was before roles
   * started being handed the server's real window. reserve == window, so
   * `shouldCompact` fires above ZERO tokens: every role ran a summarization on
   * every eligible turn from its very first message, and could never reach the
   * 20000 keep budget to free anything. The whole window is dead band.
   */
  it('fire from the FIRST TURN on a 16384 window, and can never free anything', () => {
    expect(16384 - PI_DEFAULT_COMPACTION.reserveTokens).toBe(0);
    expect(compactionDeadBand(16384, PI_DEFAULT_COMPACTION)).toBe(20000);
  });
});

describe('compactionSettingsFor', () => {
  /* THE INVARIANT. Everything else here is a consequence of it. */
  it('leaves no dead band at any window we could plausibly run', () => {
    for (const w of [4096, 8192, 16384, 32768, 65536, 131072, 200000]) {
      expect(compactionDeadBand(w, compactionSettingsFor(w))).toBe(0);
    }
  });

  it('keeps recent strictly below the trigger, which is what kills the dead band', () => {
    for (const w of [4096, 8192, 16384, 32768, 131072]) {
      const s = compactionSettingsFor(w);
      expect(s.keepRecentTokens).toBeLessThan(w - s.reserveTokens);
    }
  });

  it('frees roughly as much as it keeps when it does fire', () => {
    const s = compactionSettingsFor(LOCAL);
    const atCeiling = LOCAL - s.reserveTokens;
    const freed = atCeiling - s.keepRecentTokens;
    expect(freed).toBeGreaterThan(s.keepRecentTokens * 0.9);
  });

  /*
   * A reserve that is half the window is the original sin — it must not recur.
   * 4096 is excluded deliberately: there the 2048 FLOOR wins, which is half the
   * window on purpose, because a window that small still has to fit one answer.
   */
  it('never reserves more than a quarter of any window we actually run', () => {
    for (const w of [8192, 16384, 32768, 131072]) {
      expect(compactionSettingsFor(w).reserveTokens).toBeLessThanOrEqual(w / 4);
    }
  });

  it('still leaves room to answer on a small window', () => {
    expect(compactionSettingsFor(4096).reserveTokens).toBeGreaterThanOrEqual(2048);
  });

  it('does not reserve absurdly on a huge window', () => {
    expect(compactionSettingsFor(1_000_000).reserveTokens).toBe(16384);
  });

  /* A bad window must not produce bad settings — this runs on whatever the
     inference layer reports, including nothing. */
  it('survives a nonsense window', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s: CompactionSettings = compactionSettingsFor(bad);
      expect(s.reserveTokens).toBeGreaterThan(0);
      expect(s.keepRecentTokens).toBeGreaterThan(0);
      expect(compactionDeadBand(8192, s)).toBe(0);
    }
  });

  it('is on', () => {
    expect(compactionSettingsFor(LOCAL).enabled).toBe(true);
  });
});
