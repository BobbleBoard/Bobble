/**
 * MAY BACKGROUND WORK RUN ON THIS POWER? — one policy shape for memory
 * learning, training runs and scheduled workflows.
 *
 * The Mac hibernated at 1% battery during engine benchmarks on 2026-09-23
 * (deliverables/research/PLAN.md §4.1), which is why heavy work is AC-only.
 * Memory learning, training and scheduled workflows each asked the same
 * question in their own design (question 11 in PLAN.md §5); it is answered
 * once, here, beside chat-activity.ts (F3).
 *
 * SKELETON from the W0-A pre-wire: the types, the pure verdict and the reader
 * seam. ACT-01 (lane MEM, W1) supplies the real reader (`pmset -g batt`,
 * the thermal state) and the listeners that pause and resume on a change;
 * TR-4 adds `caffeinate` for a training run. The default policies are Q11's
 * recommended default until the user answers it.
 */

/** macOS thermal pressure, least to most severe (NSProcessInfo.ThermalState). */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

const THERMAL_RANK: Record<ThermalState, number> = { nominal: 0, fair: 1, serious: 2, critical: 3 };

/** What the machine says about its power. `null` = could not tell. */
export interface PowerReading {
  readonly onAC: boolean | null;
  readonly batteryPercent: number | null;
  readonly thermal: ThermalState | null;
}

export interface PowerPolicy {
  /** Run only on AC power. */
  readonly requireAC: boolean;
  /** On battery, run only above this charge (percent). Null = any charge. */
  readonly minBatteryPercent: number | null;
  /** The worst thermal state the work may run in. */
  readonly maxThermal: ThermalState;
}

export interface PowerVerdict {
  readonly allowed: boolean;
  /** Why not, in words the person can read ("not on AC power"). Null when allowed. */
  readonly reason: string | null;
}

/** Nothing known — what the reader returns until ACT-01 supplies a real one. */
export const UNKNOWN_POWER: PowerReading = { onAC: null, batteryPercent: null, thermal: null };

/**
 * Q11's recommended default (PLAN.md §5): memory learns above 50% on battery;
 * training runs on AC only; scheduled workflows defer below 50%.
 */
export const DEFAULT_POWER_POLICIES = {
  memoryLearning: { requireAC: false, minBatteryPercent: 50, maxThermal: 'fair' },
  training: { requireAC: true, minBatteryPercent: null, maxThermal: 'fair' },
  scheduledWorkflows: { requireAC: false, minBatteryPercent: 50, maxThermal: 'serious' },
} as const satisfies Record<string, PowerPolicy>;

/**
 * The verdict for one reading under one policy. Conservative where the machine
 * could not say: an unknown power source does not count as AC, and an unknown
 * charge does not count as enough.
 */
export function evaluatePowerGate(reading: PowerReading, policy: PowerPolicy): PowerVerdict {
  if (reading.thermal !== null && THERMAL_RANK[reading.thermal] > THERMAL_RANK[policy.maxThermal]) {
    return { allowed: false, reason: `the Mac is running hot (${reading.thermal})` };
  }
  if (reading.onAC === true) return { allowed: true, reason: null };
  if (policy.requireAC) {
    return {
      allowed: false,
      reason: reading.onAC === false ? 'not on AC power' : 'cannot tell whether it is on AC power',
    };
  }
  if (policy.minBatteryPercent === null) return { allowed: true, reason: null };
  if (reading.batteryPercent === null) {
    return { allowed: false, reason: 'cannot read the battery level' };
  }
  if (reading.batteryPercent < policy.minBatteryPercent) {
    return {
      allowed: false,
      reason: `the battery is at ${Math.round(reading.batteryPercent)}% (needs ${policy.minBatteryPercent}%)`,
    };
  }
  return { allowed: true, reason: null };
}

export type PowerReader = () => Promise<PowerReading> | PowerReading;

let reader: PowerReader = () => UNKNOWN_POWER;

/** Install the reader (ACT-01). Returns a function restoring the previous one. */
export function setPowerReader(next: PowerReader): () => void {
  const previous = reader;
  reader = next;
  return () => {
    reader = previous;
  };
}

/** The current reading from whatever reader is installed. */
export async function readPower(): Promise<PowerReading> {
  try {
    return await reader();
  } catch {
    return UNKNOWN_POWER;
  }
}
