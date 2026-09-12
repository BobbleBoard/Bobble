/**
 * THE MACHINE COMES FIRST — the part of the power policy that acts.
 *
 * the user, after his Mac locked up under a generation: "computer just became
 * unusably laggy eg. trackpad unresponsive to clicks and movement, screen
 * totally frozen, needs monitoring for cpu and mem pressure to ensure extremes
 * like this absolutely never happen and low power mode certainly needs good
 * implementation for these."
 *
 * ## What the existing policy could not do
 * power-policy.ts decides how hard the NEXT launch may push, and says so in its
 * header: "NOTHING HERE TOUCHES A RUNNING TURN." That is the right rule for a
 * chat model — reloading it mid-sentence is the stall the policy exists to
 * prevent — and the wrong rule for a 12 GB image job, which is the thing that
 * takes the machine down. The manager also samples every 15 seconds, and on a
 * 24 GB Mac with a 1 GB swap file a thrash builds in two: by the time the next
 * reading arrived the pointer had already stopped moving. (Two jetsam reports
 * from earlier the same day name a 6 GB python worker as the largest process.)
 *
 * So this module does the two things that one does not:
 *
 *   HOLD  no new heavy work while the machine is already tight, and no heavy job
 *         whose measured footprint does not fit in what the OS says is free —
 *         `fits` — with the reserve intact. A job is held, not refused.
 *   SHED  a heavy job that is running while the machine crosses the line is
 *         cancelled. A lost generation costs a retry; a frozen machine costs the
 *         user everything they had open. The OS would kill something anyway
 *         (jetsam) — this simply chooses the right victim, sooner.
 *
 * ## The limits do not bend to 'full'
 * The user's power mode says how much of the machine to USE. It does not say
 * "and freeze it": 'full' still sheds at the wall, 'low' just keeps further
 * from it. A mode that could take the computer down is not a mode, it is a bug
 * with a setting.
 *
 * ## The stall signal
 * The truest "this machine is thrashing" signal is not a counter — it is that
 * the app's own main thread cannot get scheduled. A timer that should fire every
 * quarter-second and fires two seconds late is the pointer freezing, measured
 * from the inside. It is used only to CORROBORATE tight memory (a stall alone
 * can be a long synchronous call), which is why it is a pair of thresholds.
 *
 * Pure: readings in, a verdict and a reason out. The loop that samples and the
 * process that cancels are elsewhere and thin.
 */
import type { PowerMode } from './power-policy.js';
import type { SystemPressure } from './pressure.js';

export type GuardianVerdict = 'calm' | 'hold' | 'shed';

/** What the guardian judges: the pressure reading plus what only the host process knows. */
export interface GuardianReading extends SystemPressure {
  /** How late the host's own timer fired — the main thread's starvation, in ms. */
  readonly stallMs?: number;
}

export interface GuardianLimits {
  /** Below this fraction free (the OS's own number), nothing heavy starts. */
  readonly holdFree: number;
  /** Below this, running heavy work is cancelled. */
  readonly shedFree: number;
  /** A main-thread stall at least this long, with memory already under
   * `holdFree`, counts as thrashing. */
  readonly stallMs: number;
  /** Swap traffic that means the machine is thrashing (pages/sec). */
  readonly thrashingPagesPerSec: number;
  /** Consecutive calm readings before a hold is lifted. */
  readonly recoveryReadings: number;
}

/*
 * THE LINES, AND WHERE THEY COME FROM.
 *
 * `kern.memorystatus_level` is the percentage macOS's own jetsam steers by. On
 * the day of the freeze the two jetsam reports fired with free at roughly 8-10%
 * — so 8% is where the OS itself starts killing, and shedding there is choosing
 * the victim, not being cautious. 20% for hold is the point the earlier policy
 * already called "pressure building". Low mode keeps a wider margin on both,
 * because "low power" means "I am using this computer for something else".
 *
 * The thrashing rate is power-policy's own calibrated line (see
 * THRASHING_PAGES_PER_SEC there: real thrash MEASURED at 8,800-63,000 pages/s,
 * idle at 0-71).
 */
export function limitsFor(mode: PowerMode): GuardianLimits {
  const low = mode === 'low';
  return {
    holdFree: low ? 0.3 : 0.2,
    shedFree: low ? 0.15 : 0.08,
    stallMs: 1500,
    thrashingPagesPerSec: 2000,
    recoveryReadings: 4,
  };
}

export interface GuardianJudgement {
  readonly verdict: GuardianVerdict;
  /** One line, for the log and for the person whose job was stopped. */
  readonly reason: string;
}

/** The verdict a single reading argues for, before any hysteresis. */
export function judge(reading: GuardianReading, limits: GuardianLimits): GuardianJudgement {
  const free = reading.memoryFree;
  const pct = free === undefined ? undefined : Math.round(free * 100);

  // The OS's own verdict outranks everything we could infer.
  if (reading.memory === 'critical') {
    return { verdict: 'shed', reason: 'the system reports critical memory pressure' };
  }
  if (free !== undefined && free <= limits.shedFree) {
    return { verdict: 'shed', reason: `only ${pct}% of memory is free` };
  }
  if ((reading.swapIoPerSec ?? 0) >= limits.thrashingPagesPerSec) {
    return {
      verdict: 'shed',
      reason: `the machine is swapping hard (${Math.round(reading.swapIoPerSec ?? 0)} pages/s)`,
    };
  }
  /*
   * STALL + TIGHT = THRASH. Neither alone is: a stall can be one long synchronous
   * call in the host, and tight memory with a responsive main thread is exactly
   * the state a big model is supposed to run in. Together they are the pointer
   * freezing.
   */
  if ((reading.stallMs ?? 0) >= limits.stallMs && free !== undefined && free <= limits.holdFree) {
    return {
      verdict: 'shed',
      reason: `the app stalled for ${Math.round((reading.stallMs ?? 0) / 100) / 10}s with ${pct}% of memory free`,
    };
  }
  if (reading.memory === 'warn') {
    return { verdict: 'hold', reason: 'the system reports memory pressure' };
  }
  if (free !== undefined && free <= limits.holdFree) {
    return { verdict: 'hold', reason: `${pct}% of memory is free` };
  }
  return { verdict: 'calm', reason: free === undefined ? 'no reading' : `${pct}% of memory free` };
}

/**
 * Hysteresis, the same asymmetry power-policy uses: a bad reading acts at once,
 * and a hold lifts only after `recoveryReadings` calm ones — because readings
 * are noisy and a gate that flaps starts a job into the next dip.
 *
 * `shed` is not sticky: once the heavy work is gone the reading will change,
 * and what remains is a hold that recovers on its own clock.
 */
export function settle(
  next: GuardianJudgement,
  previous: GuardianVerdict,
  calmStreak: number,
  limits: GuardianLimits,
): { verdict: GuardianVerdict; calmStreak: number; reason: string } {
  if (next.verdict === 'shed') return { verdict: 'shed', calmStreak: 0, reason: next.reason };
  if (next.verdict === 'hold') return { verdict: 'hold', calmStreak: 0, reason: next.reason };
  // calm
  if (previous === 'calm') return { verdict: 'calm', calmStreak: 0, reason: next.reason };
  const streak = calmStreak + 1;
  if (streak >= limits.recoveryReadings)
    return { verdict: 'calm', calmStreak: 0, reason: next.reason };
  return {
    verdict: 'hold',
    calmStreak: streak,
    reason: `${next.reason}; waiting for it to stay that way (${streak}/${limits.recoveryReadings})`,
  };
}

export interface FitInput {
  /** Peak resident size of the job's model, GB — the catalog's measured number. */
  readonly footprintGB: number;
  /** Physical memory, GB. */
  readonly totalGB: number;
  /** The OS's own free fraction, 0..1 (`memoryFree`). Undefined ⇒ unknown. */
  readonly freeFraction: number | undefined;
  /** GB the app promises never to take. */
  readonly reserveGB: number;
}

/**
 * The working set beyond the weights — activations, the encoder's scratch, the
 * decoded frames. MEASURED loosely: a 5.2 GB Wan run peaks near 6 GB; TRELLIS at
 * 512 sits a couple of GB over its checkpoints. Fifteen percent plus a gigabyte
 * covers the ones that were watched without pretending to know the ones that
 * were not.
 */
export const HEADROOM_FACTOR = 1.15;
export const HEADROOM_GB = 1;

/**
 * Would a job of this size fit RIGHT NOW, with the reserve intact?
 *
 * "Free" here is the OS's own accounting (what jetsam steers by), which on macOS
 * counts reclaimable file cache — so a resident chat model whose weights are
 * mmap'd shows as mostly reclaimable and does not block a job that would fit
 * beside it. Its KV cache is anonymous and does count, as it should.
 */
export function fits(input: FitInput): { ok: boolean; reason: string } {
  if (input.freeFraction === undefined) {
    return { ok: true, reason: 'memory not measured; not holding the job on a guess' };
  }
  const availableGB = input.totalGB * input.freeFraction;
  const needGB = input.footprintGB * HEADROOM_FACTOR + HEADROOM_GB;
  const leftGB = availableGB - needGB;
  const r = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
  if (leftGB >= input.reserveGB) {
    return {
      ok: true,
      reason: `${r(needGB)} GB needed, ${r(availableGB)} GB available, ${r(leftGB)} GB left over`,
    };
  }
  return {
    ok: false,
    reason: `needs about ${r(needGB)} GB and only ${r(availableGB)} GB is available (keeping ${input.reserveGB} GB for you)`,
  };
}

// ─── the loop ────────────────────────────────────────────────────────────────

/** How often to look while heavy work is running. A thrash builds in seconds. */
export const BUSY_INTERVAL_MS = 1000;
/** …and while nothing heavy is happening. Same as the power manager's own pace. */
export const IDLE_INTERVAL_MS = 15_000;
/** The cadence of the stall detector's own heartbeat. */
export const HEARTBEAT_MS = 250;

export interface GuardianOptions {
  /** Read the machine. Any fields the host cannot answer stay undefined. */
  readonly sample: () => Promise<SystemPressure>;
  /** Is heavy work running right now? Decides the sampling pace. */
  readonly busy: () => boolean;
  readonly limits: () => GuardianLimits;
  /** Fired on EVERY reading with the settled verdict — the host decides what
   * "shed" means (cancel the job) and what "hold" means (do not admit one). */
  readonly onVerdict: (verdict: GuardianVerdict, reason: string, reading: GuardianReading) => void;
  /** Injectable timers, for tests. */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface Guardian {
  start: () => void;
  stop: () => void;
  /** Take a reading now. */
  poke: () => Promise<GuardianVerdict>;
  /** The verdict in force. */
  verdict: () => GuardianVerdict;
  /** The last reading, for admission (`fits`) and diagnostics. */
  last: () => GuardianReading | null;
  /** Called by the host's heartbeat: how late did it fire? */
  heartbeat: (lateMs: number) => void;
}

export function createGuardian(options: GuardianOptions): Guardian {
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let verdict: GuardianVerdict = 'calm';
  let calmStreak = 0;
  let last: GuardianReading | null = null;
  let timer: unknown = null;
  let running = false;
  let inFlight = false;
  /* The worst stall seen since the last reading. Max rather than latest: a
     reading every second must not miss a 1.8s stall that happened to end 100ms
     before it looked. */
  let worstStallMs = 0;
  /* One reading's swap counters, so the next can be a rate — the same reason the
     power manager carries state. */
  let previousSwap: { ins: number; outs: number; at: number } | undefined;

  const poke = async (): Promise<GuardianVerdict> => {
    if (inFlight) return verdict;
    inFlight = true;
    try {
      let pressure: SystemPressure;
      try {
        pressure = await options.sample();
      } catch {
        pressure = { sources: [] };
      }
      let swapIoPerSec = pressure.swapIoPerSec;
      if (pressure.swapCounters !== undefined) {
        if (previousSwap !== undefined && swapIoPerSec === undefined) {
          const dt = (pressure.swapCounters.at - previousSwap.at) / 1000;
          if (dt > 0) {
            swapIoPerSec =
              (pressure.swapCounters.ins -
                previousSwap.ins +
                (pressure.swapCounters.outs - previousSwap.outs)) /
              dt;
          }
        }
        previousSwap = { ...pressure.swapCounters };
      }
      const reading: GuardianReading = {
        ...pressure,
        ...(swapIoPerSec !== undefined ? { swapIoPerSec } : {}),
        stallMs: worstStallMs,
      };
      worstStallMs = 0;
      last = reading;
      const limits = options.limits();
      const settled = settle(judge(reading, limits), verdict, calmStreak, limits);
      verdict = settled.verdict;
      calmStreak = settled.calmStreak;
      options.onVerdict(verdict, settled.reason, reading);
      return verdict;
    } finally {
      inFlight = false;
    }
  };

  const tick = (): void => {
    if (!running) return;
    void poke().finally(() => {
      if (!running) return;
      timer = schedule(tick, options.busy() ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    });
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      tick();
    },
    stop: () => {
      running = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
    poke,
    verdict: () => verdict,
    last: () => last,
    heartbeat: (lateMs) => {
      if (lateMs > worstStallMs) worstStallMs = lateMs;
      /*
       * A stall long enough to matter is also a reason not to wait for the next
       * scheduled reading — the timer that would take it is the thing being
       * starved. Look now, so the verdict is a second old rather than fifteen.
       */
      if (running && options.busy() && lateMs >= options.limits().stallMs) void poke();
    },
  };
}
