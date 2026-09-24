/**
 * The guardian probe's OS comparison (_os-free-window.mjs): the quoted figure
 * is held against what the OS said AROUND the reading, not one look after it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - plain ESM for probes, not typed app code.
import { quotedMatchesOs, startOsFreeTrace } from './_os-free-window.mjs';

const T = 1_790_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('quotedMatchesOs', () => {
  it('passes a reading that was right when taken, though the machine moved right after', () => {
    // SEEN 2026-09-23 beside another lane's image generation: the guardian
    // quoted 55%, and the one look taken after the window heard said 65%.
    const samples = [
      { at: T - 1800, pct: 61 },
      { at: T - 900, pct: 58 },
      { at: T - 200, pct: 55 },
      { at: T + 300, pct: 65 },
    ];
    const lastLook = samples.at(-1)?.pct ?? Number.NaN;
    expect(Math.abs(55 - lastLook)).toBeGreaterThan(5); // what the old check failed on
    expect(quotedMatchesOs(55, samples, T)).toEqual({ ok: true, n: 4, lo: 55, hi: 65 });
  });

  it("fails a figure the OS never said — the Mac's os.freemem() fiction on a calm machine", () => {
    const steady = Array.from({ length: 25 }, (_, i) => ({
      at: T - 2000 + i * 100,
      pct: i % 2 === 0 ? 60 : 61,
    }));
    expect(quotedMatchesOs(10, steady, T)).toEqual({ ok: false, n: 25, lo: 60, hi: 61 });
    // …and on that quiet machine the check is as tight as it always was.
    expect(quotedMatchesOs(66, steady, T).ok).toBe(true);
    expect(quotedMatchesOs(67, steady, T).ok).toBe(false);
    expect(quotedMatchesOs(55, steady, T).ok).toBe(true);
    expect(quotedMatchesOs(54, steady, T).ok).toBe(false);
  });

  it('counts only the looks around the reading', () => {
    const samples = [
      { at: T - 5000, pct: 12 }, // long before: not evidence for this reading
      { at: T - 100, pct: 60 },
      { at: T + 2000, pct: 11 }, // long after
    ];
    expect(quotedMatchesOs(10, samples, T)).toEqual({ ok: false, n: 1, lo: 60, hi: 60 });
  });

  it('says so when there was no look in the span at all', () => {
    expect(quotedMatchesOs(60, [], T)).toEqual({
      ok: false,
      n: 0,
      lo: undefined,
      hi: undefined,
    });
    expect(quotedMatchesOs(60, [{ at: T - 9000, pct: 60 }], T).n).toBe(0);
  });
});

describe('startOsFreeTrace', () => {
  it('looks at once, then at its cadence, keeps only real figures, and stops', () => {
    vi.useFakeTimers();
    let clock = T;
    const answers = [70, undefined, 68, Number.NaN, 66, 64, 62];
    let i = 0;
    const trace = startOsFreeTrace(() => answers[i++], { everyMs: 100, now: () => clock });
    expect(trace.samples).toEqual([{ at: T, pct: 70 }]);
    for (let k = 1; k <= 4; k += 1) {
      clock = T + k * 100;
      vi.advanceTimersByTime(100);
    }
    expect(trace.samples).toEqual([
      { at: T, pct: 70 },
      { at: T + 200, pct: 68 },
      { at: T + 400, pct: 66 },
    ]);
    trace.stop();
    vi.advanceTimersByTime(1000);
    expect(trace.samples).toHaveLength(3);
  });
});
