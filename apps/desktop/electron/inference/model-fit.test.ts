/**
 * The memory guard: refuse a model that would take the whole machine down.
 *
 * The user, while a 27B was coming up on a 24GB Mac: "whole computer now has lots of
 * lag and purple flashes on parts of the screen, stuttering of mouse cursor etc.
 * not good, checkerboardings..." — then: "we should have guards in place to
 * ensure based on available memory we're not straining anything to a dangerous
 * point."
 */
import { describe, expect, it } from 'vitest';
import { modelFitsInRam } from './model-fit';

const GB = 1024 ** 3;

describe('modelFitsInRam', () => {
  it('refuses a 27B on a 24GB machine — MEASURED, it does not fit', () => {
    /*
     * I claimed twice that one 27B fits on 24GB. It does not. 17.1GB of weights
     * leaves ~7GB for Electron, the renderer, the pi child, the role sessions
     * and the KV cache: swap hit 5.4GB, free memory 17%, and the turn produced
     * nothing. The reserve is 7GiB now because that is what the run measured,
     * not because it sounded safe.
     */
    const res = modelFitsInRam(17.1 * GB, 24 * GB);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('swap');
    // The message has to say what to DO, not just that it failed.
    expect(res.reason).toContain('smaller model');
  });

  it('allows a big model on a machine built for it', () => {
    expect(modelFitsInRam(17.1 * GB, 64 * GB).ok).toBe(true);
    expect(modelFitsInRam(45 * GB, 128 * GB).ok).toBe(true);
  });

  it('still allows every tier the recommender ships at 24GB and below', () => {
    // A guard that blocks the app's own defaults is worse than no guard.
    expect(modelFitsInRam(4.6 * GB, 8 * GB).ok).toBe(true); // 4B Q8, 8GB tier
    expect(modelFitsInRam(6.6 * GB, 16 * GB).ok).toBe(true); // gemma-12B, 16GB tier
    expect(modelFitsInRam(6.6 * GB, 24 * GB).ok).toBe(true); // gemma-12B, 24GB balanced
    expect(modelFitsInRam(5.5 * GB, 24 * GB).ok).toBe(true); // qwen 9B
  });

  it('allows every tier the recommender itself ships', () => {
    // qwen3.5-4b Q8_0 ≈ 4.6GB IS the recommender's 8GB-tier pick. A guard that
    // blocks the app's own default configuration is worse than no guard.
    expect(modelFitsInRam(4.6 * GB, 8 * GB).ok).toBe(true);
    expect(modelFitsInRam(4.6 * GB, 16 * GB).ok).toBe(true);
    expect(modelFitsInRam(4.6 * GB, 24 * GB).ok).toBe(true);
  });

  it('never blocks on unknown sizes — a guard that guesses is worse than none', () => {
    expect(modelFitsInRam(0, 24 * GB).ok).toBe(true);
    expect(modelFitsInRam(Number.NaN, 24 * GB).ok).toBe(true);
    expect(modelFitsInRam(8 * GB, 0).ok).toBe(true);
  });
});
