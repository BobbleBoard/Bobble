import { describe, expect, it } from 'vitest';
import { idleWave, WAVE_BUCKETS } from './audio-peaks';

/*
 * The pulsing waveform is a STAND-IN for a measurement that does not exist yet,
 * and the two failure modes of a stand-in are both testable: it must not look
 * like data (or someone will read it as the shape of their sound), and it must
 * not move on its own (or the bars twitch sideways under an animation whose
 * whole point is a wave travelling ALONG them).
 */
describe('the waveform shown while a sound is being made', () => {
  it('has exactly as many bars as the real transport', () => {
    // Load-bearing: the resolve is a height change on bars that never move, so
    // the placeholder and the finished waveform must have the same bars.
    expect(idleWave()).toHaveLength(WAVE_BUCKETS);
    expect(idleWave(24)).toHaveLength(24);
  });

  it('is identical every time it is computed', () => {
    // `Math.random()` here would re-roll on every re-render — the bars would
    // jump on any state change, which is the one thing a "resolving" animation
    // must not do.
    expect(idleWave(32)).toEqual(idleWave(32));
  });

  it('never touches either extreme, so it cannot be mistaken for a reading', () => {
    for (const v of idleWave()) {
      expect(v).toBeGreaterThan(0.05);
      expect(v).toBeLessThan(1);
    }
  });

  it('fades in at both ends, so it reads as a clip and not a bar chart', () => {
    const w = idleWave();
    const mid = w.slice(WAVE_BUCKETS / 2 - 6, WAVE_BUCKETS / 2 + 6);
    const meanMid = mid.reduce((a, b) => a + b, 0) / mid.length;
    expect(w[0]).toBeLessThan(meanMid);
    expect(w[WAVE_BUCKETS - 1]).toBeLessThan(meanMid);
  });

  it('varies bar to bar rather than sitting on one level', () => {
    const w = idleWave();
    expect(new Set(w.map((v) => Math.round(v * 50))).size).toBeGreaterThan(8);
  });
});
