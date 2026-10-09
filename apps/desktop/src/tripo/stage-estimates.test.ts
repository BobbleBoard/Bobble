/**
 * The estimates have to be honest in the direction that matters.
 *
 * An estimate that runs UNDER is a broken promise; one that runs over is a
 * pleasant surprise. So the scaling is clamped to never promise a slower
 * machine the reference machine's time, and the phrasing rounds coarsely rather
 * than pretending to a precision these stages do not have.
 */
import { describe, expect, it } from 'vitest';
import { estimateSeconds, formatEstimate, machineFactor, stageKey } from './stage-estimates';

const GB = 1024 ** 3;

describe('stage estimates', () => {
  it('never promises a smaller machine the reference machine, and never panics it', () => {
    expect(machineFactor(24 * GB)).toBeCloseTo(1, 5);
    expect(machineFactor(8 * GB)).toBeGreaterThan(1);
    expect(machineFactor(8 * GB)).toBeLessThanOrEqual(3);
    // A bigger machine is not promised a bonus — the numbers were measured on
    // the reference and we do not have measurements from a Max or Ultra.
    expect(machineFactor(128 * GB)).toBe(1);
  });

  it('survives a machine that did not report its memory', () => {
    expect(machineFactor(0)).toBe(1);
    expect(machineFactor(Number.NaN)).toBe(1);
  });

  it('knows the stages that actually take minutes', () => {
    const mem = 24 * GB;
    expect(estimateSeconds({ key: 'segment', totalMemoryBytes: mem })).toBeGreaterThan(500);
    expect(estimateSeconds({ key: 'generate:medium', totalMemoryBytes: mem })).toBeGreaterThan(
      estimateSeconds({ key: 'generate:low', totalMemoryBytes: mem }) ?? 0,
    );
    expect(estimateSeconds({ key: 'not-a-stage', totalMemoryBytes: mem })).toBeNull();
  });

  it('scales the mesh-walking stages with the mesh', () => {
    const mem = 24 * GB;
    const small = estimateSeconds({ key: 'retopo', totalMemoryBytes: mem, faces: 50_000 }) ?? 0;
    const large = estimateSeconds({ key: 'retopo', totalMemoryBytes: mem, faces: 900_000 }) ?? 0;
    expect(large).toBeGreaterThan(small);
    // Damped, not linear: model load and unwrap do not scale with face count.
    expect(large / small).toBeLessThan(18);
  });

  /* The user (2026-09-15): the quick low-poly is seconds, and the button must say
     so instead of promising the remesh's minutes. MEASURED 7.6 s on a 186k jet. */
  it('the quick retopology is a seconds estimate, whatever the mesh', () => {
    const mem = 24 * GB;
    expect(stageKey('retopo', { quick: true })).toBe('retopo:quick');
    expect(stageKey('retopo')).toBe('retopo');
    const quick = estimateSeconds({ key: 'retopo:quick', totalMemoryBytes: mem, faces: 900_000 });
    expect(quick).not.toBeNull();
    expect(quick ?? 0).toBeLessThan(45);
    expect(formatEstimate(quick)).toBe('about 30 sec');
  });

  it('leaves the stages whose cost is fixed alone', () => {
    const mem = 24 * GB;
    const a = estimateSeconds({ key: 'rig:template', totalMemoryBytes: mem, faces: 10_000 });
    const b = estimateSeconds({ key: 'rig:template', totalMemoryBytes: mem, faces: 900_000 });
    expect(a).toBe(b);
  });

  it('phrases it as a promise someone can hold you to', () => {
    expect(formatEstimate(20)).toBe('about 30 sec');
    expect(formatEstimate(60)).toBe('about a minute');
    expect(formatEstimate(180)).toBe('about 3 min');
    expect(formatEstimate(660)).toBe('about 10 min');
    expect(formatEstimate(null)).toBeNull();
    expect(formatEstimate(0)).toBeNull();
  });

  it('picks the right key for how the stage will actually run', () => {
    expect(stageKey('texture', { painting: true })).toBe('texture:paint');
    expect(stageKey('texture', { painting: false })).toBe('texture:rebake');
    expect(stageKey('rig', { rigger: 'skintokens' })).toBe('rig:skintokens');
    expect(stageKey('rig')).toBe('rig:template');
    expect(stageKey('segment')).toBe('segment');
  });
});
