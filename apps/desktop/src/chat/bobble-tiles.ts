/**
 * THE BOARD THE APP ICON IS ALREADY ON.
 *
 * The Bobble mark is three rounded squares in a 2x2 grid with the top-left cell
 * empty — which is a sliding-tile puzzle that has never been played. the user asked
 * for it to be: "show the bobble logo as a loader with the squares sliding
 * clockwise like a sliding tile puzzle, until there is a diffusion step ready."
 *
 * The geometry and the schedule live here, apart from the component, for one
 * reason: a sliding puzzle has a RULE, and a rule is a thing you can be wrong
 * about. Only the tile beside the hole may move, and it may only move into the
 * hole. Get a phase or a lap wrong and you get two squares occupying one cell,
 * or a tile teleporting across the board — both of which look like a bug rather
 * than like a puzzle, and neither of which a screenshot reliably catches.
 * bobble-tiles.test.ts plays the whole cycle and checks every frame.
 */

/** One cell of the 2x2 board, in the 32-unit icon coordinate system. */
export interface TileCell {
  readonly id: 'tl' | 'tr' | 'br' | 'bl';
  readonly x: number;
  readonly y: number;
}

/** Tile size, corner radius and board pitch, straight from the app icon. */
export const BOBBLE_TILE = { size: 12.5, radius: 3.5, pitch: 14, origin: 2.75 } as const;

/** The four cells, in CLOCKWISE order — the order the tiles travel. */
export const BOBBLE_CELLS: readonly TileCell[] = [
  { id: 'tl', x: 2.75, y: 2.75 },
  { id: 'tr', x: 16.75, y: 2.75 },
  { id: 'br', x: 16.75, y: 16.75 },
  { id: 'bl', x: 2.75, y: 16.75 },
];

/**
 * The three tiles: colour, resting cell in the still mark, and which beat of the
 * cycle each one moves on first.
 *
 * The phases are not a stylistic choice. With the hole at TL, the only tile that
 * may move is the one at BL (the cell counter-clockwise of the hole), which
 * leaves the hole at BL, where the only mover is BR — and so on. Yellow, then
 * pink, then teal, one per beat, forever.
 */
/*
 * ALL WHITE. the user: "make the app icon rounded corner squares all 100% white in
 * the app and the dock icon." The ids keep their old colour names because the
 * puzzle's beat order is written in terms of them (yellow, then pink, then
 * teal) and the tests read them; the fill is the only thing that changed.
 */
export const BOBBLE_TILE_FILL = '#FFFFFF';

export const BOBBLE_TILES = [
  { id: 'teal', fill: BOBBLE_TILE_FILL, from: 'tr', phase: 2 },
  { id: 'yellow', fill: BOBBLE_TILE_FILL, from: 'bl', phase: 0 },
  { id: 'pink', fill: BOBBLE_TILE_FILL, from: 'br', phase: 1 },
] as const;

/**
 * The beat schedule, in beats of a 12-beat cycle. The CSS keyframes are these
 * numbers as percentages of 12 (see `@keyframes pd-bobble-slide`), and
 * bobble-tiles.test.ts asserts the two agree — so this is the single definition
 * even though the animation itself runs in CSS.
 */
export const TILE_SCHEDULE = {
  /** Beats in one full cycle. Twelve returns every tile to where it began. */
  cycle: 12,
  /** How long one slide takes, in beats. */
  move: 0.4,
  /** The beat each of a tile's four moves begins on, in its own local time. */
  moveAt: [1, 4, 7, 10] as const,
} as const;

/** The clockwise lap a tile takes, starting from the cell it rests in. */
export function bobbleLap(from: string): readonly TileCell[] {
  const start = BOBBLE_CELLS.findIndex((c) => c.id === from);
  const at = start === -1 ? 0 : start;
  return BOBBLE_CELLS.map((_, i) => BOBBLE_CELLS[(at + i) % BOBBLE_CELLS.length] as TileCell);
}

/**
 * Where a tile is at `beat`, or the two cells it is between mid-slide.
 *
 * The same schedule the CSS runs: the tile holds at its first cell through its
 * phase delay, then moves on beats 1, 4, 7 and 10 of every cycle. Returns one
 * cell id when the tile is at rest and two when it is sliding, so the test can
 * assert BOTH that nothing overlaps and that nothing teleports.
 */
export function tileAt(
  tile: { readonly from: string; readonly phase: number },
  beat: number,
): readonly TileCell[] {
  const lap = bobbleLap(tile.from);
  const local = beat - tile.phase;
  if (local < 0) return [lap[0] as TileCell];
  const c = local % TILE_SCHEDULE.cycle;
  for (let i = 0; i < TILE_SCHEDULE.moveAt.length; i++) {
    const at = TILE_SCHEDULE.moveAt[i] as number;
    if (c >= at && c < at + TILE_SCHEDULE.move) {
      return [lap[i] as TileCell, lap[(i + 1) % lap.length] as TileCell];
    }
  }
  // Resting: after the nth move and before the (n+1)th.
  let index = 0;
  for (let i = 0; i < TILE_SCHEDULE.moveAt.length; i++) {
    if (c >= (TILE_SCHEDULE.moveAt[i] as number) + TILE_SCHEDULE.move) index = i + 1;
  }
  return [lap[index % lap.length] as TileCell];
}
