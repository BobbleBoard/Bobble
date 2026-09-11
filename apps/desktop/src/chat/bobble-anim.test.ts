/**
 * The rules the loader can be WRONG about, played frame by frame.
 *
 * A screenshot of an animation proves one instant. These are the invariants that
 * only fail on some other instant: a block leaving the icon's box, a split whose
 * children are not inside the parent they came from, a cascade that peaks off
 * the line, a join between acts where the picture jumps.
 */
import { describe, expect, it } from 'vitest';
import {
  BAND,
  type Block,
  BOARD,
  cascadeHeat,
  cascadeT,
  cellOf,
  clamp01,
  DOT,
  GRID,
  gridCell,
  type LoaderVariant,
  loopMs,
  radiusFor,
  SWEEPS,
  sceneAt,
  seatOf,
  subdivide,
  TOTAL,
  tilePos,
  timeline,
} from './bobble-anim';
import { BOBBLE_CELLS, BOBBLE_TILE, BOBBLE_TILES, TILE_SCHEDULE, tileAt } from './bobble-tiles';

const VARIANTS: LoaderVariant[] = ['image', 'video', '3d', 'audio', 'plain'];

/** Every frame of a variant's loop, at 60fps. */
function frames(variant: LoaderVariant, step = 1000 / 60): number[] {
  const span = loopMs(variant);
  const out: number[] = [];
  for (let t = 0; t < span; t += step) out.push(t);
  return out;
}

describe('timeline', () => {
  it('lays the acts end to end with no gap and no overlap', () => {
    for (const v of VARIANTS) {
      const acts = timeline(v);
      expect(acts[0]?.start).toBe(0);
      for (let i = 1; i < acts.length; i++) {
        expect(acts[i]?.start).toBe(acts[i - 1]?.end);
      }
      expect(acts[acts.length - 1]?.end).toBe(loopMs(v));
    }
  });

  it('gives each modality its own closing act, and always opens the same way', () => {
    // The shared opening is the point: one family, not four loaders.
    for (const v of VARIANTS) {
      expect(
        timeline(v)
          .map((a) => a.act)
          .slice(0, 3),
      ).toEqual(['puzzle', 'split', 'cascade']);
    }
    expect(timeline('video').map((a) => a.act)).toContain('filmstrip');
    expect(timeline('3d').map((a) => a.act)).toContain('reveal');
    expect(timeline('audio').map((a) => a.act)).toContain('spectrum');
    expect(timeline('image').map((a) => a.act)).not.toContain('filmstrip');
  });
});

describe('geometry', () => {
  it('subdivides a square into children that sit inside their parent', () => {
    const kids = subdivide(16, 16, 12, 2);
    expect(kids).toHaveLength(16);
    for (const k of kids) {
      expect(k.cx - k.size / 2).toBeGreaterThanOrEqual(16 - 6 - 1e-9);
      expect(k.cx + k.size / 2).toBeLessThanOrEqual(16 + 6 + 1e-9);
      expect(k.cy - k.size / 2).toBeGreaterThanOrEqual(16 - 6 - 1e-9);
      expect(k.cy + k.size / 2).toBeLessThanOrEqual(16 + 6 + 1e-9);
    }
  });

  it('lines the outer grid cells up with the icon the split came from', () => {
    // Otherwise the last frame of the split jumps — the whole reason the grid is
    // derived from the tiles' span rather than from the 32-unit board.
    const first = gridCell(0, 0);
    const last = gridCell(GRID - 1, GRID - 1);
    expect(first.cx - first.size / 2).toBeCloseTo(BOBBLE_TILE.origin, 6);
    const outer = BOBBLE_TILE.origin + BOBBLE_TILE.pitch + BOBBLE_TILE.size;
    expect(last.cx + last.size / 2).toBeCloseTo(outer, 6);
  });

  it('seats all 64 blocks on distinct grid cells', () => {
    const seen = new Set<string>();
    for (let i = 0; i < TOTAL; i++) {
      const { i: gi, j: gj } = cellOf(i);
      seen.add(`${gi},${gj}`);
    }
    expect(seen.size).toBe(TOTAL);
  });

  it('keeps a dot round and a full cell rounded-square, in the icon proportion', () => {
    const seat = seatOf(0);
    expect(radiusFor(seat.size) / seat.size).toBeCloseTo(BOBBLE_TILE.radius / BOBBLE_TILE.size, 10);
  });
});

describe('tilePos — the sliding puzzle, continuously', () => {
  it('never leaves the cell(s) bobble-tiles says the tile is in', () => {
    // The two must agree or the canvas and the invariant test are describing
    // different animations.
    for (const tile of BOBBLE_TILES) {
      for (let beat = 0; beat < TILE_SCHEDULE.cycle; beat += 0.05) {
        const pos = tilePos(tile, beat);
        const cells = tileAt(tile, beat);
        const half = BOBBLE_TILE.size / 2;
        const ok = cells.some(
          (c) =>
            pos.cx >= c.x + half - 1e-6 - BOBBLE_TILE.pitch &&
            pos.cx <= c.x + half + 1e-6 + BOBBLE_TILE.pitch &&
            pos.cy >= c.y + half - 1e-6 - BOBBLE_TILE.pitch &&
            pos.cy <= c.y + half + 1e-6 + BOBBLE_TILE.pitch,
        );
        expect(ok).toBe(true);
        // And when at rest it is exactly on a cell centre, not near one.
        if (cells.length === 1) {
          const c = cells[0] as { x: number; y: number };
          expect(pos.cx).toBeCloseTo(c.x + half, 6);
          expect(pos.cy).toBeCloseTo(c.y + half, 6);
        }
      }
    }
  });

  it('is periodic in the cycle — the board repeats, tile by tile', () => {
    // NOT "every tile is home at beat 12": the tiles are phased, so at the end
    // of one cycle the later ones are legitimately mid-slide. What must hold is
    // that the whole board repeats, which is what lets the acts hand over.
    for (const tile of BOBBLE_TILES) {
      for (let beat = 0.5; beat < TILE_SCHEDULE.cycle; beat += 0.37) {
        const a = tilePos(tile, beat);
        const b = tilePos(tile, beat + TILE_SCHEDULE.cycle);
        expect(b.cx).toBeCloseTo(a.cx, 6);
        expect(b.cy).toBeCloseTo(a.cy, 6);
      }
    }
  });

  it('never puts two tiles in the same place', () => {
    for (let beat = 0; beat < TILE_SCHEDULE.cycle; beat += 0.05) {
      const pts = BOBBLE_TILES.map((t) => tilePos(t, beat));
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i] as { cx: number; cy: number };
          const b = pts[j] as { cx: number; cy: number };
          expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThan(BOBBLE_TILE.size * 0.5);
        }
      }
    }
  });
});

describe('cascadeHeat — the user's y = x - t', () => {
  it('peaks exactly ON the line and decays away from it', () => {
    // A cell sitting on y = x - t has cx - cy - t === 0.
    const t = 4;
    expect(cascadeHeat(10, 10 - t, t)).toBeCloseTo(1, 10);
    let prev = 1;
    for (let off = 0; off <= BAND * Math.SQRT2; off += 0.5) {
      const h = cascadeHeat(10 + off, 10 - t, t);
      expect(h).toBeLessThanOrEqual(prev + 1e-9);
      prev = h;
    }
    // Exactly BAND away (measured perpendicular) the cell is a bare dot.
    expect(cascadeHeat(10 + BAND * Math.SQRT2, 10 - t, t)).toBeCloseTo(0, 10);
  });

  it('is symmetric either side of the line', () => {
    const t = -3;
    for (let off = 0.5; off < BAND; off += 1) {
      expect(cascadeHeat(12 + off, 12 - t, t)).toBeCloseTo(cascadeHeat(12 - off, 12 - t, t), 10);
    }
  });

  it('sweeps the whole board and clears it at both ends', () => {
    // t lowers at a constant rate; at each end no cell should still be lit, or
    // the wave pops out mid-grid instead of leaving.
    for (const p of [0, 1]) {
      const t = cascadeT(p);
      for (let i = 0; i < TOTAL; i++) {
        const seat = seatOf(i);
        expect(cascadeHeat(seat.cx, seat.cy, t)).toBeLessThan(0.02);
      }
    }
    // ...and mid-PASS it is fully lit for someone. (The act's own midpoint is
    // the wrap between passes, where every cell is a dot by design.)
    const mid = cascadeT(0.25);
    const best = Math.max(
      ...Array.from({ length: TOTAL }, (_, i) => {
        const s = seatOf(i);
        return cascadeHeat(s.cx, s.cy, mid);
      }),
    );
    expect(best).toBeGreaterThan(0.9);
  });

  it('moves monotonically within each pass, and wraps only where nothing is lit', () => {
    let prev = cascadeT(0);
    let wraps = 0;
    for (let p = 0.005; p <= 1; p += 0.005) {
      const t = cascadeT(p);
      if (t > prev) {
        wraps += 1;
        // A wrap is only allowed where the board is uniformly dots, or it would
        // be a visible jump rather than the next pass beginning.
        for (let i = 0; i < TOTAL; i++) {
          const seat = seatOf(i);
          expect(cascadeHeat(seat.cx, seat.cy, prev)).toBeLessThan(0.05);
          expect(cascadeHeat(seat.cx, seat.cy, t)).toBeLessThan(0.05);
        }
      }
      prev = t;
    }
    expect(wraps).toBe(SWEEPS - 1);
  });
});

describe('sceneAt — every frame of every variant', () => {
  const inBox = (b: Block) =>
    b.cx - b.size / 2 >= -0.51 &&
    b.cx + b.size / 2 <= BOARD + 0.51 &&
    b.cy - b.size / 2 >= -0.51 &&
    b.cy + b.size / 2 <= BOARD + 0.51;

  it('always emits the same blocks, so the acts have nothing to match up', () => {
    for (const v of VARIANTS) {
      for (const t of frames(v, 40)) {
        expect(sceneAt(t, v).blocks).toHaveLength(TOTAL);
      }
    }
  });

  it('never draws outside the icon box', () => {
    for (const v of VARIANTS) {
      for (const t of frames(v, 20)) {
        for (const b of sceneAt(t, v).blocks) {
          expect(inBox(b)).toBe(true);
        }
      }
    }
  });

  it('keeps every block physically sane: non-negative size, radius within it', () => {
    /* Collected and asserted ONCE. Five variants x ~700 frames x 64 blocks is
       over a million assertions, and an `expect` per field took longer than the
       suite's timeout on a busy machine — the check is cheap, the bookkeeping
       around it was not. A violation still names itself. */
    const bad: string[] = [];
    for (const v of VARIANTS) {
      for (const t of frames(v, 20)) {
        const blocks = sceneAt(t, v).blocks;
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i] as Block;
          const why =
            b.size < -1e-9
              ? 'negative size'
              : b.radius < -1e-9
                ? 'negative radius'
                : b.radius > b.size / 2 + 1e-6
                  ? `radius ${b.radius} > half of size ${b.size}`
                  : b.alpha < 0 || b.alpha > 1
                    ? `alpha ${b.alpha}`
                    : !Number.isFinite(b.lift)
                      ? `lift ${b.lift}`
                      : null;
          if (why !== null) bad.push(`${v} t=${Math.round(t)} block ${i}: ${why}`);
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('flows: no block teleports, at an act join or anywhere else', () => {
    // THE invariant the user's "these animations should flow into each other" cashes
    // out to. A jump here is the one defect that would read as two animations
    // spliced together rather than one continuous life.
    const STEP = 1000 / 60;
    for (const v of VARIANTS) {
      let prev = sceneAt(0, v).blocks;
      for (let t = STEP; t < loopMs(v); t += STEP) {
        const now = sceneAt(t, v).blocks;
        for (let i = 0; i < TOTAL; i++) {
          const a = prev[i] as Block;
          const b = now[i] as Block;
          const moved = Math.hypot(a.cx - b.cx, a.cy - b.cy);
          // A whole board-width in 16ms would be a teleport; the filmstrip
          // legitimately wraps, so allow one wrap's worth there only.
          const limit = v === 'video' ? BOARD + 1 : 3.2;
          expect(moved).toBeLessThanOrEqual(limit);
          expect(Math.abs(a.size - b.size)).toBeLessThanOrEqual(3.2);
        }
        prev = now;
      }
    }
  });

  it('loops seamlessly — the last frame meets the first', () => {
    for (const v of VARIANTS) {
      const span = loopMs(v);
      const end = sceneAt(span - 1000 / 60, v).blocks;
      const start = sceneAt(0, v).blocks;
      for (let i = 0; i < TOTAL; i++) {
        const a = end[i] as Block;
        const b = start[i] as Block;
        expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeLessThan(3.2);
        expect(Math.abs(a.size - b.size)).toBeLessThan(3.2);
      }
    }
  });

  it('opens as the mark: three solid tiles, nothing else visible', () => {
    const vis = sceneAt(0, 'image').blocks.filter((b) => b.alpha > 0.5 && b.size > 1);
    // Sixteen coincident opaque squares paint one square, so what matters is
    // that they collapse to exactly three DISTINCT tiles at the icon's size.
    const distinct = new Set(vis.map((b) => `${b.cx.toFixed(4)},${b.cy.toFixed(4)}`));
    expect(distinct.size).toBe(BOBBLE_TILES.length);
    for (const b of vis) expect(b.size).toBeCloseTo(BOBBLE_TILE.size, 6);
    // ...and they are on three DIFFERENT cells of the four.
    const cells = new Set(
      vis.map((b) => {
        const near = BOBBLE_CELLS.map((c) => ({
          id: c.id,
          d: Math.hypot(c.x + BOBBLE_TILE.size / 2 - b.cx, c.y + BOBBLE_TILE.size / 2 - b.cy),
        })).sort((x, y) => x.d - y.d)[0];
        return near?.id;
      }),
    );
    expect(cells.size).toBe(3);
  });

  it('ends the split on the full grid, every cell seated', () => {
    const acts = timeline('image');
    const split = acts.find((a) => a.act === 'split');
    const scene = sceneAt((split?.end ?? 0) - 1, 'image');
    expect(scene.blocks).toHaveLength(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      const b = scene.blocks[i] as Block;
      const seat = seatOf(i);
      expect(b.cx).toBeCloseTo(seat.cx, 1);
      expect(b.cy).toBeCloseTo(seat.cy, 1);
      expect(b.alpha).toBeGreaterThan(0.9);
    }
  });

  it('turns cells into dots away from the wave, and back into squares on it', () => {
    const acts = timeline('image');
    const cascade = acts.find((a) => a.act === 'cascade') as { start: number; end: number };
    const mid = sceneAt(cascade.start + (cascade.end - cascade.start) * 0.25, 'image');
    const sizes = mid.blocks.map((b) => b.size);
    const seat = seatOf(0);
    expect(Math.min(...sizes)).toBeLessThan((seat.size * (DOT + 0.15)) / (1 - 0.107) + 0.2);
    expect(Math.max(...sizes)).toBeGreaterThan(seat.size * 0.9);
    // The smallest are round.
    const smallest = mid.blocks.reduce((a, b) => (a.size <= b.size ? a : b));
    expect(smallest.radius).toBeCloseTo(smallest.size / 2, 6);
  });

  it('stays flat for every act except the 3D reveal', () => {
    for (const v of VARIANTS) {
      for (const t of frames(v, 40)) {
        const s = sceneAt(t, v);
        if (s.act === 'reveal') continue;
        expect(s.yaw).toBe(0);
        expect(s.pitch).toBe(0);
        expect(s.solidity).toBe(0);
        for (const b of s.blocks) expect(b.lift).toBe(0);
      }
    }
  });

  it('reveals 3D out of the flat grid with nothing swapped', () => {
    const acts = timeline('3d');
    const reveal = acts.find((a) => a.act === 'reveal') as { start: number; end: number };
    // At the join it is still exactly flat — that is what "seamlessly" means.
    const first = sceneAt(reveal.start, '3d');
    expect(first.solidity).toBeCloseTo(0, 6);
    for (const b of first.blocks) expect(b.lift).toBeCloseTo(0, 6);
    // It stands up and turns in the middle...
    const mid = sceneAt((reveal.start + reveal.end) / 2, '3d');
    expect(mid.solidity).toBeGreaterThan(0.9);
    expect(mid.pitch).toBeGreaterThan(0.4);
    expect(Math.max(...mid.blocks.map((b) => b.lift))).toBeGreaterThan(1);
    // ...swings both ways without ever going edge-on (where a face collapses)...
    const yaws = Array.from(
      { length: 60 },
      (_, i) => sceneAt(reveal.start + ((reveal.end - reveal.start) * i) / 60, '3d').yaw,
    );
    expect(Math.max(...yaws)).toBeGreaterThan(0.6);
    expect(Math.min(...yaws)).toBeLessThan(-0.6);
    for (const y of yaws) expect(Math.abs(y)).toBeLessThan(Math.PI / 2 - 0.15);
    // ...and lies back down, because `merge` is flat and the join must not snap.
    const late = sceneAt(reveal.end - 1, '3d');
    expect(late.solidity).toBeLessThan(0.05);
    expect(late.pitch).toBeLessThan(0.05);
    expect(Math.max(...late.blocks.map((b) => b.lift))).toBeLessThan(0.2);
  });

  it('clamps and eases the way the acts assume', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});
