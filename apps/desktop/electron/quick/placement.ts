/**
 * WHERE THE QUICK PANEL APPEARS, AND HOW BIG IT IS.
 *
 * On the display under the pointer — the one the person is looking at, which on
 * a two-display desk is not necessarily the main one — horizontally centred and
 * a fifth of the way down, where Spotlight puts its field. The TOP edge is the
 * anchor: when an answer arrives the panel grows downward, so the line you were
 * typing in does not jump.
 *
 * Pure: no electron. main.ts-side code hands in the work area.
 */
import type { Rect } from './region-math';

/** The three sizes the panel can be. */
export type PanelSize = 'compact' | 'expanded' | 'large';

/**
 * Compact is the field, its context chips and the action row; expanded adds
 * the thread; large is for reading a long answer. Heights are the most the
 * panel will take — a short answer leaves room to spare rather than resizing
 * the window on every streamed token.
 */
export const PANEL_SIZES: Readonly<Record<PanelSize, { width: number; height: number }>> = {
  compact: { width: 680, height: 212 },
  expanded: { width: 720, height: 560 },
  large: { width: 960, height: 760 },
};

/** How far down the work area the panel's top sits. */
const TOP_FRACTION = 0.2;
/** Never closer to a work-area edge than this. */
const MARGIN = 16;

/** The panel's frame for a size on a display's work area. */
export function panelBounds(workArea: Rect, size: PanelSize): Rect {
  const want = PANEL_SIZES[size];
  const width = Math.min(want.width, Math.max(320, workArea.width - MARGIN * 2));
  const height = Math.min(want.height, Math.max(160, workArea.height - MARGIN * 2));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const top = Math.round(workArea.y + workArea.height * TOP_FRACTION);
  // Push up if a tall size would run off the bottom.
  const y = Math.max(
    workArea.y + MARGIN,
    Math.min(top, workArea.y + workArea.height - height - MARGIN),
  );
  return { x, y, width, height };
}

/**
 * The frame for a new size, keeping the panel where the person left it.
 *
 * Its top-left stays put (a dragged, pinned panel is exactly where they want
 * it), and it is nudged back inside the work area only if growing would push it
 * off — a large panel near the bottom slides up rather than hanging off-screen.
 */
export function resizeInPlace(current: Rect, size: PanelSize, workArea: Rect): Rect {
  const want = PANEL_SIZES[size];
  const width = Math.min(want.width, workArea.width - MARGIN * 2);
  const height = Math.min(want.height, workArea.height - MARGIN * 2);
  // Keep the horizontal centre, so compact → expanded grows evenly to both sides.
  const cx = current.x + current.width / 2;
  let x = Math.round(cx - width / 2);
  let y = current.y;
  x = Math.max(workArea.x + MARGIN, Math.min(x, workArea.x + workArea.width - width - MARGIN));
  y = Math.max(workArea.y + MARGIN, Math.min(y, workArea.y + workArea.height - height - MARGIN));
  return { x, y, width, height };
}
