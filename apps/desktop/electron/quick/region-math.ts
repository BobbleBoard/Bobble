/**
 * THE GEOMETRY OF "ASK ABOUT THIS PART OF THE SCREEN".
 *
 * Three coordinate spaces meet here, and every bug in an area capture is one of
 * them being mistaken for another:
 *
 *   overlay-local   CSS pixels inside one display's selection overlay. The
 *                   overlay covers that display exactly, so these are points
 *                   measured from the display's top-left corner.
 *   global points   Electron's screen space — the same top-left-origin, y-down
 *                   points CGWindowList reports window frames in. A display to
 *                   the LEFT of the main one has negative x; one above it has
 *                   negative y.
 *   image pixels    the captured picture of one display. On a Retina display
 *                   that is twice the points in each direction, and the capture
 *                   API is free to hand back something slightly different, so
 *                   the scale is read from the IMAGE, never assumed from
 *                   `scaleFactor`.
 *
 * A selection belongs to the display it was drawn on (each display has its own
 * overlay, as macOS's own ⇧⌘4 does), so a crop is always one picture's pixels.
 *
 * Pure: no electron. Unit-tested with mixed-scale, negative-origin layouts.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One display as Electron's `screen` describes it — just what the math needs. */
export interface DisplayGeometry {
  readonly id: number;
  /** Global points, the whole display (menu bar included). */
  readonly bounds: Rect;
  readonly scaleFactor: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A drag from `a` to `b`, in whichever direction it went, as a rect. */
export function normalizeDrag(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Smaller than this in either direction is a click, not a selection. */
export const MIN_SELECTION_POINTS = 6;

export function isClickNotDrag(r: Rect): boolean {
  return r.width < MIN_SELECTION_POINTS || r.height < MIN_SELECTION_POINTS;
}

/** `r` cut down to lie inside `within` (zero-sized when they do not meet). */
export function clampRect(r: Rect, within: Rect): Rect {
  const x0 = Math.max(r.x, within.x);
  const y0 = Math.max(r.y, within.y);
  const x1 = Math.min(r.x + r.width, within.x + within.width);
  const y1 = Math.min(r.y + r.height, within.y + within.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** An overlay-local rect (points from the display's corner) in global points. */
export function localToGlobal(r: Rect, display: DisplayGeometry): Rect {
  return { x: r.x + display.bounds.x, y: r.y + display.bounds.y, width: r.width, height: r.height };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function overlap(a: Rect, b: Rect): number {
  return rectArea(clampRect(a, b));
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/** The display a point is on; the nearest one when it is in a gap between them. */
export function displayForPoint<D extends DisplayGeometry>(
  p: Point,
  displays: readonly D[],
): D | null {
  const inside = displays.find((d) => containsPoint(d.bounds, p));
  if (inside !== undefined) return inside;
  let best: D | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of displays) {
    const cx = Math.min(Math.max(p.x, d.bounds.x), d.bounds.x + d.bounds.width);
    const cy = Math.min(Math.max(p.y, d.bounds.y), d.bounds.y + d.bounds.height);
    const dist = (cx - p.x) ** 2 + (cy - p.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** The display a rect is mostly on (a window straddling two belongs to the bigger share). */
export function displayForRect<D extends DisplayGeometry>(
  r: Rect,
  displays: readonly D[],
): D | null {
  let best: D | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = overlap(r, d.bounds);
    if (a > bestArea) {
      bestArea = a;
      best = d;
    }
  }
  return best ?? displayForPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, displays);
}

/**
 * The pixels of `display`'s capture that a global-points rect covers.
 *
 * Rounded OUTWARD — a selection edge that falls between two pixels keeps the
 * pixel it touches rather than shaving a line off what the person drew — and
 * clamped to the picture. Null when the rect misses the display entirely.
 */
export function cropInImage(
  globalRect: Rect,
  display: DisplayGeometry,
  image: Size,
): { x: number; y: number; width: number; height: number } | null {
  const onDisplay = clampRect(globalRect, display.bounds);
  if (onDisplay.width <= 0 || onDisplay.height <= 0) return null;
  if (display.bounds.width <= 0 || display.bounds.height <= 0) return null;
  const sx = image.width / display.bounds.width;
  const sy = image.height / display.bounds.height;
  const x0 = Math.floor((onDisplay.x - display.bounds.x) * sx);
  const y0 = Math.floor((onDisplay.y - display.bounds.y) * sy);
  const x1 = Math.ceil((onDisplay.x + onDisplay.width - display.bounds.x) * sx);
  const y1 = Math.ceil((onDisplay.y + onDisplay.height - display.bounds.y) * sy);
  const x = Math.max(0, Math.min(x0, image.width));
  const y = Math.max(0, Math.min(y0, image.height));
  const width = Math.max(0, Math.min(x1, image.width) - x);
  const height = Math.max(0, Math.min(y1, image.height) - y);
  if (width === 0 || height === 0) return null;
  return { x, y, width, height };
}

/**
 * The pixel size to ask the capture API for, for a whole display: its points
 * times its scale. What comes back is still measured, not trusted (see
 * {@link cropInImage}).
 */
export function capturePixelSize(display: DisplayGeometry): Size {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
}

/** One on-screen window, front to back, as the window server lists it. */
export interface ScreenWindow {
  readonly windowId: number;
  readonly pid: number;
  readonly app: string;
  /** Global points. */
  readonly bounds: Rect;
  /** 0 is an ordinary document window; menus, the Dock and overlays are higher. */
  readonly layer: number;
}

/**
 * The window a click lands on in "pick a window" mode: the frontmost ordinary
 * window under the point that is not Bobble's own. Null on the desktop.
 */
export function windowAtPoint<W extends ScreenWindow>(
  p: Point,
  windows: readonly W[],
  ownPids: readonly number[],
): W | null {
  for (const w of windows) {
    if (w.layer !== 0) continue;
    if (ownPids.includes(w.pid)) continue;
    if (w.bounds.width < 40 || w.bounds.height < 40) continue;
    if (containsPoint(w.bounds, p)) return w;
  }
  return null;
}

/** "640 × 480" — the size label beside a selection, in points. */
export function selectionLabel(r: Rect): string {
  return `${Math.round(r.width)} × ${Math.round(r.height)}`;
}
