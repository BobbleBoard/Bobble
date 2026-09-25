/**
 * THE NUMBER ON A GENERATING CARD, BETWEEN THE ENGINE'S OWN UPDATES.
 *
 * the user (2026-09-24): "show a little bordered pill at the bottom right of the
 * image card that says n% and smoothly goes up (you can interpolate but never
 * outright lie, eg. can't create any 99% stuck situation or anything similar but
 * also don't be over honest and leave it on a % and then jump, interpolate
 * intelligently based on measuring speed as the generation goes on, ideally
 * don't lean on past runs for interpolation besides maybe at the very start of
 * a generation."
 *
 * An engine reports in steps: a picture's 24 denoise steps arrive ~5 s apart, so
 * the true fraction is a staircase — honest, and exactly the "sits on a % and
 * then jumps" he does not want. This turns the staircase into a slope without
 * inventing work:
 *
 * - SPEED IS MEASURED, per run. The time between reported fractions, smoothed,
 *   says how fast this run is going; the display advances at that rate between
 *   reports. Past runs are used for ONE thing — a first guess at that speed before
 *   this run has reported twice — and are dropped the moment it has.
 * - IT NEVER CLAIMS THE NEXT REPORT. Between reports the display may cover at
 *   most `lead` (0.9) of the gap it expects, and slows as it nears that, so a
 *   step that is late makes the number slow down rather than overtake the work.
 * - IT NEVER GOES BACKWARDS, and a report that arrives AHEAD of the display is
 *   caught up over a short ease rather than jumped to.
 * - THE LAST STRETCH IS NOT PART OF THE STEPS. After the final step the engine
 *   still decodes and saves; the steps map to 0…`stepsEnd` (94%) and the rest is
 *   earned by the finish, crept toward at the measured speed and never reached.
 *   A decode that runs long therefore slows the number down on its way to 99 —
 *   the one place a wait can sit, and only while it genuinely is still working —
 *   while a normal decode lands on 100 with the result.
 *
 * Pure: every function takes the clock as an argument, so the tests drive it.
 */

/** The share of the display the steps cover; the rest belongs to the finish. */
export const STEPS_END = 0.94;
/** The share of the gap to the next expected report the display may cover. */
const LEAD = 0.9;
/** How fast a lagging display catches up to a report ahead of it (ms). */
const CATCH_UP_MS = 450;
/** Weight of the newest interval in the running speed. */
const EMA = 0.35;

export interface ProgressEstimate {
  /** Reported fractions (0..1) with their times; kept to the last few. */
  readonly reports: readonly { readonly f: number; readonly t: number }[];
  /** Smoothed seconds-per-unit-fraction, from this run's own reports. */
  readonly msPerUnit: number | undefined;
  /** A first guess from past runs, used only until this run has a speed. */
  readonly priorMsPerUnit: number | undefined;
  /**
   * The smallest advance seen — the job's step. The NEXT report is expected one
   * step on, not one LAST-JUMP on: after a burst (several steps arriving at once,
   * as when a card comes back into view) sizing the gap by the jump let the
   * display run past the next step before it was reported (MEASURED: 76 on the
   * pill with step 7 worth 82 and only step 6 reported).
   */
  readonly minStep: number | undefined;
  /** What was last shown, and when — the display never goes below it. */
  readonly shown: number;
  readonly shownAt: number;
  /** When the result arrived, if it has. */
  readonly doneAt: number | undefined;
}

export function startEstimate(t: number, priorMsPerUnit?: number): ProgressEstimate {
  return {
    reports: [],
    msPerUnit: undefined,
    priorMsPerUnit,
    minStep: undefined,
    shown: 0,
    shownAt: t,
    doneAt: undefined,
  };
}

/**
 * The engine said `f` (0..1) at time `t`. Lower or repeated values are ignored.
 * `unit` is one step as a fraction (1 / total) when the engine counts steps —
 * the only way to know the next report's size when the first advance seen is a
 * burst (3/8 → 6/8 cannot tell a 3-step jump from a 3/8-sized step).
 */
export function report(e: ProgressEstimate, f: number, t: number, unit?: number): ProgressEstimate {
  const frac = Math.max(0, Math.min(1, f));
  const last = e.reports[e.reports.length - 1];
  if (last !== undefined && frac <= last.f) return e;
  let msPerUnit = e.msPerUnit;
  let minStep = unit !== undefined && unit > 0 ? unit : e.minStep;
  if (last !== undefined) {
    const delta = frac - last.f;
    if (unit === undefined) minStep = minStep === undefined ? delta : Math.min(minStep, delta);
    if (t > last.t) {
      const sample = (t - last.t) / delta;
      msPerUnit = msPerUnit === undefined ? sample : msPerUnit * (1 - EMA) + sample * EMA;
    }
  }
  return { ...e, reports: [...e.reports.slice(-7), { f: frac, t }], msPerUnit, minStep };
}

/** The result is here: the display finishes to 100 over a short ease. */
export function finish(e: ProgressEstimate, t: number): ProgressEstimate {
  return e.doneAt === undefined ? { ...e, doneAt: t } : e;
}

/** Map an engine fraction to display space: the steps end at STEPS_END. */
const toDisplay = (f: number): number => f * STEPS_END;

/**
 * Where the work honestly is at `t`, in display space (0..1), before smoothing:
 * the last report, plus the measured speed's worth of time since it — capped at
 * LEAD of the gap to the next report the speed predicts, approached with an
 * ease so the number decelerates into the cap instead of stopping against it.
 */
export function target(e: ProgressEstimate, t: number): number {
  if (e.doneAt !== undefined) return 1;
  const last = e.reports[e.reports.length - 1];
  if (last === undefined) return 0;
  const speed = e.msPerUnit ?? e.priorMsPerUnit;
  const base = toDisplay(last.f);
  if (speed === undefined || speed <= 0) return base;
  // The gap to the next report: one step (the smallest advance seen), or a
  // step's worth of the whole when there is only one report so far.
  const unitGap = e.minStep ?? Math.min(1 - last.f, 1 / 24);
  let gapDisplay: number;
  let gapMs: number;
  if (last.f >= 1) {
    // Past the last step: the finish, expected to take about two steps' time.
    gapDisplay = 1 - STEPS_END;
    gapMs = Math.max(1, speed * Math.max(unitGap, 1 / 24) * 2);
  } else {
    gapDisplay = toDisplay(Math.min(1, last.f + unitGap)) - base;
    gapMs = Math.max(1, speed * unitGap);
  }
  const x = Math.max(0, t - last.t) / gapMs; // 1 = when the next report is due
  // Linear to 70% of the lead, then an exponential approach to the lead itself.
  const knee = 0.7 * LEAD;
  const covered =
    x <= knee ? x : knee + (LEAD - knee) * (1 - Math.exp(-(x - knee) / (LEAD - knee)));
  return base + gapDisplay * Math.min(LEAD, covered);
}

/**
 * The number to show at `t` (0..1), and the new state. Monotone; a target that
 * jumps ahead is eased toward over CATCH_UP_MS rather than snapped to.
 */
export function shownAt(e: ProgressEstimate, t: number): { value: number; next: ProgressEstimate } {
  const goal = Math.max(e.shown, target(e, t));
  const dt = Math.max(0, t - e.shownAt);
  // Exponential ease toward the goal: fast enough to follow a slope, slow
  // enough that a report landing ahead of the display is travelled, not jumped.
  const k = 1 - Math.exp(-dt / (CATCH_UP_MS / 3));
  let value = e.shown + (goal - e.shown) * k;
  if (goal - value < 0.0005) value = goal;
  value = Math.max(e.shown, Math.min(1, value));
  return { value, next: { ...e, shown: value, shownAt: t } };
}

/** The integer a pill prints: floored, so it never claims more than it has. */
export function percentLabel(value: number): string {
  return `${Math.floor(Math.max(0, Math.min(1, value)) * 100)}%`;
}
