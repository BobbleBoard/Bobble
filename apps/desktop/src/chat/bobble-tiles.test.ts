import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOBBLE_CELLS, BOBBLE_TILES, bobbleLap, TILE_SCHEDULE, tileAt } from './bobble-tiles';

/*
 * A SLIDING PUZZLE HAS A RULE, so it can be broken.
 *
 * The user asked for the app mark's three squares to slide clockwise "like a sliding
 * tile puzzle". What separates that from three squares orbiting a point is
 * exactly this: only the tile beside the hole moves, it moves into the hole, and
 * it moves to an ADJACENT cell. Two tiles in one cell, or a tile crossing the
 * board diagonally, reads as a rendering bug rather than as a puzzle — and
 * neither is reliably visible in a still.
 *
 * So the whole cycle is played out here, a fifth of a beat at a time.
 */

const CELL_IDS = BOBBLE_CELLS.map((c) => c.id);

/** Cells adjacent on the board (a slide crosses one edge, never a corner). */
function adjacent(a: string, b: string): boolean {
  const i = CELL_IDS.indexOf(a as (typeof CELL_IDS)[number]);
  const j = CELL_IDS.indexOf(b as (typeof CELL_IDS)[number]);
  if (i === -1 || j === -1) return false;
  const d = Math.abs(i - j);
  // The cells are listed clockwise, so neighbours differ by 1 — or by 3, which
  // is the wrap from the last back to the first.
  return d === 1 || d === 3;
}

describe('the board is the app icon', () => {
  it('is a 2x2 grid on the icon pitch with the top-left cell empty', () => {
    expect(BOBBLE_CELLS).toHaveLength(4);
    const resting = new Set<string>(BOBBLE_TILES.map((t) => t.from));
    expect(resting).toEqual(new Set(['tr', 'bl', 'br']));
    expect(resting.has('tl')).toBe(false); // the hole — what makes it a puzzle
  });

  it('lists its cells clockwise', () => {
    expect(CELL_IDS).toEqual(['tl', 'tr', 'br', 'bl']);
    // Clockwise on screen: x increases first, then y, then x decreases.
    expect(BOBBLE_CELLS[1]?.x).toBeGreaterThan(BOBBLE_CELLS[0]?.x ?? 0);
    expect(BOBBLE_CELLS[2]?.y).toBeGreaterThan(BOBBLE_CELLS[1]?.y ?? 0);
    expect(BOBBLE_CELLS[3]?.x).toBeLessThan(BOBBLE_CELLS[2]?.x ?? 0);
  });
});

describe('every tile takes the same clockwise lap from where it rests', () => {
  it.each(BOBBLE_TILES.map((t) => [t.id, t.from] as const))('%s starts at %s', (_id, from) => {
    const lap = bobbleLap(from);
    expect(lap).toHaveLength(4);
    expect(lap[0]?.id).toBe(from);
    // Every hop is to the next cell clockwise, and the lap visits all four.
    expect(new Set(lap.map((c) => c.id)).size).toBe(4);
    for (let i = 0; i < lap.length; i++) {
      const next = lap[(i + 1) % lap.length];
      expect(adjacent(lap[i]?.id ?? '', next?.id ?? '')).toBe(true);
    }
  });

  it('the three tiles move on three different beats', () => {
    expect(new Set(BOBBLE_TILES.map((t) => t.phase))).toEqual(new Set([0, 1, 2]));
  });
});

describe('playing the whole cycle', () => {
  // Two full cycles plus the phase run-in, sampled finely enough that a slide
  // (0.4 beats) can never be stepped over.
  const SAMPLES: number[] = [];
  for (let b = 0; b <= 2 * TILE_SCHEDULE.cycle + 3; b += 0.1) SAMPLES.push(Math.round(b * 10) / 10);

  it('never puts two tiles in the same cell', () => {
    for (const beat of SAMPLES) {
      const occupied = new Map<string, string>();
      for (const tile of BOBBLE_TILES) {
        for (const cell of tileAt(tile, beat)) {
          const other = occupied.get(cell.id);
          expect(
            other,
            `beat ${beat}: ${tile.id} and ${other} are both in ${cell.id}`,
          ).toBeUndefined();
          occupied.set(cell.id, tile.id);
        }
      }
    }
  });

  it('always leaves exactly one cell empty at rest', () => {
    for (const beat of SAMPLES) {
      const moving = BOBBLE_TILES.some((t) => tileAt(t, beat).length > 1);
      if (moving) continue;
      const occupied = new Set(BOBBLE_TILES.flatMap((t) => tileAt(t, beat).map((c) => c.id)));
      expect(occupied.size, `beat ${beat}`).toBe(3);
    }
  });

  it('only ever slides between adjacent cells', () => {
    for (const beat of SAMPLES) {
      for (const tile of BOBBLE_TILES) {
        const at = tileAt(tile, beat);
        if (at.length === 2) expect(adjacent(at[0]?.id ?? '', at[1]?.id ?? '')).toBe(true);
      }
    }
  });

  it('returns the mark to itself every cycle, so the loop is seamless', () => {
    const restingAt = (beat: number) =>
      BOBBLE_TILES.map((t) => `${t.id}@${tileAt(t, beat)[0]?.id}`).sort();
    // After the phase run-in (2 beats) the arrangement repeats every 12 beats.
    expect(restingAt(2.9)).toEqual(restingAt(2.9 + TILE_SCHEDULE.cycle));
    expect(restingAt(5.5)).toEqual(restingAt(5.5 + TILE_SCHEDULE.cycle));
  });
});

describe('the CSS runs the schedule this file describes', () => {
  /*
   * The animation itself is CSS — it has to be, at 60fps behind a conversation —
   * but the schedule above is its specification. A percentage edited in one and
   * not the other is a tile that lands on another tile, which is precisely the
   * failure the simulation above cannot see because it is not reading the CSS.
   */
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles/global.css'),
    'utf8',
  );
  const block = css.slice(css.indexOf('@keyframes pd-bobble-slide'));
  const stops = [...block.slice(0, block.indexOf('\n}')).matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) =>
    Number(m[1]),
  );

  it('has a stop for the start and end of every move', () => {
    const expected = new Set<number>([0, 100]);
    for (const at of TILE_SCHEDULE.moveAt) {
      expected.add(Math.round((at / TILE_SCHEDULE.cycle) * 100 * 1000) / 1000);
      expected.add(
        Math.round(((at + TILE_SCHEDULE.move) / TILE_SCHEDULE.cycle) * 100 * 1000) / 1000,
      );
    }
    // The CSS rounds to three decimals; compare on the same footing.
    const got = new Set(stops.map((v) => Math.round(v * 1000) / 1000));
    for (const want of expected) {
      const near = [...got].some((v) => Math.abs(v - want) < 0.01);
      expect(near, `no keyframe stop near ${want}% (moves at ${TILE_SCHEDULE.moveAt})`).toBe(true);
    }
  });

  it('drives all three tiles from that one animation', () => {
    expect(css).toContain('animation: pd-bobble-slide');
    expect(css).toContain(`* ${TILE_SCHEDULE.cycle})`); // cycle = 12 beats
  });
});
