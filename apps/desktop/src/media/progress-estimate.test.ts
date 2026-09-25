import { describe, expect, it } from 'vitest';
import {
  finish,
  type ProgressEstimate,
  percentLabel,
  report,
  STEPS_END,
  shownAt,
  startEstimate,
  target,
} from './progress-estimate';

/** Drive the display at 60 fps from `from` to `to`, returning every value shown. */
function run(
  e: ProgressEstimate,
  from: number,
  to: number,
): { values: number[]; e: ProgressEstimate } {
  const values: number[] = [];
  let cur = e;
  for (let t = from; t <= to; t += 16) {
    const s = shownAt(cur, t);
    values.push(s.value);
    cur = s.next;
  }
  return { values, e: cur };
}

describe('progress estimate', () => {
  const STEP = 5000; // ms per step, like a 1024² picture on this Mac
  const TOTAL = 24;

  it('rises smoothly between reports and never goes backwards', () => {
    let e = startEstimate(0);
    let all: number[] = [];
    for (let s = 1; s <= 6; s += 1) {
      e = report(e, s / TOTAL, s * STEP);
      const r = run(e, s * STEP, (s + 1) * STEP - 16);
      all = all.concat(r.values);
      e = r.e;
    }
    for (let i = 1; i < all.length; i += 1)
      expect(all[i]).toBeGreaterThanOrEqual(all[i - 1] as number);
    // …and it is a slope, not a staircase: once the speed is known the display
    // moves during the wait rather than only when a report lands.
    const mid = all.slice(-200, -100);
    expect((mid[mid.length - 1] as number) - (mid[0] as number)).toBeGreaterThan(0.005);
  });

  it('never claims the next step before the engine reports it — even when that step is late', () => {
    let e = startEstimate(0);
    for (let s = 1; s <= 4; s += 1) e = report(e, s / TOTAL, s * STEP);
    // Step 5 is three times late: watch 15 s with no report.
    const r = run(e, 4 * STEP, 4 * STEP + 3 * STEP);
    const nextStepShown = (5 / TOTAL) * STEPS_END;
    for (const v of r.values) expect(v).toBeLessThan(nextStepShown);
    // Still moving, just slower: the last second rises less than the first.
    const first = (r.values[62] as number) - (r.values[0] as number);
    const last =
      (r.values[r.values.length - 1] as number) - (r.values[r.values.length - 63] as number);
    expect(last).toBeLessThan(first);
  });

  it('travels to a report that lands ahead of it instead of jumping', () => {
    let e = startEstimate(0);
    e = report(e, 1 / TOTAL, STEP);
    e = run(e, STEP, STEP + 100).e;
    e = report(e, 12 / TOTAL, STEP + 100); // a burst of steps arrives at once
    const before = e.shown;
    // One 60 fps frame later the display has started toward it, not arrived.
    const oneFrame = shownAt(e, e.shownAt + 16).value;
    expect(oneFrame - before).toBeLessThan(((12 - 1) / TOTAL) * STEPS_END * 0.15);
    const later = run(e, STEP + 116, STEP + 1200).values;
    expect(later[later.length - 1] as number).toBeGreaterThan((12 / TOTAL) * STEPS_END * 0.97);
  });

  it('keeps the finish for the result: the last step does not read 100', () => {
    let e = startEstimate(0);
    for (let s = 1; s <= TOTAL; s += 1) e = report(e, s / TOTAL, s * STEP);
    const r = run(e, TOTAL * STEP, TOTAL * STEP + 60_000);
    for (const v of r.values) expect(v).toBeLessThan(1);
    expect(r.values[r.values.length - 1] as number).toBeGreaterThan(STEPS_END);
    // The result arrives: 100 within half a second, without a jump in one frame.
    let done = finish(r.e, TOTAL * STEP + 60_000);
    const frames = run(done, TOTAL * STEP + 60_000, TOTAL * STEP + 60_600);
    expect(frames.values[frames.values.length - 1]).toBe(1);
    done = frames.e;
    expect(done.shown).toBe(1);
  });

  it('uses a past run only until this run has a speed of its own', () => {
    const fast = 1000 * TOTAL; // a prior claiming 1 s per step
    let e = startEstimate(0, fast);
    e = report(e, 1 / TOTAL, STEP);
    // With the prior, the first step already has a slope…
    expect(target(e, STEP + 500)).toBeGreaterThan((1 / TOTAL) * STEPS_END);
    // …and once two reports give this run's real speed (5 s), the prior is gone.
    e = report(e, 2 / TOTAL, 2 * STEP);
    const at = target(e, 2 * STEP + 1000);
    const measured = (2 / TOTAL) * STEPS_END + (1 / TOTAL) * STEPS_END * (1000 / STEP);
    expect(Math.abs(at - measured)).toBeLessThan(0.002);
  });

  it('prints a floored integer', () => {
    expect(percentLabel(0.4699)).toBe('46%');
    expect(percentLabel(1)).toBe('100%');
    expect(percentLabel(-1)).toBe('0%');
  });
});
