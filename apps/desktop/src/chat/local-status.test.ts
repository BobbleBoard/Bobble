import { describe, expect, it } from 'vitest';
import { elapsedClock, localStatusView } from './local-status';

const base = {
  phase: 'ready' as const,
  loadedName: 'Qwen3.5 9B',
  pendingName: null,
  elapsedMs: null,
  prefixWarming: false,
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
  /*
   * THE DOT MUST NOT GO GREEN BEFORE THE APP CAN ANSWER.
   *
   * MEASURED: the server reaches `ready` at ~3.5s and the system prompt takes
   * another 11,552ms to become resident. The first cut said "Running on your
   * Mac", in green, for that whole window. The tester: "You've added a
   * component whose job is to reassure me, and it reassures me hardest during
   * the one moment I most doubt the app."
   */
  it('does NOT claim to be running while the prompt is still being read', () => {
    const v = localStatusView({ ...base, prefixWarming: true, elapsedMs: 7_000 });
    expect(v.headline).toBe('Getting ready · 0:07');
    expect(v.dot).toBe('working');
    expect(v.headline).not.toMatch(/Running/);
    expect(v.headline).not.toMatch(/%/);
  });

  it('goes green the moment the prompt is in — which is the moment a message is instant', () => {
    expect(localStatusView({ ...base, prefixWarming: false }).dot).toBe('ready');
  });

  it('behaves as before in a build that never publishes the signal', () => {
    // `prefixWarming: false` is what an absent status resolves to; the badge
    // must not hold "Getting ready" open waiting for something never coming.
    expect(localStatusView({ ...base }).headline).toBe('Running on your Mac');
  });

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
      prefixWarming: false,
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
      prefixWarming: false,
    });
    expect(v.headline).toBe('Starting on your Mac');
  });

  it('names the download as a download, still local', () => {
    const v = localStatusView({
      phase: 'downloading',
      loadedName: null,
      pendingName: 'Gemma 4 12B',
      elapsedMs: 65_000,
      prefixWarming: false,
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
      prefixWarming: false,
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
      prefixWarming: false,
    });
    expect(v.headline).toBe('Runs on your Mac');
    expect(v.detail).toBe('No model loaded yet');
    expect(v.dot).toBe('off');
  });

  /*
   * THE 16px JUMP. The download stress probe caught this within the hour of the
   * badge shipping: `div#3(1) shifted 16px`, in the two moments a download goes
   * wrong — a missing file and a dropped connection. One caption line. The model
   * name went momentarily unknown, the second line unmounted, and the whole
   * sidebar below it moved — which is precisely the "the app changed underneath
   * me without me touching it" complaint this badge was built to answer.
   */
  it('ALWAYS has words in the grey line, in every state, whatever is known', () => {
    for (const phase of ['idle', 'downloading', 'starting', 'ready', 'error'] as const) {
      for (const loadedName of [null, 'Qwen3.5 9B']) {
        for (const pendingName of [null, 'Gemma 4 12B']) {
          for (const elapsedMs of [null, 0, 30_000]) {
            const v = localStatusView({
              phase,
              loadedName,
              pendingName,
              elapsedMs,
              prefixWarming: false,
            });
            expect(v.detail.length, `${phase}/${loadedName}/${pendingName}`).toBeGreaterThan(0);
            expect(v.headline.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('does not claim "running" on a ready phase with nothing resident', () => {
    const v = localStatusView({
      phase: 'ready',
      loadedName: null,
      pendingName: 'Qwen3.5 9B',
      elapsedMs: null,
      prefixWarming: false,
    });
    expect(v.headline).toBe('Runs on your Mac');
    expect(v.dot).toBe('off');
  });
});
