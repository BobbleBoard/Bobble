/**
 * THE LIVE POWER POLICY — sampling on a timer, deciding, and remembering.
 *
 * {@link samplePressure} reads the machine and {@link decidePower} judges it;
 * this is the small amount of state between them: a timer, the previous level
 * (hysteresis needs it), and the calm streak.
 *
 * It deliberately does NOT apply anything itself. A launch reads the current
 * decision when it builds its args; a generation job asks before it starts.
 * That keeps the rule from the policy's header — nothing here reaches into a
 * running turn — structurally true rather than merely intended.
 *
 * Sampling is cheap (a few sysctl reads or /proc files) but not free, so it runs
 * on a slow timer and every probe is bounded by the caller's `run`. A machine
 * that answers nothing still gets a decision: 'full', with the reserve applied.
 */
import { decidePower, type PowerDecision, type PowerMode } from './power-policy.js';
import type { BottleneckClass, PressureProbes, SystemPressure } from './pressure.js';
import { samplePressure } from './pressure.js';

/** How often to read the machine. Slow on purpose — pressure that matters lasts
 * longer than this, and polling harder buys noise. */
export const SAMPLE_INTERVAL_MS = 15_000;

export interface PowerManagerOptions {
  readonly probes: PressureProbes;
  readonly bottleneck: BottleneckClass;
  /** RAM on unified memory, the card's VRAM on a discrete GPU. */
  readonly budgetGB: number;
  readonly cpuCount?: number;
  /** GB the app promises never to take. Undefined ⇒ derived from the machine. */
  readonly reserveGB?: number;
  readonly mode?: PowerMode;
  /** Fired whenever the LEVEL changes, so the app can say so. */
  readonly onChange?: (decision: PowerDecision, pressure: SystemPressure) => void;
}

export interface PowerManager {
  /** The decision in force. Never null — a fresh manager starts at 'full'. */
  current: () => PowerDecision;
  /** The last reading, for diagnostics / the UI. */
  lastPressure: () => SystemPressure | null;
  /** Change what the user asked for. Re-decides immediately. */
  setMode: (mode: PowerMode) => Promise<PowerDecision>;
  /** Change the reserve. Re-decides immediately. */
  setReserveGB: (gb: number | undefined) => Promise<PowerDecision>;
  /** Take a reading now (the timer calls this). */
  sample: () => Promise<PowerDecision>;
  start: () => void;
  stop: () => void;
}

export function createPowerManager(options: PowerManagerOptions): PowerManager {
  let mode: PowerMode = options.mode ?? 'auto';
  let reserveGB = options.reserveGB;
  let pressure: SystemPressure | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const decide = (): PowerDecision =>
    decidePower({
      mode,
      pressure: pressure ?? { sources: [] },
      bottleneck: options.bottleneck,
      budgetGB: options.budgetGB,
      ...(options.cpuCount !== undefined ? { cpuCount: options.cpuCount } : {}),
      ...(reserveGB !== undefined ? { reserveGB } : {}),
      previous: decision.level,
      calmStreak: decision.calmStreak,
    });

  // Seeded from an empty reading: 'full', with the reserve honoured. A machine
  // we have not measured yet is not a machine in trouble.
  let decision: PowerDecision = decidePower({
    mode,
    pressure: { sources: [] },
    bottleneck: options.bottleneck,
    budgetGB: options.budgetGB,
    ...(options.cpuCount !== undefined ? { cpuCount: options.cpuCount } : {}),
    ...(reserveGB !== undefined ? { reserveGB } : {}),
  });

  const apply = (next: PowerDecision): PowerDecision => {
    const changed = next.level !== decision.level;
    decision = next;
    if (changed) options.onChange?.(next, pressure ?? { sources: [] });
    return next;
  };

  /*
   * The previous reading's swap counters, carried so the NEXT one can be a rate.
   *
   * This is the whole reason the manager holds state beyond hysteresis: swap
   * pressure is a flow, and a flow needs two readings. MEASURED on a real Mac,
   * the stock alone said "in trouble" while the counters had not moved in three
   * seconds — see pressureSeverity.
   */
  let previousSwap: { ins: number; outs: number; at: number } | undefined;

  const sample = async (): Promise<PowerDecision> => {
    try {
      pressure = await samplePressure({
        ...options.probes,
        ...(previousSwap !== undefined ? { previousSwap } : {}),
      });
      if (pressure.swapCounters !== undefined) previousSwap = { ...pressure.swapCounters };
    } catch {
      // A probe that throws is a machine that will not say — not an emergency.
      pressure = { sources: [] };
    }
    return apply(decide());
  };

  return {
    current: () => decision,
    lastPressure: () => pressure,
    setMode: async (next) => {
      mode = next;
      return await sample();
    },
    setReserveGB: async (gb) => {
      reserveGB = gb;
      return await sample();
    },
    sample,
    start: () => {
      if (timer !== null) return;
      void sample();
      timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
      // Never hold the process open for a poll.
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Which wall this machine is nearest, from what `detectAccelerators` found.
 *
 * The distinction that matters is NOT "does it have a GPU" but "does the GPU
 * have memory of its own": a discrete card's VRAM is a hard, separate wall,
 * while an Apple GPU or an iGPU is competing with the OS for the same pages.
 */
export function classifyBottleneck(info: {
  readonly unifiedMemory: boolean;
  readonly gpus: readonly { readonly vramGB?: number }[];
}): BottleneckClass {
  const gpu = info.gpus[0];
  if (gpu === undefined) return 'cpu';
  if (!info.unifiedMemory && gpu.vramGB !== undefined && gpu.vramGB > 0) return 'discrete';
  return 'unified';
}

/** The budget the policy reasons about: the card's memory, or the machine's. */
export function powerBudgetGB(info: {
  readonly unifiedMemory: boolean;
  readonly totalRamGB: number;
  readonly gpus: readonly { readonly vramGB?: number }[];
}): number {
  const gpu = info.gpus[0];
  if (!info.unifiedMemory && gpu?.vramGB !== undefined && gpu.vramGB > 0) return gpu.vramGB;
  return info.totalRamGB;
}
