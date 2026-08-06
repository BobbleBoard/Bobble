/**
 * The memory guard: refuse a model that would take the whole machine down.
 *
 * the user, while a 27B was coming up on a 24GB Mac: "whole computer now has lots of
 * lag and purple flashes on parts of the screen, stuttering of mouse cursor etc.
 * not good, checkerboardings..." — then: "we should have guards in place to
 * ensure based on available memory we're not straining anything to a dangerous
 * point."
 */
import { describe, expect, it } from 'vitest';
import { modelFitsInRam } from './model-fit';

const GB = 1024 ** 3;

describe('modelFitsInRam', () => {
  it('ALLOWS one 27B on a 24GB machine — a single one genuinely fits', () => {
    /*
     * Correcting my own first diagnosis. The desktop stutter came from TWO
     * 27B servers racing up, not from one being too big: 24 − 2 = 22GB, and the
     * model is ~16GB. Sizing the guard to catch the race would punish every
     * legitimate large-model user for a bug that lives in the start path.
     */
    expect(modelFitsInRam(16.5 * GB, 24 * GB).ok).toBe(true);
  });

  it('refuses a model that cannot fit alongside the OS at all', () => {
    const res = modelFitsInRam(30 * GB, 24 * GB);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('swap');
    // The message has to say what to DO, not just that it failed.
    expect(res.reason).toContain('smaller model');
  });

  it('allows a big model on a machine built for it', () => {
    expect(modelFitsInRam(16.5 * GB, 64 * GB).ok).toBe(true);
    expect(modelFitsInRam(45 * GB, 128 * GB).ok).toBe(true);
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
