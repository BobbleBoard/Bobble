/**
 * The live policy: hysteresis across real readings, and the two questions that
 * decide which wall a machine is nearest.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifyBottleneck, createPowerManager, powerBudgetGB } from './power-manager.js';
import type { PressureProbes } from './pressure.js';

const probesFor = (level: () => string): PressureProbes => ({
  run: async (cmd, args) => {
    if (cmd === 'sysctl' && args.includes('kern.memorystatus_vm_pressure_level')) return level();
    return null;
  },
  readFile: async () => null,
  loadAvg: () => [1, 1, 1],
  cpuCount: 8,
  memory: () => ({ total: 24e9, free: 12e9 }),
  platform: 'darwin',
});

describe('classifying the machine', () => {
  it('calls a card with its own memory discrete — the wall is separate and hard', () => {
    expect(classifyBottleneck({ unifiedMemory: false, gpus: [{ vramGB: 24 }] })).toBe('discrete');
    expect(powerBudgetGB({ unifiedMemory: false, totalRamGB: 64, gpus: [{ vramGB: 24 }] })).toBe(
      24,
    );
  });

  it('calls an Apple GPU unified — it is competing with the OS for the same pages', () => {
    expect(classifyBottleneck({ unifiedMemory: true, gpus: [{}] })).toBe('unified');
    expect(powerBudgetGB({ unifiedMemory: true, totalRamGB: 24, gpus: [{}] })).toBe(24);
  });

  it('calls no GPU at all cpu — which is a real configuration, not an error', () => {
    expect(classifyBottleneck({ unifiedMemory: false, gpus: [] })).toBe('cpu');
    expect(powerBudgetGB({ unifiedMemory: false, totalRamGB: 16, gpus: [] })).toBe(16);
  });

  it('does not mistake an iGPU reporting no VRAM for a discrete card', () => {
    expect(classifyBottleneck({ unifiedMemory: false, gpus: [{}] })).toBe('unified');
  });
});

describe('the manager', () => {
  it('starts at full before it has measured anything', () => {
    const m = createPowerManager({
      probes: probesFor(() => '1'),
      bottleneck: 'unified',
      budgetGB: 24,
    });
    expect(m.current().level).toBe('full');
    expect(m.lastPressure()).toBeNull();
  });

  it('steps down on a bad reading and back up only after several calm ones', async () => {
    let level = '1';
    const onChange = vi.fn();
    const m = createPowerManager({
      probes: probesFor(() => level),
      bottleneck: 'unified',
      budgetGB: 24,
      onChange,
    });
    await m.sample();
    expect(m.current().level).toBe('full');

    level = '4';
    await m.sample();
    expect(m.current().level).toBe('gentle');
    expect(onChange).toHaveBeenCalledTimes(1);

    level = '1';
    for (let i = 0; i < 3; i++) {
      await m.sample();
      expect(m.current().level).toBe('gentle');
    }
    await m.sample();
    expect(m.current().level).toBe('full');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('survives a probe that throws, and treats it as "would not say"', async () => {
    const m = createPowerManager({
      probes: {
        ...probesFor(() => '1'),
        run: async () => {
          throw new Error('sysctl exploded');
        },
      },
      bottleneck: 'unified',
      budgetGB: 24,
    });
    await expect(m.sample()).resolves.toBeDefined();
    expect(m.current().level).toBe('full');
  });

  it('re-decides at once when the user changes the mode', async () => {
    const m = createPowerManager({
      probes: probesFor(() => '1'),
      bottleneck: 'unified',
      budgetGB: 24,
    });
    expect((await m.setMode('low')).level).toBe('gentle');
    expect((await m.setMode('full')).level).toBe('full');
  });

  it('re-decides at once when the reserve changes', async () => {
    const m = createPowerManager({
      probes: probesFor(() => '1'),
      bottleneck: 'unified',
      budgetGB: 24,
    });
    const before = m.current().memoryFraction;
    const after = (await m.setReserveGB(12)).memoryFraction;
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(0.5, 2);
  });
});
