import { describe, expect, it } from 'vitest';
import { elapsedClock, localStatusView } from './local-status';

const base = {
  phase: 'ready' as const,
  loadedName: 'Qwen3.5 9B',
  pendingName: null,
  elapsedMs: null,
};

describe('elapsedClock', () => {
  it('says nothing for the first second — a 0:00 that sits there reads as stuck', () => {
    expect(elapsedClock(null)).toBeNull();
    expect(elapsedClock(0)).toBeNull();
    expect(elapsedClock(999)).toBeNull();
  });

  it('counts seconds, then minutes', () => {
    expect(elapsedClock(1000)).toBe('0:01');
    expect(elapsedClock(12_400)).toBe('0:12');
    expect(elapsedClock(95_000)).toBe('1:35');
    expect(elapsedClock(600_000)).toBe('10:00');
  });

  it('ignores nonsense rather than rendering NaN at the user', () => {
    expect(elapsedClock(Number.NaN)).toBeNull();
    expect(elapsedClock(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('localStatusView', () => {
  it('leads with the local claim and greys the model name', () => {
    expect(localStatusView(base)).toEqual({
      headline: 'Running on your Mac',
      detail: 'Qwen3.5 9B',
      dot: 'ready',
    });
  });

  /*
   * NO PERCENTAGE WHILE LOADING. The blind tester watched one park at 99% and
   * concluded the app was lying. An elapsed count cannot park.
   */
  it('counts up while the model starts, and never shows a percentage', () => {
    const v = localStatusView({
      phase: 'starting',
      loadedName: null,
      pendingName: 'Qwen3.5 9B',
      elapsedMs: 12_400,
    });
    expect(v.headline).toBe('Starting on your Mac · 0:12');
    expect(v.headline).not.toMatch(/%/);
    expect(v.detail).toBe('Qwen3.5 9B');
    expect(v.dot).toBe('working');
  });

  it('keeps the headline steady before the first second ticks', () => {
    const v = localStatusView({
      ...base,
      phase: 'starting',
      loadedName: null,
      pendingName: 'X',
      elapsedMs: 300,
    });
    expect(v.headline).toBe('Starting on your Mac');
  });

  it('names the download as a download, still local', () => {
    const v = localStatusView({
      phase: 'downloading',
      loadedName: null,
      pendingName: 'Gemma 4 12B',
      elapsedMs: 65_000,
    });
    expect(v.headline).toBe('Downloading to your Mac · 1:05');
    expect(v.dot).toBe('working');
  });

  it('says so when the model failed, without a model id in the headline', () => {
    const v = localStatusView({
      ...base,
      phase: 'error',
      loadedName: null,
      pendingName: 'Qwen3.5 9B',
    });
    expect(v.headline).toBe('Model could not start');
    expect(v.detail).toBe('Qwen3.5 9B');
    expect(v.dot).toBe('error');
  });

  it('still makes the local claim with nothing loaded at all', () => {
    const v = localStatusView({
      phase: 'idle',
      loadedName: null,
      pendingName: null,
      elapsedMs: null,
    });
    expect(v.headline).toBe('Runs on your Mac');
    expect(v.detail).toBe('No model loaded yet');
    expect(v.dot).toBe('off');
  });

  it('does not claim "running" on a ready phase with nothing resident', () => {
    const v = localStatusView({
      phase: 'ready',
      loadedName: null,
      pendingName: 'Qwen3.5 9B',
      elapsedMs: null,
    });
    expect(v.headline).toBe('Runs on your Mac');
    expect(v.dot).toBe('off');
  });
});
