/**
 * The app's own mark, for the sidebar's top-left identity row — and, when it has
 * to stand in for something that is still being made, the same three tiles
 * sliding around their own board.
 *
 * the user: "put text that says <app icon those three squares in the app icon>
 * Bobble, with the app icon in the top left above the search chats bar below
 * the traffic light buttons."
 *
 * Drawn inline rather than loaded from build/icon.png so it is crisp at 20px,
 * re-themes with the app, and costs no request — the icon file is a 1024px
 * raster meant for the Dock.
 *
 * NO PLATE — deliberately, and NOT in step with the Dock icon, which has its
 * dark squircle back (the user: "restore the dark background to the app icon, (but
 * not to the top left icon, make that one slightly bigger also)").
 *
 * The two therefore differ on purpose. In the Dock an icon needs its own ground
 * to sit on, because it is competing with thirty other apps on an unknown
 * wallpaper. Here the sidebar already IS the ground, so a plate would just be a
 * dark square on a dark panel — the tiles alone read as the mark.
 */

/*
 * ONE GEOMETRY FOR BOTH. The mark and the loader read the same numbers from
 * bobble-tiles.ts, so the thing that slides is provably the app's own icon
 * rather than a second drawing of it that will drift the first time either is
 * touched. The board, the laps and the beat schedule live there because they
 * have a RULE that can be got wrong — see that file, and its test.
 */
import { BOBBLE_CELLS, BOBBLE_TILE, BOBBLE_TILES, bobbleLap } from './bobble-tiles';

export function BobbleMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Bobble"
      style={{ display: 'block' }}
    >
      <title>Bobble</title>
      {BOBBLE_TILES.map((tile) => {
        const cell = BOBBLE_CELLS.find((c) => c.id === tile.from);
        return (
          <rect
            key={tile.id}
            x={cell?.x ?? 0}
            y={cell?.y ?? 0}
            width={BOBBLE_TILE.size}
            height={BOBBLE_TILE.size}
            rx={BOBBLE_TILE.radius}
            /* White on the dark theme, BLACK on the light one — the user, with
               the sidebar mark in light mode: "in light mode make these
               black." The token lives in global.css beside the theme
               selectors; the tile's own fill is the dark-theme fallback. */
            fill={`var(--pd-bobble-mark-ink, ${tile.fill})`}
          />
        );
      })}
    </svg>
  );
}

/**
 * THE WAIT, AS THE MARK SOLVING ITSELF.
 *
 * the user: "show the bobble logo as a loader with the squares sliding clockwise
 * like a sliding tile puzzle, until there is a diffusion step ready."
 *
 * So this is not a spinner wearing the brand colours — it is the icon's own
 * three tiles, on the icon's own board, obeying the one rule a sliding puzzle
 * has: a tile may only move into the empty cell next to it. One tile moves per
 * beat and the empty cell walks the other way, which is what makes the motion
 * read as *sliding* rather than three squares orbiting a point.
 *
 * Every tile's lap is the same shape — four cells clockwise — so ONE keyframe
 * animation drives all three; each tile supplies its own four cells as custom
 * properties and its own beat as a delay. See `.pd-bobble-loader` in global.css.
 *
 * Under `prefers-reduced-motion` the tiles hold still (the CSS drops the
 * animation) and the mark simply sits there as the mark: a permanent loop is a
 * real cost, and the card around this one already carries a clock that moves.
 */
export function BobbleTileLoader({
  size = 44,
  label = 'Working',
}: {
  size?: number;
  /** Announced to screen readers. The card's own caption says the rest. */
  label?: string;
}) {
  return (
    <svg
      className="pd-bobble-loader"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={label}
      data-testid="bobble-tile-loader"
    >
      <title>{label}</title>
      {BOBBLE_TILES.map((tile) => {
        const lap = bobbleLap(tile.from);
        const home = lap[0];
        const vars: Record<string, string> = {};
        lap.forEach((cell, i) => {
          // The lap is expressed as a DELTA from the rect's own resting x/y, so
          // the rect keeps its authored position and the animation only ever
          // adds a translation — the still mark and the moving one share a frame.
          vars[`--pd-bt-x${i}`] = `${cell.x - (home?.x ?? 0)}px`;
          vars[`--pd-bt-y${i}`] = `${cell.y - (home?.y ?? 0)}px`;
        });
        return (
          <rect
            key={tile.id}
            className="pd-bobble-tile"
            data-tile={tile.id}
            x={home?.x ?? 0}
            y={home?.y ?? 0}
            width={BOBBLE_TILE.size}
            height={BOBBLE_TILE.size}
            rx={BOBBLE_TILE.radius}
            fill={tile.fill}
            style={{ ...vars, animationDelay: `calc(var(--pd-bt-beat) * ${tile.phase})` }}
          />
        );
      })}
    </svg>
  );
}
