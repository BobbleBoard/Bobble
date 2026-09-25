import { describe, expect, it } from 'vitest';
import { coversDrawing, DRAW_IN_MOST, DRAW_IN_MS, drawInPlan } from './svg-draw-in';

describe('drawInPlan — a small drawing drawing itself in', () => {
  it('draws lines along their length in the pen’s order, and fades fills a beat behind', () => {
    const plan = drawInPlan([
      { line: true, length: 100 },
      { line: false, length: 0 },
      { line: true, length: 40 },
    ]);
    expect(plan?.map((s) => s.kind)).toEqual(['draw', 'fade', 'draw']);
    const [a, b, c] = plan ?? [];
    expect(a).toMatchObject({ kind: 'draw', delay: 0, length: 100 });
    expect(c?.delay).toBeGreaterThan(a?.delay ?? 0);
    // The fill comes a little after the line before it.
    expect(b?.delay).toBeGreaterThan(a?.delay ?? 0);
  });

  it('finishes inside DRAW_IN_MS however many shapes there are', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ line: i % 2 === 0, length: 50 }));
    const plan = drawInPlan(many) ?? [];
    for (const s of plan) expect(s.delay + s.dur).toBeLessThanOrEqual(DRAW_IN_MS);
  });

  it('the paper the drawing is on is simply there, and the first line draws at once', () => {
    const plan = drawInPlan([
      { line: false, length: 0, backdrop: true },
      { line: true, length: 80 },
      { line: false, length: 0 },
    ]);
    expect(plan?.map((s) => [s.kind, s.index])).toEqual([
      ['draw', 1],
      ['fade', 2],
    ]);
    expect(plan?.[0]?.delay).toBe(0);
    expect(drawInPlan([{ line: false, length: 0, backdrop: true }])).toEqual([]);
    // A fill over nearly all of the drawing is its paper; a big shape is not.
    expect(coversDrawing({ width: 240, height: 200 }, { width: 240, height: 200 })).toBe(true);
    expect(coversDrawing({ width: 236, height: 196 }, { width: 240, height: 200 })).toBe(true);
    expect(coversDrawing({ width: 200, height: 160 }, { width: 240, height: 200 })).toBe(false);
    expect(coversDrawing({ width: 10, height: 10 }, { width: 0, height: 0 })).toBe(false);
  });

  it('a line too short to draw fades instead; past the limit the drawing fades in whole', () => {
    expect(drawInPlan([{ line: true, length: 0.5 }])?.[0]?.kind).toBe('fade');
    expect(
      drawInPlan(Array.from({ length: DRAW_IN_MOST + 1 }, () => ({ line: true, length: 9 }))),
    ).toBeNull();
    expect(drawInPlan([])).toEqual([]);
  });
});
