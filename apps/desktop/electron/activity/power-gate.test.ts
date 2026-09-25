import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POWER_POLICIES,
  evaluatePowerGate,
  readPower,
  setPowerReader,
  UNKNOWN_POWER,
} from './power-gate';

const policy = DEFAULT_POWER_POLICIES;

describe('evaluatePowerGate', () => {
  it('lets everything run on AC in a cool machine', () => {
    for (const p of Object.values(policy)) {
      expect(evaluatePowerGate({ onAC: true, batteryPercent: 5, thermal: 'nominal' }, p)).toEqual({
        allowed: true,
        reason: null,
      });
    }
  });

  it('keeps training to AC, and says why', () => {
    expect(
      evaluatePowerGate({ onAC: false, batteryPercent: 99, thermal: null }, policy.training),
    ).toEqual({ allowed: false, reason: 'not on AC power' });
    expect(evaluatePowerGate(UNKNOWN_POWER, policy.training).allowed).toBe(false);
  });

  it('lets memory learn on battery above half, not below', () => {
    const at = (pct: number) =>
      evaluatePowerGate({ onAC: false, batteryPercent: pct, thermal: null }, policy.memoryLearning);
    expect(at(80).allowed).toBe(true);
    expect(at(50).allowed).toBe(true);
    expect(at(49)).toEqual({ allowed: false, reason: 'the battery is at 49% (needs 50%)' });
  });

  it('treats an unreadable battery as not enough', () => {
    expect(
      evaluatePowerGate(
        { onAC: false, batteryPercent: null, thermal: null },
        policy.scheduledWorkflows,
      ).allowed,
    ).toBe(false);
  });

  it('holds back on a hot machine even on AC', () => {
    expect(
      evaluatePowerGate({ onAC: true, batteryPercent: 100, thermal: 'serious' }, policy.training),
    ).toEqual({ allowed: false, reason: 'the Mac is running hot (serious)' });
    // Workflows tolerate one step more.
    expect(
      evaluatePowerGate(
        { onAC: true, batteryPercent: 100, thermal: 'serious' },
        policy.scheduledWorkflows,
      ).allowed,
    ).toBe(true);
  });
});

describe('the reader seam', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it('reads unknown until a reader is installed, and survives one that throws', async () => {
    expect(await readPower()).toEqual(UNKNOWN_POWER);
    restore = setPowerReader(() => ({ onAC: true, batteryPercent: 80, thermal: 'nominal' }));
    expect((await readPower()).onAC).toBe(true);
    restore();
    restore = setPowerReader(() => {
      throw new Error('pmset missing');
    });
    expect(await readPower()).toEqual(UNKNOWN_POWER);
  });
});
