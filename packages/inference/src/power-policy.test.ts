/**
 * The policy, exercised as four different machines under four different kinds of
 * strain — because "handle a range of hardware and a range of situations and
 * bottlenecks" (the user) is the requirement, and a policy that has only ever been
 * reasoned about on one Mac is a policy about one Mac.
 */
import { describe, expect, it } from 'vitest';
import {
  decidePower,
  defaultReserveGB,
  type PowerInputs,
  type PowerLevel,
  pressureSeverity,
  RECOVERY_READINGS,
  reserveToFraction,
} from './power-policy.js';
import type { SystemPressure } from './pressure.js';

const calm: SystemPressure = { memory: 'normal', swapUsed: 0, cpu: 0.1, sources: ['x'] };

const at = (over: Partial<PowerInputs>): PowerInputs => ({
  mode: 'auto',
  pressure: calm,
  bottleneck: 'unified',
  budgetGB: 24,
  cpuCount: 12,
  ...over,
});

describe('the reserve', () => {
  it('is a quarter of the machine, but neither greedy nor useless at the extremes', () => {
    // An 8 GB laptop cannot spare 25% and still run anything…
    expect(defaultReserveGB(8)).toBe(2);
    expect(defaultReserveGB(16)).toBe(4);
    expect(defaultReserveGB(24)).toBe(6);
    // …and a workstation does not need 32 GB held back for a text editor.
    expect(defaultReserveGB(128)).toBe(8);
  });

  it('becomes the fraction of the budget a launch may take', () => {
    expect(reserveToFraction(24, 6)).toBeCloseTo(0.75, 2);
    expect(reserveToFraction(8, 2)).toBeCloseTo(0.75, 2);
    // A reserve bigger than the machine cannot mean "use nothing".
    expect(reserveToFraction(4, 8)).toBe(0.3);
  });
});

describe('what counts as pressure depends on the wall', () => {
  /*
   * The rule that a live run caught. MEASURED on a 24 GB Mac: 65% of swap in
   * use, pressure level 1, and the swap counters not moving in three seconds —
   * a stock accumulated over days of uptime, not a machine in trouble.
   */
  it('does NOT call a full swap file pressure when nothing is actually moving', () => {
    const idleButSwapped: SystemPressure = {
      memory: 'normal',
      swapUsed: 0.65,
      swapIoPerSec: 0,
      sources: [],
    };
    expect(pressureSeverity(idleButSwapped, 'unified')).toBe(0);
  });

  /*
   * The numbers come from a real ramp, not from taste. MEASURED on a 24 GB Mac
   * holding 8 GB of incompressible memory: background housekeeping ran 0–71
   * pages/sec, actual thrashing 8,804–63,157. The thresholds sit in the gap.
   */
  it('ignores the background housekeeping every machine does', () => {
    const idle: SystemPressure = { memory: 'normal', swapIoPerSec: 71, sources: [] };
    expect(pressureSeverity(idle, 'unified')).toBe(0);
  });

  it('does call actual thrashing pressure', () => {
    const thrashing: SystemPressure = { memory: 'normal', swapIoPerSec: 8804, sources: [] };
    expect(pressureSeverity(thrashing, 'unified')).toBe(2);
    expect(pressureSeverity({ ...thrashing, swapIoPerSec: 600 }, 'unified')).toBe(1);
    // A desktop with a 4090 swapping is not a reason to trim its VRAM.
    expect(pressureSeverity(thrashing, 'discrete')).toBe(0);
  });

  it('lets a full swap file sharpen a warning the OS has already raised', () => {
    const warned: SystemPressure = { memory: 'warn', sources: [] };
    expect(pressureSeverity(warned, 'unified')).toBe(1);
    expect(pressureSeverity({ ...warned, swapUsed: 0.6 }, 'unified')).toBe(2);
    expect(pressureSeverity({ ...warned, swapIoPerSec: 8804 }, 'unified')).toBe(2);
  });

  it('treats a nearly-full card as urgent — one layer from spilling to the host', () => {
    expect(pressureSeverity({ vram: 0.92, sources: [] }, 'discrete')).toBe(2);
    expect(pressureSeverity({ vram: 0.8, sources: [] }, 'discrete')).toBe(1);
    expect(pressureSeverity({ vram: 0.5, sources: [] }, 'discrete')).toBe(0);
  });

  it('notices somebody else using the GPU — the one case we can actually see', () => {
    expect(pressureSeverity({ gpu: 0.85, sources: [] }, 'discrete')).toBe(1);
  });

  it('takes the OS at its word when it is throttling', () => {
    expect(pressureSeverity({ throttled: true, sources: [] }, 'unified')).toBe(1);
  });

  it('meets a machine heading for trouble on the way, not after', () => {
    // The OS's own free-memory percentage is continuous, so falling headroom is
    // visible before the coarse verdict flips.
    expect(pressureSeverity({ memory: 'normal', memoryFree: 0.76, sources: [] }, 'unified')).toBe(
      0,
    );
    expect(pressureSeverity({ memory: 'normal', memoryFree: 0.2, sources: [] }, 'unified')).toBe(1);
    expect(pressureSeverity({ memory: 'normal', memoryFree: 0.08, sources: [] }, 'unified')).toBe(
      2,
    );
  });

  it('says nothing is wrong when nothing answered — absence is not alarm', () => {
    expect(pressureSeverity({ sources: [] }, 'unified')).toBe(0);
  });
});

describe('the lever matches the machine', () => {
  it('has no clock knob on unified memory, so every lever is a memory lever', () => {
    const d = decidePower(at({ mode: 'low', bottleneck: 'unified' }));
    expect(d.quantizeKv).toBe(true);
    expect(d.maxParallel).toBe(1);
    expect(d.threads).toBeUndefined(); // MEASURED useless on Metal
    expect(d.keepKvOnHost).toBeUndefined();
    expect(d.allowHeavyJobs).toBe(false);
  });

  it('gives VRAM back BEFORE a discrete card spills', () => {
    const d = decidePower(at({ mode: 'low', bottleneck: 'discrete', budgetGB: 24 }));
    expect(d.keepKvOnHost).toBe(true);
    expect(d.quantizeKv).toBe(true);
    expect(d.reason).toContain('spill');
    // Not `-ngl`: the catalog carries no layer count, so a fraction of the
    // layers would be a guess wearing a flag's clothes.
    expect(d.threads).toBeUndefined();
  });

  it('reaches for the milder VRAM lever first', () => {
    const easing = decidePower(
      at({ bottleneck: 'discrete', pressure: { vram: 0.8, sources: [] } }),
    );
    expect(easing.level).toBe('easy');
    expect(easing.quantizeKv).toBe(true);
    expect(easing.keepKvOnHost).toBeUndefined();
  });

  it('leaves the user some cores when the machine is CPU-bound', () => {
    const d = decidePower(at({ mode: 'low', bottleneck: 'cpu', cpuCount: 8 }));
    expect(d.threads).toBe(4);
    expect(d.reason).toContain('4 of 8 cores');
  });

  it('never asks for zero threads on a single-core box', () => {
    expect(decidePower(at({ mode: 'low', bottleneck: 'cpu', cpuCount: 1 })).threads).toBe(1);
  });

  it('always explains itself', () => {
    for (const bottleneck of ['unified', 'discrete', 'cpu'] as const) {
      for (const mode of ['full', 'auto', 'low'] as const) {
        expect(decidePower(at({ mode, bottleneck })).reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('auto', () => {
  it('is full speed on a calm machine, holding the reserve back', () => {
    const d = decidePower(at({}));
    expect(d.level).toBe('full');
    expect(d.memoryFraction).toBeCloseTo(0.75, 2);
    expect(d.reason).toContain('6 GB');
  });

  it('steps down the moment a reading is bad', () => {
    const d = decidePower(at({ pressure: { memory: 'critical', sources: [] } }));
    expect(d.level).toBe('gentle');
    expect(d.allowHeavyJobs).toBe(false);
  });

  it('eases off by one step on battery even when nothing is complaining', () => {
    const d = decidePower(at({ pressure: { ...calm, onBattery: true } }));
    expect(d.level).toBe('easy');
    expect(d.backgroundPriority).toBe(true);
  });

  /*
   * The asymmetry is the point. Readings are noisy, and a policy that flips back
   * the instant one looks good changes the launch config repeatedly — each change
   * costing a cold prefill, which is worse than either state it flapped between.
   */
  it('needs several calm readings to come back up, and one bad one to leave', () => {
    let previous: PowerLevel = 'gentle';
    let calmStreak = 0;
    for (let i = 1; i < RECOVERY_READINGS; i++) {
      const d = decidePower(at({ previous, calmStreak }));
      expect(d.level).toBe('gentle');
      previous = d.level;
      calmStreak = d.calmStreak;
    }
    const recovered = decidePower(at({ previous, calmStreak }));
    expect(recovered.level).toBe('full');
    // …and one bad reading undoes it immediately.
    const back = decidePower(
      at({ previous: recovered.level, pressure: { memory: 'critical', sources: [] } }),
    );
    expect(back.level).toBe('gentle');
    expect(back.calmStreak).toBe(0);
  });

  it('holds the line while pressure persists rather than counting toward recovery', () => {
    const bad = { memory: 'warn' as const, sources: [] };
    let previous: PowerLevel = 'easy';
    let calmStreak = 0;
    for (let i = 0; i < 10; i++) {
      const d = decidePower(at({ previous, pressure: bad, calmStreak }));
      expect(d.level).toBe('easy');
      previous = d.level;
      calmStreak = d.calmStreak;
    }
  });
});

describe('the manual modes ignore the readings, which is what manual means', () => {
  it('full stays full under critical pressure', () => {
    const d = decidePower(at({ mode: 'full', pressure: { memory: 'critical', sources: [] } }));
    expect(d.level).toBe('full');
    expect(d.allowHeavyJobs).toBe(true);
  });

  it('low stays low on an idle machine', () => {
    expect(decidePower(at({ mode: 'low' })).level).toBe('gentle');
  });
});
