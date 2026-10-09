/**
 * HOW HARD TO PUSH THIS MACHINE — decided from what it is actually doing.
 *
 * The user: "possibly generating/prefilling a bit slower, ensuring we leave a
 * certain amount of memory available as a buffer so the user can use computer as
 * normal while generation and such occurs … this could be dynamic even tracking
 * what the current user memory/cpu/gpu usage is and respecting limitations based
 * on that." And then, on the first draft of this: "it's not about this machine
 * only … you need to handle a range of hardware and a range of situations and
 * bottlenecks."
 *
 * ## Why this is not a slider
 *
 * A single "low power" scalar assumes every machine gets slower the same way.
 * They do not, and the levers that help are not even the same KIND of thing:
 *
 *   UNIFIED MEMORY (Apple Silicon, iGPUs). The GPU eats the same RAM as the OS,
 *   so the wall is total memory and the symptom is swap. MEASURED on an M5 Pro
 *   in perf-args.ts: `-ngl`, `-ub`, `-b`, `-t` and `--mlock` were ALL within
 *   noise of llama.cpp's own auto-tuner. There is no clock knob here. What moves
 *   the needle is holding less memory — context size, KV quantisation, one slot,
 *   and not running an image job beside a resident chat model.
 *
 *   DISCRETE GPU. The wall is VRAM and it is HARD: one layer too many and
 *   llama.cpp spills to the host, which is not slightly slower but an order of
 *   magnitude. `-ngl` is the lever and it is a real one. This is also the only
 *   class where we can SEE the user competing with us — nvidia-smi reports
 *   utilisation, so "they are gaming, back off" is knowable rather than guessed.
 *
 *   CPU-ONLY. The wall is cores, and `--threads` is the one place "generate a
 *   bit slower so I can use my computer" translates directly into a flag.
 *
 * So the policy picks the lever that addresses the wall this machine is nearest,
 * and says which one it picked and why — a mode that silently halves your
 * context is worse than one that tells you it did.
 *
 * ## Two properties that matter more than the thresholds
 *
 * HYSTERESIS. Backing off and returning are asymmetric on purpose: it steps down
 * on one bad reading and needs several consecutive good ones to come back up.
 * Pressure readings are noisy, and a policy that oscillates changes the launch
 * config repeatedly — each change costing a cold prefill, which is worse than
 * either state it was flapping between.
 *
 * NOTHING HERE TOUCHES A RUNNING TURN. Every decision applies to the NEXT launch
 * or the NEXT job. Dropping context under a live conversation would mean a
 * reload mid-sentence, and the stall it causes is exactly the thing this exists
 * to prevent.
 *
 * Pure and dependency-free: it takes a reading and returns a decision, so the
 * interesting cases are unit-tested without a machine under load.
 */
import type { BottleneckClass, SystemPressure } from './pressure.js';

/** What the user asked for. `auto` is the dynamic one and the default. */
export type PowerMode = 'full' | 'auto' | 'low';

/** How hard we are currently pushing. `auto` moves between these; the manual
 * modes pin one. */
export type PowerLevel = 'full' | 'easy' | 'gentle';

export interface PowerInputs {
  readonly mode: PowerMode;
  readonly pressure: SystemPressure;
  readonly bottleneck: BottleneckClass;
  /** Physical RAM (GB) — or the card's VRAM on a discrete GPU. */
  readonly budgetGB: number;
  /** Logical cores, for the CPU-only thread decision. */
  readonly cpuCount?: number;
  /**
   * GB the app promises never to take. The user's "leave a certain amount of memory
   * available as a buffer": a NUMBER, because that is what people mean, rather
   * than a fraction of a total they have to do arithmetic on. Undefined ⇒ derive
   * one from the machine's size (see {@link defaultReserveGB}).
   */
  readonly reserveGB?: number;
  /** The level in force before this reading — hysteresis needs it. */
  readonly previous?: PowerLevel;
  /** Consecutive calm readings so far (carried by the caller). */
  readonly calmStreak?: number;
}

export interface PowerDecision {
  readonly level: PowerLevel;
  /** Fraction of the memory budget a launch may occupy (context-cap reads this). */
  readonly memoryFraction: number;
  /** Quantise the KV cache — halves it, MEASURED ~7% slower. */
  readonly quantizeKv: boolean;
  /** Cap on parallel server slots. */
  readonly maxParallel: number;
  /** `--threads`, when the machine is CPU-bound and we are easing off. */
  readonly threads?: number;
  /**
   * Keep the KV cache in system RAM instead of on the card (`--no-kv-offload`).
   *
   * The discrete-GPU lever, and deliberately NOT `-ngl`: offloading a fraction
   * of the layers is the textbook answer, but `-ngl` takes a layer COUNT and
   * this app's catalog does not carry one — a fraction of an unknown is not a
   * flag, it is a guess. `--no-kv-offload` needs nothing but the decision, and
   * it buys the same thing: VRAM back, at the cost of speed. On a card near its
   * limit that is the trade worth making, because the alternative is llama.cpp
   * spilling WEIGHTS to the host, which is an order of magnitude rather than a
   * fraction.
   */
  readonly keepKvOnHost?: boolean;
  /** Run the inference process at background priority so the OS schedules the
   * user first. macOS `taskpolicy` QoS tiers (never -b: the E-core clamp is 12× slower), Linux `nice`. */
  readonly backgroundPriority: boolean;
  /**
   * NO "may a heavy job start" answer lives here. The user, correcting the first
   * cut: "low can't stop image generation requests, it just has to lessen
   * compute intensivity in some way sacrificing speed to keep headroom."
   * Whether a job FITS is the guardian's question, answered by measurement per
   * job; the policy's answer is how hard to run it — {@link heavyJobPace} and
   * {@link heavyJobPreviews}.
   */
  /**
   * How much of the time a heavy job's process is PAUSED — 0 runs flat out,
   * 0.35 rests a third of every second. That is the compute lever for a
   * generation: the GPU and the cores get a breath between command buffers,
   * the machine stays usable, the picture arrives later rather than never.
   */
  readonly heavyJobPace: number;
  /**
   * Per-step previews for image jobs, or only the finished picture. Previews
   * cost ~4.5 GB of peak memory at 512² (MEASURED); under pressure that is
   * the headroom worth keeping, and the pending card animates instead.
   */
  readonly heavyJobPreviews: boolean;
  /** Consecutive calm readings after this one — pass back in next time. */
  readonly calmStreak: number;
  /** Why, in one line, for the UI and the log. Never empty. */
  readonly reason: string;
}

/** Calm readings needed before easing back up. Asymmetric on purpose. */
export const RECOVERY_READINGS = 4;

/*
 * SWAP THRESHOLDS, CALIBRATED AGAINST A REAL RAMP.
 *
 * MEASURED on a 24 GB M5 Pro while 8 GB of incompressible memory was held
 * (tests/e2e/power-stress-probe.mjs):
 *
 *   idle / background housekeeping   0 – 71 pages/sec
 *   the machine genuinely thrashing  8,804 – 63,157 pages/sec
 *
 * Two orders of magnitude between them, which is the useful part: anywhere in
 * that gap is a safe place to draw a line. The first version used 100, which sat
 * right on top of the noise band — and in the ramp it tripped on ordinary
 * background activity at 1–2 GB held, easing off a machine that was fine and
 * then taking four calm readings to come back. 500 clears the noise by 7×;
 * 2,000 still fires four times below the lightest real thrashing seen.
 */
/** Enough swap traffic to ease off one step. */
export const BUSY_PAGES_PER_SEC = 500;
/** Enough to say the machine is thrashing. */
export const THRASHING_PAGES_PER_SEC = 2000;

/**
 * The reserve, when the user has not named one.
 *
 * A sixth of the machine, floored at 2 GB and capped at 8 — the shape of the
 * problem is not linear. An 8 GB laptop cannot spare much and still run
 * anything, so it gets the 2 GB floor; a 128 GB workstation does not need
 * 21 GB held back for a text editor, so it stops at 8.
 *
 * It was a quarter (6 GB on 24 GB), and that quarter is what made the models
 * a 24 GB Mac is bought for impossible ON a 24 GB Mac: the guardian's answer
 * for a job is `peak × 1.15 + 1 GB + reserve`, and with 6 GB held back nothing
 * that peaks above 14.8 GB could ever be admitted (`fits` says "never" the
 * moment need + reserve exceeds the machine) — TRELLIS.2 on ComfyUI measures
 * 11.5 GB at 512³, LTX-2.5's encoder stage 14 GB. A sixth (4 GB) keeps the
 * promise the reserve exists for — the machine stays usable — and lets a 24 GB
 * Mac run what it can physically hold; the live guardian still holds and sheds
 * on the readings.
 */
export function defaultReserveGB(totalGB: number): number {
  return Math.min(8, Math.max(2, Math.round(totalGB / 6)));
}

/** The reserve as the fraction of the budget a launch may take. */
export function reserveToFraction(budgetGB: number, reserveGB: number): number {
  if (!(budgetGB > 0)) return 0.8;
  return Math.min(0.95, Math.max(0.3, 1 - reserveGB / budgetGB));
}

/** Is this reading asking us to back off, and how hard? */
export function pressureSeverity(p: SystemPressure, bottleneck: BottleneckClass): 0 | 1 | 2 {
  // The OS's own verdict outranks everything we could infer.
  if (p.memory === 'critical') return 2;
  /*
   * THRASHING IS THE FLOW, NOT THE STOCK.
   *
   * This first read `swapUsed` — how full the swap file is — and MEASURED on a
   * real machine it was wrong in the worst way: a 24 GB Mac at 65% swap used,
   * pressure level 1 (normal), with the swapin/swapout counters not moving at
   * all over three seconds. That 65% was accumulated over days of uptime. The
   * rule would have pinned every long-running machine into its most conservative
   * mode permanently, and the run that found it took four seconds.
   *
   * `swapIoPerSec` is the honest signal: pages actually moving. A few pages a
   * second is normal background housekeeping; hundreds is the machine you can
   * feel stuttering. The stock is kept only to corroborate a verdict the OS has
   * already raised — it can sharpen a warning, never manufacture one.
   */
  if (bottleneck === 'unified' && (p.swapIoPerSec ?? 0) >= THRASHING_PAGES_PER_SEC) return 2;
  if (p.memory === 'warn') {
    return (p.swapUsed ?? 0) >= 0.5 || (p.swapIoPerSec ?? 0) >= BUSY_PAGES_PER_SEC ? 2 : 1;
  }
  if (bottleneck === 'unified' && (p.swapIoPerSec ?? 0) >= BUSY_PAGES_PER_SEC) return 1;
  /*
   * PRESSURE BUILDING, not pressure arrived. The coarse verdict has three values
   * and flips late; the OS's own free-memory percentage is continuous, so a
   * machine heading for trouble can be met on the way rather than after. Only
   * ever worth one step — this is an early warning, not an emergency.
   */
  if ((p.memoryFree ?? 1) <= 0.12) return 2;
  if ((p.memoryFree ?? 1) <= 0.25) return 1;
  // A discrete card that is nearly full is one layer from spilling to the host.
  if (bottleneck === 'discrete' && (p.vram ?? 0) >= 0.9) return 2;
  if (bottleneck === 'discrete' && (p.vram ?? 0) >= 0.75) return 1;
  // Somebody else is using the GPU — the one case we can actually SEE.
  if ((p.gpu ?? 0) >= 0.7) return 1;
  // Thermal throttling or the user's own low-power mode: the machine has already
  // decided it wants less work, and arguing with it wastes heat.
  if (p.throttled === true) return 1;
  if (bottleneck === 'cpu' && (p.cpu ?? 0) >= 0.9) return 1;
  return 0;
}

/** The level this reading argues for, before hysteresis. */
function levelFor(inputs: PowerInputs): PowerLevel {
  if (inputs.mode === 'full') return 'full';
  if (inputs.mode === 'low') return 'gentle';
  const severity = pressureSeverity(inputs.pressure, inputs.bottleneck);
  // On battery the machine is spending a finite budget, so ease off by one step
  // even when nothing is complaining yet.
  const onBattery = inputs.pressure.onBattery === true;
  if (severity >= 2) return 'gentle';
  if (severity >= 1 || onBattery) return 'easy';
  return 'full';
}

/**
 * Decide. `auto` steps DOWN immediately on a bad reading and UP only after
 * {@link RECOVERY_READINGS} calm ones — see the header on why that asymmetry is
 * the important part.
 */
export function decidePower(inputs: PowerInputs): PowerDecision {
  const wanted = levelFor(inputs);
  const previous = inputs.previous ?? 'full';
  const rank: Record<PowerLevel, number> = { full: 0, easy: 1, gentle: 2 };

  let level = wanted;
  let calmStreak = inputs.calmStreak ?? 0;
  if (inputs.mode === 'auto') {
    if (rank[wanted] > rank[previous]) {
      level = wanted; // worse: act at once
      calmStreak = 0;
    } else if (rank[wanted] < rank[previous]) {
      calmStreak += 1;
      level = calmStreak >= RECOVERY_READINGS ? wanted : previous;
      if (level === wanted) calmStreak = 0;
    } else {
      calmStreak = 0;
    }
  }

  const reserveGB = inputs.reserveGB ?? defaultReserveGB(inputs.budgetGB);
  const base = reserveToFraction(inputs.budgetGB, reserveGB);
  const cores = inputs.cpuCount ?? 0;

  if (level === 'full') {
    return {
      level,
      memoryFraction: base,
      quantizeKv: false,
      maxParallel: 4,
      backgroundPriority: false,
      heavyJobPace: 0,
      heavyJobPreviews: true,
      calmStreak,
      reason: `full speed, holding ${reserveGB} GB back for you`,
    };
  }

  /*
   * The lever depends on the wall — see the header. Each branch names the ONE
   * thing that actually moves this class of machine, rather than applying all of
   * them everywhere and hoping.
   */
  const gentle = level === 'gentle';
  const common = {
    level,
    // Give back roughly a further tenth of the budget at 'easy', a fifth at
    // 'gentle'. Smaller context ⇒ less resident KV ⇒ less to swap.
    memoryFraction: Math.max(0.3, base - (gentle ? 0.2 : 0.1)),
    maxParallel: gentle ? 1 : 2,
    backgroundPriority: true,
    // A generation is never refused by the policy — it is run gentler: paused
    // a share of every second, and without the previews that cost 4.5 GB.
    heavyJobPace: gentle ? 0.35 : 0.15,
    heavyJobPreviews: !gentle,
    calmStreak,
  };

  if (inputs.bottleneck === 'cpu') {
    // The one class where a clock knob exists: leave cores for the user.
    const threads = Math.max(1, Math.floor(cores * (gentle ? 0.5 : 0.75)) || 1);
    return {
      ...common,
      // Never — see the unified-memory branch below on why the KV is not the
      // place to save, whatever the bottleneck.
      quantizeKv: false,
      threads,
      reason: `CPU-bound: ${threads} of ${cores} cores, so the machine stays responsive`,
    };
  }

  if (inputs.bottleneck === 'discrete') {
    /*
     * VRAM is a hard wall. Give it back BEFORE the card spills, because a spill
     * is not a slowdown, it is a different order of magnitude. Quantising the KV
     * halves it; moving it off the card entirely frees all of it, which is the
     * stronger medicine and the slower one — so only under real pressure.
     */
    return {
      ...common,
      quantizeKv: true,
      ...(gentle ? { keepKvOnHost: true } : {}),
      reason: gentle
        ? 'GPU memory is nearly full: KV cache moved to system RAM so the model itself never spills'
        : 'GPU is busy: quantising the KV cache and giving back context',
    };
  }

  /*
   * Unified memory: there is no clock knob (MEASURED), so every lever is a
   * memory lever — but NOT the KV cache.
   *
   * The user: "no quantizing kv that damages a lot especially at this model size."
   * He is talking about ANSWER QUALITY, and he is right that it is the wrong
   * thing to spend here: these are 2B-27B models whose attention is already the
   * fragile part, and the KV is what they remember of the conversation. I had
   * measured only speed (q8_0 is ~12% FASTER here) and that is not the axis this
   * decision lives on.
   *
   * Context size stays the lever: a smaller window is a smaller KV in exact
   * proportion, and it degrades by forgetting the oldest turn rather than by
   * making every remembered token slightly wrong.
   */
  return {
    ...common,
    quantizeKv: false,
    reason: gentle
      ? 'memory is tight: smaller context, one slot, generations paced and without previews'
      : 'easing off: a smaller context to leave you room',
  };
}
