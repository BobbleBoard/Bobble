import { describe, expect, it } from 'vitest';
import {
  CONTEXT_CEILING,
  CONTEXT_FLOOR,
  chooseContextCap,
  estimateLaunchRamGB,
  liveMemoryFraction,
} from './context-cap.js';

const GiB = 1024 ** 3;

describe('estimateLaunchRamGB', () => {
  it('scales the KV term with the slot count (weights stay resident once)', () => {
    const one = estimateLaunchRamGB(4 * GiB, 32_768, 1);
    const four = estimateLaunchRamGB(4 * GiB, 32_768, 4);
    // Single slot at 32k: 4 (weights) + 4·(32768/32768)·0.2 (=0.8 KV) + 1 = 5.8.
    expect(one).toBeCloseTo(5.8, 5);
    // 4 slots add 3 more KV caches of 0.8 each = +2.4; weights+overhead unchanged.
    expect(four - one).toBeCloseTo(2.4, 5);
  });
});

describe('chooseContextCap', () => {
  it('lands at the ~64k ceiling for a small model on a roomy machine', () => {
    expect(
      chooseContextCap({ modelBytes: 4 * GiB, modelMaxContext: 131_072, totalRamGB: 32 }),
    ).toBe(CONTEXT_CEILING);
  });

  it('never exceeds the model`s own max context', () => {
    expect(
      chooseContextCap({ modelBytes: 4 * GiB, modelMaxContext: 32_768, totalRamGB: 128 }),
    ).toBe(32_768);
  });

  it('steps DOWN for a big model on a tight machine (KV-aware)', () => {
    const cap = chooseContextCap({
      modelBytes: 17 * GiB,
      modelMaxContext: 131_072,
      totalRamGB: 24,
    });
    expect(cap).toBeLessThan(CONTEXT_CEILING);
    expect(cap).toBeGreaterThanOrEqual(CONTEXT_FLOOR);
  });

  it('gives each subagent slot a SMALLER window than a single slot (KV × slots)', () => {
    const single = chooseContextCap({
      modelBytes: 4 * GiB,
      modelMaxContext: 131_072,
      totalRamGB: 16,
      slots: 1,
    });
    const fan = chooseContextCap({
      modelBytes: 4 * GiB,
      modelMaxContext: 131_072,
      totalRamGB: 16,
      slots: 8,
    });
    expect(fan).toBeLessThan(single);
    expect(fan).toBeGreaterThanOrEqual(CONTEXT_FLOOR);
  });

  it('falls back to the floor when even the smallest step does not fit', () => {
    expect(
      chooseContextCap({ modelBytes: 30 * GiB, modelMaxContext: 131_072, totalRamGB: 8 }),
    ).toBe(CONTEXT_FLOOR);
  });

  it('treats unknown RAM (0) as unbounded → the ceiling', () => {
    expect(chooseContextCap({ modelBytes: 4 * GiB, modelMaxContext: 131_072, totalRamGB: 0 })).toBe(
      CONTEXT_CEILING,
    );
  });
});

describe("liveMemoryFraction — the launch keeps the guardian's pause line clear", () => {
  // Qwen 3.8 27B UD-Q3_K_XL as launched on a 24 GB Mac (2026-10-02): 82% free
  // before the load, the guardian pausing at 15%, the reserve's own 0.833.
  const QWEN38 = { modelBytes: 13_146_393_504, modelMaxContext: 262_144, totalRamGB: 24 };

  it('steps the 27B down from the 64k window that left 14% free', () => {
    expect(chooseContextCap({ ...QWEN38, memoryFraction: 0.8333 })).toBe(65_536);
    const live = liveMemoryFraction(0.82, 0.15);
    expect(live).toBeCloseTo(0.67);
    expect(chooseContextCap({ ...QWEN38, memoryFraction: Math.min(0.8333, live ?? 1) })).toBe(
      32_768,
    );
  });

  it('is no ceiling without a reading, and never negative', () => {
    expect(liveMemoryFraction(undefined, 0.15)).toBeUndefined();
    expect(liveMemoryFraction(Number.NaN, 0.15)).toBeUndefined();
    expect(liveMemoryFraction(0.1, 0.15)).toBe(0);
  });
});
