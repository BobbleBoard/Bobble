/**
 * WHAT A RUNNING JOB CLAIMS ABOUT ITSELF.
 *
 * Both halves of this were wrong at some point in the same way — the room
 * saying something confident and useless while the engine did work it could not
 * see. "Starting…" for the ninety seconds before step 1, and then, MEASURED on
 * a real 1024² edit, "Step 8 of 8 · about 0s left" for the forty-five seconds
 * of VAE decode and file write after the last one.
 */
import { describe, expect, it } from 'vitest';
import { jobStage, remainingMs } from './StudioRun';

describe('jobStage', () => {
  it('is preparing before any step has landed', () => {
    expect(jobStage({})).toBe('preparing');
    expect(jobStage({ step: 0, total: 0 })).toBe('preparing');
    expect(jobStage({ note: 'loading the model' })).toBe('preparing');
  });

  it('is stepping while there are steps left', () => {
    expect(jobStage({ step: 1, total: 8 })).toBe('stepping');
    expect(jobStage({ step: 7, total: 8 })).toBe('stepping');
  });

  it('is finishing once the last step is done', () => {
    expect(jobStage({ step: 8, total: 8 })).toBe('finishing');
    // A worker that overshoots its own count must not fall back to "stepping".
    expect(jobStage({ step: 9, total: 8 })).toBe('finishing');
  });
});

describe('remainingMs', () => {
  it('says nothing from a single sample', () => {
    expect(remainingMs({ step: 1, total: 8 }, 3000)).toBeUndefined();
  });

  it('extrapolates from the steps that have landed', () => {
    // 2 of 8 in 4s ⇒ 16s total ⇒ 12s left.
    expect(remainingMs({ step: 2, total: 8 }, 4000)).toBe(12_000);
  });

  it('STOPS estimating once the steps are done, rather than saying zero', () => {
    // This is the whole bug: frac is exactly 1 here, so the old arithmetic
    // produced 0 and sat on it while the decode ran.
    expect(remainingMs({ step: 8, total: 8 }, 200_000)).toBeUndefined();
  });

  it('says nothing before there are steps at all', () => {
    expect(remainingMs({}, 90_000)).toBeUndefined();
  });
});
