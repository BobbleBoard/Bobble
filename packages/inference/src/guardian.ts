/**
 * THE MACHINE COMES FIRST — the part of the power policy that acts.
 *
 * The user, after their Mac locked up under a generation: "computer just became
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

/**
 * `pause` is the verdict between hold and shed — the user (2026-09-16), after a
 * restart: "runs should be paused and even totally terminated if pausing
 * fails for some reason quickly … kernel level hangs are 100% unacceptable."
 * Running heavy work is STOPPED IN PLACE (SIGSTOP) the reading it crosses the
 * pause line, resumed when the machine has breathed, and terminated if the
 * pause does not bring the memory back.
 */
export type GuardianVerdict = 'calm' | 'hold' | 'pause' | 'shed';

/** What the guardian judges: the pressure reading plus what only the host process knows. */
export interface GuardianReading extends SystemPressure {
  /** How late the host's own timer fired — the main thread's starvation, in ms. */
  readonly stallMs?: number;
}

export interface GuardianLimits {
  /** Below this fraction free (the OS's own number), nothing heavy starts. */
  readonly holdFree: number;
  /** Below this, running heavy work is PAUSED in place. */
  readonly pauseFree: number;
  /**
   * The "room" line for the two corroborated pauses (a swap burst, the
   * kernel's "warn"): at or under this, a burst has nowhere to land and the
   * run is paused; above it, the burst is a hold. THE SAME IN EVERY MODE —
   * it read the mode's hold line, and in 'low' (the default) that was 30%:
   * MEASURED (2026-09-16, CubePart's text encode through the app at 28–30%
   * free), 39 pause/resume cycles in seven minutes, each resume swapping
   * back in the pages the pause had let the kernel evict, each swap-in
   * burst the next pause. The encode ran at half speed and the machine was
   * never in danger. A line that moves with the mode is a mode that stops
   * generations, which 'low' must never be (see tightFree).
   */
  readonly pauseRoomFree: number;
  /** Below this, running heavy work is cancelled. */
  readonly shedFree: number;

  /** Readings a pause may stand before it becomes a shed — the pause did not
   * bring the memory back, so the job goes. */
  readonly pausedReadingsBeforeShed: number;
  /** Consecutive readings OFF the pause line (hold-grade or calm) before a
   * PAUSED job is resumed — shorter than a hold's recovery: a stopped process
   * costs the person nothing to wait on, and a resume that turns out early
   * just pauses again. Not "calm": a paused job's own memory keeps the
   * machine on hold, and waiting for calm was a pause that never lifted. */
  readonly resumeReadings: number;
  /**
   * "Tight" for the two corroborated sheds (heavy swap, a main-thread stall):
   * memory at or under this AND the other signal is a thrash. The same in
   * every mode — a shed line that moved with the mode is a mode that stops
   * generations, which 'low' must never be (see limitsFor).
   */
  readonly tightFree: number;
  /** A main-thread stall at least this long, with memory already under
   * `holdFree`, counts as thrashing. */
  readonly stallMs: number;
  /** Swap traffic that means the machine is thrashing (pages/sec). */
  readonly thrashingPagesPerSec: number;
  /** Consecutive calm readings before a hold is lifted. */
  readonly recoveryReadings: number;
  /** Consecutive swap-hot readings (with memory to spare) before that counts as
   * a thrash. A load burst is one or two; a thrash is all of them. */
  readonly hotReadings: number;
  /**
   * The same streak when memory is COMFORTABLE (free above `holdFree`). A
   * mesh bake churning through temporaries on a machine with 40% free is not
   * a freeze in the making — MEASURED, TRELLIS.2's CPU mesh stage runs the
   * compressor at 4,000–11,000 pages/s for ten seconds with 43% free, and four
   * readings of that stopped the job five minutes in. With room to land a
   * burst is given this many readings before it is called a thrash.
   */
  readonly hotReadingsWithRoom: number;
}

/*
 * THE LINES, AND WHERE THEY COME FROM.
 *
 * `kern.memorystatus_level` is the percentage macOS's own jetsam steers by. On
 * the day of the freeze the two jetsam reports fired with free at roughly 8-10%
 * — so 8% is where the OS itself starts killing, and shedding there is choosing
 * the victim, not being cautious. 20% for hold is the point the earlier policy
 * already called "pressure building".
 *
 * Low mode keeps a wider margin on HOLD, because "low power" means "I am using
 * this computer for something else" — a hold is a wait for what has not
 * started. It does NOT shed earlier. It did (15%), and a first-run weights
 * download took the level through 15% while the picture was still to come:
 * the job was stopped for being in low power. The user: "low can't stop image
 * generation requests, it just has to lessen compute intensivity in some way
 * sacrificing speed to keep headroom" — the mode's levers are the pace, the
 * previews and the low-RAM run (power-policy.ts, ImageJobSpec); the shed line
 * is the OS's own, in every mode.
 *
 * The thrashing rate is power-policy's own calibrated line (see
 * THRASHING_PAGES_PER_SEC there: real thrash MEASURED at 8,800-63,000 pages/s,
 * idle at 0-71).
 */
export function limitsFor(mode: PowerMode): GuardianLimits {
  const low = mode === 'low';
  return {
    holdFree: low ? 0.3 : 0.2,
    /*
     * THE PAUSE LINE. Between hold and shed: 15% by the kernel's reclaimable
     * figure, or the kernel's own "warn". A paused job holds what it has and
     * takes no more; the kernel gets the seconds it needs to reclaim cache,
     * and the job resumes.
     */
    pauseFree: 0.15,
    pauseRoomFree: 0.25,
    shedFree: 0.08,
    pausedReadingsBeforeShed: 20,
    resumeReadings: 3,
    /*
     * NOT `holdFree`. The swap-and-tight shed read the mode's hold line, so in
     * 'low' — the DEFAULT — a job whose load burst dipped to 30% free was
     * cancelled on the spot: MEASURED, ComfyUI loading TRELLIS.2's 5 GB DiT
     * and two VAEs on an otherwise idle 24 GB Mac read "swapping hard (44,506
     * pages/s) with 30% of memory free" and was shed before its first step.
     * That is the load, not a freeze, and 'full' would have held it for four
     * readings and then let it run. The line is the same in both modes now.
     */
    tightFree: 0.2,
    stallMs: 1500,
    thrashingPagesPerSec: 2000,
    recoveryReadings: 4,
    /*
     * IN READINGS AT THE BUSY CADENCE (500 ms). These were 4 and 20 at one
     * reading a second; halving the interval halved the seconds they stood
     * for, and MEASURED: CubePart moving its 9.9 GB pipeline into MLX swaps at
     * 25-33k pages/s for a good fifteen seconds with 40% free — a load, and
     * it was ended at ten. The wall-clock meaning is what was calibrated, so
     * the counts follow the cadence: a burst without room gets 4 s, one with
     * room 20 s.
     */
    hotReadings: 8,
    hotReadingsWithRoom: 40,
  };
}

export interface GuardianJudgement {
  readonly verdict: GuardianVerdict;
  /** One line, for the log and for the person whose job was stopped. */
  readonly reason: string;
  /** Swapping hard with memory to spare — a burst that becomes a thrash if it
   * lasts. `settle` counts these. */
  readonly hot?: boolean;
  /** …and with memory COMFORTABLE (above the hold line): the longer streak. */
  readonly room?: boolean;
}

/** The verdict a single reading argues for, before any hysteresis. */
export function judge(reading: GuardianReading, limits: GuardianLimits): GuardianJudgement {
  const free = reading.memoryFree;
  const pct = free === undefined ? undefined : Math.round(free * 100);

  const freeNow = reading.memoryFreeNow;
  const pctNow = freeNow === undefined ? undefined : Math.round(freeNow * 1000) / 10;

  // The OS's own verdict outranks everything we could infer.
  if (reading.memory === 'critical') {
    return { verdict: 'shed', reason: 'the system reports critical memory pressure' };
  }
  if (free !== undefined && free <= limits.shedFree) {
    return { verdict: 'shed', reason: `only ${pct}% of memory is free` };
  }
  /*
   * NOT A SHED LINE: the pages actually free. MEASURED twice while wiring
   * this — a 10 GB model LOADING takes macOS through "warn" with 0.6% of
   * pages free for a second while the kernel reclaims cache, and the machine
   * is fine (memorystatus_level 42%). A shed there kills every big model at
   * load. The number rides along in the reason so the log says what the
   * kernel saw; "warn" pauses, "critical" and a pause that does not lift are
   * what end a run.
   */
  /*
   * A SWAP BURST IS NOT YET A THRASH. Loading 10 GB of wired GPU memory on a
   * unified-memory Mac evicts that much file cache and compresses whatever is
   * in the way, and MEASURED (FLUX.2 klein at 512², 84% free) that shows as
   * 33,000 pages/s for a second or two with memory still to spare — the load,
   * not the freeze. Shedding on that reading would mean no large model ever
   * finishes loading. So heavy swap alone is a HOLD; it becomes a shed when
   * memory is also gone (the burst had nowhere to go) or when it persists —
   * `settle` counts the streak, because a burst ends and a thrash does not.
   */
  const swapping = (reading.swapIoPerSec ?? 0) >= limits.thrashingPagesPerSec;
  if (swapping && free !== undefined && free <= limits.tightFree) {
    return {
      verdict: 'shed',
      reason: `the machine is swapping hard (${Math.round(reading.swapIoPerSec ?? 0)} pages/s) with ${pct}% of memory free`,
    };
  }
  /*
   * STALL + TIGHT = THRASH. Neither alone is: a stall can be one long synchronous
   * call in the host, and tight memory with a responsive main thread is exactly
   * the state a big model is supposed to run in. Together they are the pointer
   * freezing.
   */
  if ((reading.stallMs ?? 0) >= limits.stallMs && free !== undefined && free <= limits.tightFree) {
    return {
      verdict: 'shed',
      reason: `the app stalled for ${Math.round((reading.stallMs ?? 0) / 100) / 10}s with ${pct}% of memory free`,
    };
  }
  /*
   * THE PAUSE LINES. The kernel saying "warn" with memory under the room
   * line, the reclaimable figure under 15%: running work stops in place,
   * now, and the next reading decides whether it resumes or goes. A swap
   * burst WITHOUT room to land pauses too (with room it stays a hold — a
   * model loading on an idle machine is a burst, not a freeze). The room
   * line (`pauseRoomFree`) is the same in every power mode.
   */
  const room = free !== undefined && free > limits.pauseRoomFree;
  if (swapping && !room) {
    return {
      verdict: 'pause',
      reason: `the machine is swapping (${Math.round(reading.swapIoPerSec ?? 0)} pages/s) with ${pct}% of memory free`,
      hot: true,
      room: false,
    };
  }
  /*
   * "WARN" IS NOT A PAUSE ON ITS OWN. MEASURED (2026-09-16, a 10 GB model
   * loading on a 24 GB Mac): the kernel sits at "warn" for ten seconds and
   * more while it reclaims cache, with memorystatus_level at 40% — the load,
   * not a freeze — and a run paused on that reading never sees it lift and
   * is ended for a burst that would have passed. Warn pauses when the
   * reclaimable figure is ALSO tight (under the room line, the same in every
   * mode); on its own it holds new work at the door.
   */
  if (reading.memory === 'warn' && free !== undefined && free <= limits.pauseRoomFree) {
    return {
      verdict: 'pause',
      reason: `the system reports memory pressure with ${pct}% free${pctNow === undefined ? '' : ` (${pctNow}% of pages)`}`,
    };
  }
  if (free !== undefined && free <= limits.pauseFree) {
    return { verdict: 'pause', reason: `${pct}% of memory is free` };
  }
  if (swapping) {
    return {
      verdict: 'hold',
      reason: `the machine is swapping (${Math.round(reading.swapIoPerSec ?? 0)} pages/s)`,
      hot: true,
      room: true,
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
export interface Settled {
  readonly verdict: GuardianVerdict;
  readonly calmStreak: number;
  readonly hotStreak: number;
  /** Readings the pause has stood for; escalates to a shed at the limit. */
  readonly pausedStreak: number;
  readonly reason: string;
}

export function settle(
  next: GuardianJudgement,
  previous: GuardianVerdict,
  calmStreak: number,
  limits: GuardianLimits,
  hotStreak = 0,
  pausedStreak = 0,
): Settled {
  if (next.verdict === 'shed') {
    return { verdict: 'shed', calmStreak: 0, hotStreak: 0, pausedStreak: 0, reason: next.reason };
  }
  if (next.verdict === 'pause') {
    /*
     * A PAUSE THAT DOES NOT HELP IS A SHED. The job holds what it has; if
     * the machine is still on the pause line after this many readings, its
     * memory is what the machine needs back, and the only way to get it is
     * to end the job. The user: "totally terminated if pausing fails for some
     * reason quickly".
     */
    const paused = pausedStreak + 1;
    if (paused >= limits.pausedReadingsBeforeShed) {
      return {
        verdict: 'shed',
        calmStreak: 0,
        hotStreak: 0,
        pausedStreak: 0,
        reason: `${next.reason} — paused for ${paused} readings and it did not come back`,
      };
    }
    return {
      verdict: 'pause',
      calmStreak: 0,
      hotStreak: 0,
      pausedStreak: paused,
      reason: next.reason,
    };
  }
  if (next.verdict === 'hold') {
    /*
     * OFF THE PAUSE LINE IS ENOUGH TO RESUME. A hold means "start nothing
     * heavy", never "stop what runs" — the job ran under hold-grade readings
     * before it was paused, and it can again. Waiting for CALM here was a
     * deadlock: the paused job's own memory is what keeps the kernel at
     * "warn", so calm never comes while it is stopped. MEASURED (2026-09-16,
     * CubePart through the app): paused at 27% free, "warn" for the next
     * five minutes with 34% free, no resume, no shed — the stage sat in
     * ps state T until the app was killed. The pause-line readings are the
     * freeze signals; when they are gone for `resumeReadings` readings the
     * job goes on, and if it drags the machine back onto the line it is
     * paused again (and shed if the pause then does not lift).
     */
    if (previous === 'pause') {
      const streak = calmStreak + 1;
      if (streak >= limits.resumeReadings) {
        return {
          verdict: 'hold',
          calmStreak: 0,
          hotStreak: 0,
          pausedStreak: 0,
          reason: `${next.reason}; off the pause line, resuming`,
        };
      }
      return {
        verdict: 'pause',
        calmStreak: streak,
        hotStreak: 0,
        pausedStreak,
        reason: `${next.reason}; still paused (${streak}/${limits.resumeReadings})`,
      };
    }
    if (next.hot === true) {
      const hot = hotStreak + 1;
      // A burst that will not end is a thrash, whatever the free figure says —
      // and "will not end" is judged with the room it has to land in.
      const allowed = next.room === true ? limits.hotReadingsWithRoom : limits.hotReadings;
      if (hot >= allowed) {
        return {
          verdict: 'shed',
          calmStreak: 0,
          hotStreak: 0,
          pausedStreak: 0,
          reason: `${next.reason} for ${hot} readings running`,
        };
      }
      return {
        verdict: 'hold',
        calmStreak: 0,
        hotStreak: hot,
        pausedStreak: 0,
        reason: next.reason,
      };
    }
    return { verdict: 'hold', calmStreak: 0, hotStreak: 0, pausedStreak: 0, reason: next.reason };
  }
  // calm
  if (previous === 'calm') {
    return { verdict: 'calm', calmStreak: 0, hotStreak: 0, pausedStreak: 0, reason: next.reason };
  }
  const streak = calmStreak + 1;
  // A paused job is resumed sooner than a held one is admitted: the stopped
  // process cost nothing to wait on, and an early resume just pauses again.
  const needed = previous === 'pause' ? limits.resumeReadings : limits.recoveryReadings;
  if (streak >= needed) {
    return { verdict: 'calm', calmStreak: 0, hotStreak: 0, pausedStreak: 0, reason: next.reason };
  }
  return {
    verdict: previous === 'pause' ? 'pause' : 'hold',
    calmStreak: streak,
    hotStreak: 0,
    pausedStreak: previous === 'pause' ? pausedStreak : 0,
    reason: `${next.reason}; waiting for it to stay that way (${streak}/${needed})`,
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
export function fits(input: FitInput): { ok: boolean; reason: string; never?: boolean } {
  const needGB = input.footprintGB * HEADROOM_FACTOR + HEADROOM_GB;
  const r = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
  /*
   * NEVER, NOT LATER. A job that would not fit with every other program closed
   * is not waiting for memory — there is no reading that admits it. Holding it
   * would leave the mark animating over "Waiting for memory" for as long as the
   * person cared to watch, which is how "the app hangs" gets reported. Say what
   * would change the answer instead: a smaller picture, or a smaller reserve.
   */
  if (needGB + input.reserveGB > input.totalGB) {
    return {
      ok: false,
      never: true,
      reason: `needs about ${r(needGB)} GB and this Mac has ${r(input.totalGB)} GB — try a smaller size, or lower the memory reserve in Settings (currently ${input.reserveGB} GB)`,
    };
  }
  if (input.freeFraction === undefined) {
    return { ok: true, reason: 'memory not measured; not holding the job on a guess' };
  }
  const availableGB = input.totalGB * input.freeFraction;
  const leftGB = availableGB - needGB;
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

/** How often to look while heavy work is running. A thrash builds in seconds —
 * MEASURED 2026-09-15, a 3D job took a 24 GB Mac from 48% free to 165 MB
 * between two one-second readings. Half a second is the reaction a pause needs. */
export const BUSY_INTERVAL_MS = 500;
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
  let hotStreak = 0;
  let pausedStreak = 0;
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
      const settled = settle(
        judge(reading, limits),
        verdict,
        calmStreak,
        limits,
        hotStreak,
        pausedStreak,
      );
      verdict = settled.verdict;
      calmStreak = settled.calmStreak;
      hotStreak = settled.hotStreak;
      pausedStreak = settled.pausedStreak;
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
      // A pause in force is watched at the busy cadence whatever the host
      // says: the resume decision is the thing the person is waiting on.
      timer = schedule(
        tick,
        options.busy() || verdict === 'pause' ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
      );
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
