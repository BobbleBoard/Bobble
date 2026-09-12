/**
 * THE WAIT, AS THE APP'S OWN MARK TAKING ITSELF APART AND PUTTING ITSELF BACK.
 *
 * the user, asking for the generation loaders to be "a bit more fun":
 *
 *   "change the app icon's squares to be totally white, and then the sliding
 *    tile puzzle clockwise animation can be done, as well as smoothly
 *    interchanging between a grid of dots in diagonal lines going down sizing up
 *    to these rounded corner squares and tiling before sizing down again in a
 *    cascade (eg. line y=x-t, t lowers at a constant rate, any dot touching the
 *    line (depending on distance from the line) is scaled up as it is closer, at
 *    negligible or low size it's just a small dot) … maybe make another where
 *    the icon splits up into smaller tile puzzles a few times before shifting
 *    into the diagonal cascade once there's enough … for 3d maybe make it 3d and
 *    dramatically reveal it rotating seamlessly from the 2d animation to 3d.
 *    video could be something fun with the blocks as well … importantly these
 *    all have to be with the blocks from the app icon mainly."
 *
 * ## Why this is a pure module
 * The same reason bobble-tiles.ts is: the motion has RULES that can be got
 * wrong, and a wrong one looks like a bug rather than like a design. A sliding
 * puzzle may only move the tile beside the hole. A split must land its children
 * exactly on the parent they came from, or the icon visibly tears. A cascade
 * driven by distance-to-a-line must peak ON the line and decay monotonically
 * away from it, or the wave reads as flicker. None of those are things a
 * screenshot catches. bobble-anim.test.ts checks them across the whole timeline.
 *
 * So: no DOM here, no canvas, no React. `sceneAt(ms, variant)` is a pure
 * function from a clock to a list of blocks, and BobbleLoader.tsx is a dumb
 * renderer that draws whatever it is handed.
 *
 * ## The arc, and why it is ONE arc
 * the user asked for several animations that "flow into each other". They are not
 * separate loops that cross-fade — that is what a cross-fade looks like, and it
 * looks like two animations. They are ACTS of one continuous life:
 *
 *   1. PUZZLE   the mark, three tiles sliding clockwise around their hole
 *   2. SPLIT    every tile divides 2x2, twice, and the hole fills in — the board
 *               goes from 3 tiles to a full 8x8 grid, each generation of
 *               children starting exactly where its parent was
 *   3. CASCADE  the grid breathes: the user's diagonal line sweeps it, and a cell is
 *               a rounded square where the line is and a small dot where it is not
 *   4. (per modality) a closing act — a filmstrip for video, an extrusion into
 *               rotating solids for 3D, a spectrum for audio
 *   5. MERGE    the grid folds back up into the three tiles, and it begins again
 *
 * Every act emits the SAME 64 blocks in the same order, so block 37 is the same
 * square all the way through: nothing is created, destroyed or matched up
 * between acts, and the joins are not transitions at all.
 */

import { BOBBLE_CELLS, BOBBLE_TILE, BOBBLE_TILES, bobbleLap, TILE_SCHEDULE } from './bobble-tiles';

/** The icon's own coordinate system: a 32x32 box, as in the SVG mark. */
export const BOARD = 32;

/** How many times a tile divides before the board is a grid. Two: one tile
 * becomes 4 becomes 16, so the four icon cells together make a full 8x8. */
export const SPLIT_LEVELS = 2;

/** The grid the split arrives at, and the grid every later act plays on. */
export const GRID = 8;
/** Sub-cells across ONE icon cell. */
const PER = GRID / 2;
/** Blocks in a scene, always. */
export const TOTAL = GRID * GRID;

/** One drawable square. Everything the renderer needs and nothing it doesn't. */
export interface Block {
  /** Centre, in board units. */
  readonly cx: number;
  readonly cy: number;
  /** Edge length in board units. A block with `radius === size / 2` is a dot. */
  readonly size: number;
  readonly radius: number;
  /** 0..1. Blocks never pop: they arrive and leave on this. */
  readonly alpha: number;
  /** Height above the board, in board units, for the acts that leave the plane.
   * 0 for every flat act — so 2D and 3D are one code path with nothing to seam. */
  readonly lift: number;
}

/** What the renderer needs beyond the blocks themselves. */
export interface Scene {
  readonly blocks: readonly Block[];
  /** Which act is on screen — for tests and for `data-act` in the DOM. */
  readonly act: ActName;
  /** Rotation of the board about its vertical axis, in radians. 0 while flat. */
  readonly yaw: number;
  /** Tilt toward the viewer, in radians. 0 while flat. */
  readonly pitch: number;
  /** 0 while flat, 1 fully solid — drives the renderer's extrusion. */
  readonly solidity: number;
}

export type ActName =
  | 'puzzle'
  | 'split'
  | 'cascade'
  | 'filmstrip'
  | 'reveal'
  | 'spectrum'
  | 'merge';

/** Which closing act a modality gets. Everything shares acts 1-3. */
export type LoaderVariant = 'image' | 'video' | '3d' | 'audio' | 'plain';

// ─── easing ──────────────────────────────────────────────────────────────────

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smooth in and out — nothing starts or stops with a corner in its velocity. */
export const smooth = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
/**
 * A tile leaving one cell for the next.
 *
 * In-and-out, not out-only. A cubic ease-OUT starts at three times its average
 * speed, which over a 136ms slide is 4.5 of the board's 32 units in a single
 * frame — the frame test caught it, and on screen it reads as a snap rather than
 * a slide. This is the curve the mark's own CSS already used
 * (cubic-bezier(0.32, 0, 0.15, 1)): begins and ends at rest, peaks at 1.5x, and
 * has nowhere to bounce, which is right for a tile in a wooden frame.
 */
export const slideEase = (v: number): number => smooth(v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ─── the timeline ────────────────────────────────────────────────────────────

/** The puzzle runs a whole 12-beat cycle, so every tile is home before anything
 * divides — a split out of a half-finished slide is the one frame that reads as
 * a glitch. 340ms a beat is the mark's own tempo (see global.css). */
export const BEAT_MS = 340;
export const PUZZLE_MS = TILE_SCHEDULE.cycle * BEAT_MS;
export const SPLIT_MS = 1500;
export const CASCADE_MS = 4200;
export const CLOSER_MS = 3200;
export const MERGE_MS = 1100;

export interface ActSpan {
  readonly act: ActName;
  readonly start: number;
  readonly end: number;
}

/** The act list for a variant, laid end to end. */
export function timeline(variant: LoaderVariant): readonly ActSpan[] {
  const closer: ActName | null =
    variant === 'video'
      ? 'filmstrip'
      : variant === '3d'
        ? 'reveal'
        : variant === 'audio'
          ? 'spectrum'
          : null;
  const order: { act: ActName; ms: number }[] = [
    { act: 'puzzle', ms: PUZZLE_MS },
    { act: 'split', ms: SPLIT_MS },
    { act: 'cascade', ms: CASCADE_MS },
    ...(closer === null ? [] : [{ act: closer, ms: CLOSER_MS }]),
    { act: 'merge', ms: MERGE_MS },
  ];
  let at = 0;
  return order.map((o) => {
    const span = { act: o.act, start: at, end: at + o.ms };
    at += o.ms;
    return span;
  });
}

/** Total loop length for a variant. */
export function loopMs(variant: LoaderVariant): number {
  const t = timeline(variant);
  return t[t.length - 1]?.end ?? 1;
}

// ─── geometry ────────────────────────────────────────────────────────────────

/** The gap between neighbouring blocks, as a fraction of pitch. The icon's own:
 * a 12.5 tile on a 14 pitch leaves 1.5 of air. */
const AIR = 1 - BOBBLE_TILE.size / BOBBLE_TILE.pitch;

/** The icon's own corner-radius proportion: 3.5 on a 12.5 tile. */
export const ICON_ROUND = BOBBLE_TILE.radius / BOBBLE_TILE.size;

/** Corner radius for a block of a given size, in the icon's proportion. */
export function radiusFor(size: number): number {
  return ICON_ROUND * size;
}

/**
 * Radius as a fraction of a block's OWN size, blended between a dot and the
 * icon's corner.
 *
 * Expressed as a fraction on purpose: a radius interpolated toward an absolute
 * value can exceed half the (shrinking) block it belongs to, which is a shape
 * that cannot be drawn — caught by the test, as a "dot" wider than itself.
 */
export function roundnessAt(heat: number): number {
  return lerp(0.5, ICON_ROUND, clamp01(heat));
}

/**
 * One cell of the uniform grid.
 *
 * Derived from the ICON's own span rather than from the board width: the mark's
 * tiles sit at origin 2.75 on a 14 pitch, so a grid that simply divided 32 by 8
 * would not line up with the tiles it came from and the split would end on a
 * jump. This divides the span the tiles actually occupy, so the outermost grid
 * cells share their outer edges with the icon.
 */
export function gridCell(i: number, j: number): { cx: number; cy: number; size: number } {
  const span = BOBBLE_TILE.pitch + BOBBLE_TILE.size;
  const step = span / GRID;
  return {
    cx: BOBBLE_TILE.origin + (i + 0.5) * step,
    cy: BOBBLE_TILE.origin + (j + 0.5) * step,
    size: step,
  };
}

/**
 * Divide a square into `2^level` per side, each child inset by the icon's air
 * gap. Reading order, so a parent's children are always indexed the same way —
 * which is what lets the split animate by lerping a child out of its parent
 * instead of matching positions after the fact.
 */
export function subdivide(
  cx: number,
  cy: number,
  size: number,
  level: number,
): { cx: number; cy: number; size: number }[] {
  const n = 2 ** level;
  if (n <= 1) return [{ cx, cy, size }];
  const pitch = size / n;
  const child = pitch * (1 - AIR);
  const out: { cx: number; cy: number; size: number }[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out.push({
        cx: cx - size / 2 + (i + 0.5) * pitch,
        cy: cy - size / 2 + (j + 0.5) * pitch,
        size: child,
      });
    }
  }
  return out;
}

/** Which icon cell a flat block index belongs to, and where it sits inside it. */
export function cellOf(index: number): {
  cell: (typeof BOBBLE_CELLS)[number];
  i: number;
  j: number;
} {
  const cellIndex = Math.floor(index / (PER * PER));
  const within = index % (PER * PER);
  const cell = BOBBLE_CELLS[cellIndex] as (typeof BOBBLE_CELLS)[number];
  const col = cell.id === 'tr' || cell.id === 'br' ? 1 : 0;
  const row = cell.id === 'bl' || cell.id === 'br' ? 1 : 0;
  return { cell, i: col * PER + (within % PER), j: row * PER + Math.floor(within / PER) };
}

/** Where block `index` rests once the board is a grid. */
export function seatOf(index: number): { cx: number; cy: number; size: number } {
  const { i, j } = cellOf(index);
  const g = gridCell(i, j);
  return { cx: g.cx, cy: g.cy, size: g.size * (1 - AIR) };
}

/** The tile (if any) whose cell this block belongs to. -1 for the hole. */
export function tileNoOf(index: number): number {
  const { cell } = cellOf(index);
  return BOBBLE_TILES.findIndex((t) => t.from === cell.id);
}

// ─── act 1: the puzzle ───────────────────────────────────────────────────────

/**
 * Where a tile sits at `beat`, continuously — the schedule bobble-tiles.ts
 * describes discretely, interpolated so it can drive a canvas.
 *
 * bobble-tiles.tileAt answers "which cell(s)"; this answers "exactly where".
 * They agree by construction (both read TILE_SCHEDULE), and the test asserts
 * this one stays inside the cell(s) that one names, on every frame.
 */
export function tilePos(
  tile: { readonly from: string; readonly phase: number },
  beat: number,
): { cx: number; cy: number } {
  const lap = bobbleLap(tile.from);
  const half = BOBBLE_TILE.size / 2;
  const local = beat - tile.phase;
  const centre = (c: { x: number; y: number }) => ({ cx: c.x + half, cy: c.y + half });
  if (local < 0) return centre(lap[0] as { x: number; y: number });
  const c = ((local % TILE_SCHEDULE.cycle) + TILE_SCHEDULE.cycle) % TILE_SCHEDULE.cycle;
  let index = 0;
  for (let i = 0; i < TILE_SCHEDULE.moveAt.length; i++) {
    const at = TILE_SCHEDULE.moveAt[i] as number;
    if (c >= at && c < at + TILE_SCHEDULE.move) {
      const from = lap[i] as { x: number; y: number };
      const to = lap[(i + 1) % lap.length] as { x: number; y: number };
      const k = slideEase((c - at) / TILE_SCHEDULE.move);
      return { cx: lerp(from.x, to.x, k) + half, cy: lerp(from.y, to.y, k) + half };
    }
    if (c >= at + TILE_SCHEDULE.move) index = i + 1;
  }
  return centre(lap[index % lap.length] as { x: number; y: number });
}

// ─── act 3: the cascade ──────────────────────────────────────────────────────

/** Half-width of the band the sweeping line lights, in board units. A cell
 * further than this from the line is a bare dot. */
export const BAND = 11;
/** A dot's size as a fraction of its cell — "at negligible or low size it's
 * just a small dot". */
export const DOT = 0.22;

/**
 * the user's rule, exactly: the line is `y = x - t`, `t` lowers at a constant rate,
 * and a cell is scaled by how close it is to that line.
 *
 * Distance from (cx,cy) to `y = x - t`, i.e. to `x - y - t = 0`, is
 * `|cx - cy - t| / sqrt(2)`. 1 ON the line, decaying to 0 at BAND.
 */
export function cascadeHeat(cx: number, cy: number, t: number): number {
  const d = Math.abs(cx - cy - t) / Math.SQRT2;
  return smooth(1 - clamp01(d / BAND));
}

/** How many times the line crosses the board in one cascade act.
 *
 * One pass left the grid sitting as a bare dot field for a beat at each end —
 * the split hands over dots, then nothing moves until the wave arrives. Two
 * passes keep something crossing the board almost the whole act. The wrap
 * between them is invisible because both ends of a pass are the same picture:
 * every cell a dot. */
export const SWEEPS = 2;

/** The sweep's range: far enough past both corners that the wave leaves the
 * board at each end instead of popping out mid-grid. */
export function cascadeT(progress: number): number {
  const reach = BOARD + BAND * Math.SQRT2;
  const within = (clamp01(progress) * SWEEPS) % 1;
  // The last instant of the act is the end of a pass, not the start of a new one.
  const s = progress >= 1 ? 1 : within;
  return lerp(reach, -reach, s);
}

// ─── the exit: the sweep that hands the card over ────────────────────────────

/**
 * THE END OF THE WAIT IS NOT A FADE-OUT, IT IS THE LAST SWEEP.
 *
 * the user: "it can simply smoothly fade out with one of the animations eg. the
 * diagonal cascade when it's ready can do it's thing, but as it goes reveal the
 * actual produced image/video/3d. seamless besides a quick smooth resize."
 *
 * So the loader does not stop and get replaced — the same diagonal that has been
 * sweeping the grid all along makes one final pass, and the blocks it has passed
 * are gone. What is behind them is the finished picture, uncovered along the very
 * same line. The card never blinks and nothing is swapped underneath the reader.
 *
 * It starts from the grid the cascade act already hands over (`cascadeBlocks` at
 * the line's own start), so whatever act was on screen, the first exit frame is
 * a pose the loop itself passes through — there is nothing to cut between.
 */
export const EXIT_MS = 1150;

/** How far past the corner the line starts and ends, so the sweep enters and
 * leaves the board rather than appearing mid-grid. */
function reach(): number {
  return BOARD + BAND * Math.SQRT2;
}

/** The line's position at exit progress `p` — the same `y = x - t` as the
 * cascade, travelling once, all the way across. */
export function exitT(p: number): number {
  return lerp(reach(), -reach(), clamp01(p));
}

/**
 * How much of the card the sweep has uncovered, 0..1.
 *
 * The card and the board are not the same box — the blocks live in a centred
 * square and the picture fills the whole frame — so this cannot be a pixel-exact
 * shared edge. What it CAN be is one number: the mask over the media and the
 * blocks' own fade are both driven from here, so they sweep together and neither
 * can lead the other.
 */
export function exitReveal(p: number): number {
  return smooth(clamp01(p));
}

/** Half-width of the band a block dissolves across, once the line is past it. */
const EXIT_BAND = BAND * 0.62;

/**
 * The board mid-exit: dots ahead of the line, a rounded square ON it, nothing
 * behind it.
 *
 * The bloom is the cascade's own `cascadeHeat`, so a block's last act is the
 * same one it has been performing all along; it simply does not come back down
 * the far side, because by then it has been let go.
 */
export function exitSceneAt(p: number): Scene {
  const t = exitT(p);
  const blocks: Block[] = [];
  for (let index = 0; index < TOTAL; index++) {
    const seat = seatOf(index);
    const heat = cascadeHeat(seat.cx, seat.cy, t);
    const cellSize = seat.size / (1 - AIR);
    /* Signed, not absolute: which SIDE of the line a block is on is the whole
       question here, where the cascade only ever cared how far. */
    const past = clamp01((seat.cx - seat.cy - t) / EXIT_BAND);
    const leaving = smooth(past);
    const size = lerp(cellSize * DOT, seat.size, heat) * (1 - 0.45 * leaving);
    blocks.push({
      cx: seat.cx,
      cy: seat.cy,
      size,
      radius: size * roundnessAt(heat),
      alpha: 1 - leaving,
      lift: 0,
    });
  }
  /* `cascade`, because that is what it IS — the same act, not coming back. */
  return { blocks, act: 'cascade', yaw: 0, pitch: 0, solidity: 0 };
}

// ─── the scene ───────────────────────────────────────────────────────────────

/** The flat grid state every post-split act starts from: dots where the wave is
 * not, rounded squares where it is. */
function cascadeBlocks(t: number): Block[] {
  const out: Block[] = [];
  for (let index = 0; index < TOTAL; index++) {
    const seat = seatOf(index);
    const heat = cascadeHeat(seat.cx, seat.cy, t);
    const cellSize = seat.size / (1 - AIR);
    const size = lerp(cellSize * DOT, seat.size, heat);
    /* A dot is a square whose corners have eaten it (radius = half its size).
       Blending the FRACTION rather than the absolute radius IS "a dot sizing up
       into a rounded square": one shape the whole way, never a swap, and never
       a radius larger than the block it belongs to. */
    out.push({
      cx: seat.cx,
      cy: seat.cy,
      size,
      radius: size * roundnessAt(heat),
      alpha: 1,
      lift: 0,
    });
  }
  return out;
}

/**
 * The whole animation, sampled at `ms`.
 */
export function sceneAt(ms: number, variant: LoaderVariant = 'image'): Scene {
  const span = loopMs(variant);
  const at = ((ms % span) + span) % span;
  const acts = timeline(variant);
  const current = acts.find((a) => at >= a.start && at < a.end) ?? (acts[0] as ActSpan);
  const p = clamp01((at - current.start) / (current.end - current.start));
  /*
   * THE TILES' CLOCK IS THE PUZZLE ACT'S OWN, not the loop's.
   *
   * Read from absolute loop time the mark was mid-slide when the loop wrapped,
   * so the last frame and the first were 20 units apart — a visible jump every
   * cycle (caught by the seam test). The puzzle runs exactly 12 beats, so its
   * local clock both starts and ends at beat 0; split and merge therefore find
   * the tiles at HOME, which is the pose the mark is supposed to reassemble to.
   */
  const beat =
    current.act === 'puzzle'
      ? (at - current.start) / BEAT_MS
      : current.act === 'split'
        ? TILE_SCHEDULE.cycle // exactly where the puzzle act left the tiles
        : 0; // merge lands the mark on its resting pose, which is where puzzle opens

  let yaw = 0;
  let pitch = 0;
  let solidity = 0;
  let blocks: Block[];

  if (current.act === 'puzzle' || current.act === 'merge') {
    /*
     * THE MARK ITSELF — three tiles on a four-cell board. `merge` is the same
     * frame with the grid folding back into it, so the loop closes on the shape
     * it opened with.
     *
     * One block per tile carries the solid square; its 15 siblings ride the same
     * seat with zero alpha. That keeps the block list the same length and the
     * same order in every act, which is the whole trick.
     */
    const centres = BOBBLE_TILES.map((t) => tilePos(t, beat));
    // merge: 0 → grid, 1 → mark. puzzle: fully the mark.
    const k = current.act === 'merge' ? smooth(p) : 1;
    const from = cascadeBlocks(cascadeT(1));
    blocks = [];
    for (let index = 0; index < TOTAL; index++) {
      const seat = seatOf(index);
      const tileNo = tileNoOf(index);
      const start = from[index] as Block;
      if (tileNo === -1) {
        // The hole: its cells shrink away as the mark reassembles.
        const size = lerp(start.size, 0, k);
        blocks.push({
          cx: seat.cx,
          cy: seat.cy,
          size,
          radius: lerp(start.radius, 0, k),
          alpha: 1 - k,
          lift: 0,
        });
        continue;
      }
      /*
       * ALL SIXTEEN CHILDREN GATHER ONTO THE TILE — they do not fade out while
       * one survives.
       *
       * Stacking them is what makes the mark a mark: sixteen opaque squares at
       * the same centre, at the same size, paint exactly one square. Fading
       * fifteen of them instead left the act boundary with a real jump (size 0
       * to 12.5 in one frame, caught by the frame test) even though the pixels
       * happened to match — and the split act's first frame is precisely this
       * state, so handing it over intact is what lets the two acts share an edge.
       */
      const centre = centres[tileNo] as { cx: number; cy: number };
      const size = lerp(start.size, BOBBLE_TILE.size, k);
      const startRound = start.radius / Math.max(start.size, 1e-6);
      blocks.push({
        cx: lerp(seat.cx, centre.cx, k),
        cy: lerp(seat.cy, centre.cy, k),
        size,
        radius: size * lerp(startRound, ICON_ROUND, k),
        alpha: 1,
        lift: 0,
      });
    }
  } else if (current.act === 'split') {
    /*
     * DIVIDE, TWICE, AND FILL THE HOLE.
     *
     * The two generations are staggered rather than simultaneous — the user asked
     * for the icon to split "a few times", and one simultaneous burst to 64
     * reads as a single event, not as a few. The hole's cells arrive last, which
     * is what turns three tiles into a board.
     */
    const gen1 = smooth(clamp01(p / 0.42));
    const gen2 = smooth(clamp01((p - 0.3) / 0.7));
    const fill = smooth(clamp01((p - 0.45) / 0.55));
    const centres = BOBBLE_TILES.map((t) => tilePos(t, beat));
    blocks = [];
    for (let index = 0; index < TOTAL; index++) {
      const seat = seatOf(index);
      const tileNo = tileNoOf(index);
      if (tileNo === -1) {
        const size = (seat.size / (1 - AIR)) * DOT * fill;
        blocks.push({ cx: seat.cx, cy: seat.cy, size, radius: size / 2, alpha: fill, lift: 0 });
        continue;
      }
      const centre = centres[tileNo] as { cx: number; cy: number };
      const restSize = (seat.size / (1 - AIR)) * DOT;
      const within = index % (PER * PER);
      const quadX = within % PER >= PER / 2 ? 1 : 0;
      const quadY = Math.floor(within / PER) >= PER / 2 ? 1 : 0;
      // Generation 1: the whole tile becomes 2x2 about its own centre.
      const g1 = subdivide(centre.cx, centre.cy, BOBBLE_TILE.size, 1)[quadY * 2 + quadX] as {
        cx: number;
        cy: number;
        size: number;
      };
      const s1 = {
        cx: lerp(centre.cx, g1.cx, gen1),
        cy: lerp(centre.cy, g1.cy, gen1),
        size: lerp(BOBBLE_TILE.size, g1.size, gen1),
      };
      /* Generation 2: each of those becomes 2x2 again, relaxing onto the grid —
         and down to the DOT the cascade rests at. The wave is what makes a dot a
         rounded square again ("sizing up to these rounded corner squares and
         tiling before sizing down again"), so the split has to hand the cascade
         the board it expects or the first wave frame shrinks everything at once. */
      const size = lerp(s1.size, restSize, gen2);
      blocks.push({
        cx: lerp(s1.cx, seat.cx, gen2),
        cy: lerp(s1.cy, seat.cy, gen2),
        size,
        radius: size * lerp(ICON_ROUND, 0.5, gen2),
        alpha: 1,
        lift: 0,
      });
    }
  } else {
    /* Every remaining act plays on the grid, which is why they follow one
       another with no transition: they are all the same 64 squares. */
    blocks = cascadeBlocks(cascadeT(p));

    if (current.act === 'filmstrip') {
      /*
       * VIDEO — "something fun with the blocks".
       *
       * The grid becomes film: alternate rows slide opposite ways and wrap
       * inside the board, while a shutter of full-size squares travels across.
       * Blocks only ever move along their own row, so what is on screen is still
       * unmistakably the icon's squares rather than some new object.
       */
      const step = gridCell(1, 0).cx - gridCell(0, 0).cx;
      const lo = gridCell(0, 0).cx - step / 2;
      const width = step * GRID;
      const shutter = p * (GRID + 4) - 2;
      blocks = blocks.map((b, index) => {
        const seat = seatOf(index);
        const { i, j } = cellOf(index);
        const dir = j % 2 === 0 ? 1 : -1;
        const drift = p * dir * width;
        const cx = lo + ((((b.cx + drift - lo) % width) + width) % width);
        const near = smooth(Math.max(0, 1 - Math.abs(i - shutter) / 1.6));
        const size = lerp(b.size, seat.size, near);
        return { cx, cy: b.cy, size, radius: size * roundnessAt(near), alpha: 1, lift: 0 };
      });
    } else if (current.act === 'spectrum') {
      /*
       * AUDIO — the grid read as one column per band. A column's height is a
       * standing wave, so it moves like a level meter without pretending to be
       * anybody's actual spectrum.
       */
      blocks = blocks.map((b, index) => {
        const seat = seatOf(index);
        const { i, j } = cellOf(index);
        const height = (Math.sin(p * Math.PI * 4 + i * 0.7) * 0.5 + 0.5) * 0.75 + 0.2;
        const lit = GRID - 1 - j <= height * GRID ? 1 : 0;
        const size = lerp(b.size * 0.9, seat.size, lit);
        return { ...b, size, radius: size * roundnessAt(lit), alpha: lit === 1 ? 1 : 0.2 };
      });
    } else if (current.act === 'reveal') {
      /*
       * 3D — "dramatically reveal it rotating seamlessly from the 2d animation
       * to 3d".
       *
       * Seamless because nothing is swapped: `solidity` rises from 0, and at 0
       * the renderer draws exactly the flat rounded square it drew a frame
       * earlier. The board tilts and turns about its own centre while each
       * square grows a height, so the grid becomes a field of solids with no cut.
       */
      /*
       * IT STANDS UP, TURNS, AND LIES BACK DOWN.
       *
       * Two things the first cut got wrong, both visible and neither caught by
       * the position test:
       *
       *  - A full 2*PI yaw takes the board EDGE-ON twice, where every top face
       *    collapses to a line and the solid reads as a glitch rather than as a
       *    rotation. A turntable swing of about +-54 degrees shows every face
       *    obliquely and never degenerates.
       *  - The act used to END solid and tilted, while `merge` is flat by
       *    definition — so the 3D snapped back to 2D in a single frame at the
       *    join. The envelope returns to zero, so the last frame of the reveal
       *    IS a flat grid, which is exactly what merge expects. Seamless has to
       *    mean at both ends.
       */
      const env = Math.sin(Math.PI * p) ** 0.65;
      solidity = env;
      pitch = env * 0.62;
      yaw = env * 0.95 * Math.sin(p * Math.PI * 2);
      blocks = blocks.map((b) => ({
        ...b,
        lift: env * (0.9 + (0.5 + 0.5 * Math.sin(p * Math.PI * 2 + (b.cx + b.cy) * 0.18)) * 2.8),
      }));
    }
  }

  return { blocks, act: current.act, yaw, pitch, solidity };
}
