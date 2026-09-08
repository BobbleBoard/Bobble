/**
 * Pure geometry for the computer-use monitor surface.
 *
 * Everything the surface draws is a mapping between three spaces, and every one
 * of them has bitten someone before:
 *
 *   1. GLOBAL SCREEN POINTS — where macOS puts windows and where the phantom
 *      cursor's position is reported (the same space `overlay-geometry.ts`
 *      works in, deliberately).
 *   2. THE DRAWN WINDOW — the captured picture placed inside the tab: centred,
 *      at its REAL point size, scaled DOWN only when the tab is too small.
 *   3. CANVAS CSS PIXELS — what the 2D context draws in.
 *
 * They live here, separate from the React surface, because the rule "never
 * upscale" and the rule "the cursor lands exactly where it landed on screen"
 * are assertions, not opinions.
 */

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where the captured window is drawn, in canvas CSS pixels. */
export interface DrawnWindow extends Rect {
  /** Canvas px per screen point. `1` = real size; never greater than 1. */
  readonly scale: number;
}

/**
 * Place `content` (in screen POINTS) inside `viewport` (canvas CSS px),
 * centred, at real size — scaled DOWN only when it does not fit.
 *
 * the user, verbatim: "show it in full but show the user's desktop background
 * wallpaper behind it (center the window and keep it sized exactly how it is in
 * reality)". So the scale is `min(1, fitX, fitY)` and never anything else: a
 * 600pt window in a 1200px tab stays 600px, floating on the wallpaper, rather
 * than being blown up into a soft mess.
 *
 * `padding` keeps the window off the tab's edges when it IS being scaled down;
 * a window that already fits is never pushed around by it.
 */
export function fitWindow(content: Size, viewport: Size, padding = 0): DrawnWindow {
  const w = Math.max(1, content.w);
  const h = Math.max(1, content.h);
  const availW = Math.max(1, viewport.w - padding * 2);
  const availH = Math.max(1, viewport.h - padding * 2);
  const scale = Math.min(1, availW / w, availH / h);
  const drawW = w * scale;
  const drawH = h * scale;
  return {
    x: (viewport.w - drawW) / 2,
    y: (viewport.h - drawH) / 2,
    w: drawW,
    h: drawH,
    scale,
  };
}

/**
 * The SECOND placement mode: follow the action instead of fitting the window.
 *
 * `fitWindow` is right when the tab can hold the window at a readable size. In
 * the docked rail it cannot — a 900×620pt window in a 440px rail comes out at
 * 0.45, which is a picture of a window rather than a window, and a real
 * 1440×900 Safari window comes out at 0.30. Apple's own binary for this is
 * "fit in the window" vs "actual size with scrolling" (Screen Sharing); this is
 * the second option with the scrolling done for you.
 *
 * So: hold the scale at `minScale` (never upscaling past 1, never going BELOW
 * what `fitWindow` would give — if the whole window already fits at a better
 * scale, this returns exactly `fitWindow`'s answer), and slide the window under
 * the viewport so `focus` — the cursor, or the dialog's centre — stays in view.
 * The returned rect is the WHOLE window's box, so `x`/`y` are routinely
 * negative: everything else on this surface maps screen points through
 * `drawn.x + (p.x - rect.x) * scale`, and that keeps working unchanged whether
 * the window is letterboxed inside the stage or cropped by it.
 */
export function followWindow(
  content: Rect,
  viewport: Size,
  focus: Point,
  minScale = 0.85,
  padding = 0,
): DrawnWindow {
  const fit = fitWindow(content, viewport, padding);
  // COVER, not contain: the point of this mode is that the docked rail is full
  // of the app rather than full of wallpaper, so the target is the smallest
  // scale that leaves no letterbox — which on a rail taller than the window is
  // real size, the composition this surface is built on. Clamped by the floor
  // (a huge window still has to be cropped somewhere) and by 1 (never upscale).
  const cover = Math.max(
    viewport.w / Math.max(1, content.w),
    viewport.h / Math.max(1, content.h),
  );
  const scale = Math.min(1, Math.max(minScale, cover));
  if (scale <= fit.scale) return fit;
  const w = Math.max(1, content.w) * scale;
  const h = Math.max(1, content.h) * scale;
  const axis = (span: number, view: number, at: number): number => {
    // Smaller than the viewport on this axis → centre it, exactly as fit does.
    if (span <= view) return (view - span) / 2;
    // Larger → centre the focus, then clamp so no wallpaper shows through a
    // gap the window could have covered.
    return Math.min(0, Math.max(view - span, view / 2 - at * scale));
  };
  return {
    x: axis(w, viewport.w, focus.x - content.x),
    y: axis(h, viewport.h, focus.y - content.y),
    w,
    h,
    scale,
  };
}

/**
 * The visible slice of the window, in SCREEN POINTS — what the minimap outlines
 * and what the follow camera's dead zone is measured against.
 */
export function visibleRegion(content: Rect, viewport: Size, drawn: DrawnWindow): Rect {
  const k = drawn.scale <= 0 ? 1 : drawn.scale;
  const x = content.x + Math.max(0, -drawn.x) / k;
  const y = content.y + Math.max(0, -drawn.y) / k;
  const w = Math.min(content.w, viewport.w / k);
  const h = Math.min(content.h, viewport.h / k);
  return { x, y, w, h };
}

/**
 * Breathing room around a window that has to be scaled down.
 *
 * Proportional to the TIGHT axis rather than fixed at 18: in the docked rail
 * the review measured ~190px of dead wallpaper above the window and ~150 below,
 * and a fixed pad is a bigger share of a 440px rail than of a 1680px stage.
 */
export function stagePadding(viewport: Size): number {
  const tight = Math.min(viewport.w, viewport.h);
  return Math.round(Math.min(18, Math.max(4, tight * 0.03)));
}

/**
 * Map a GLOBAL SCREEN POINT (a phantom-cursor position, an element centre) into
 * canvas CSS pixels, given the window rect that was captured and where it was
 * drawn. Points outside the window map outside the drawn rect — deliberately:
 * an action a hair past the frame should read as being a hair past the frame,
 * exactly as the real overlay's buffer margin lets it.
 */
export function screenToCanvas(point: Point, windowRect: Rect, drawn: DrawnWindow): Point {
  return {
    x: drawn.x + (point.x - windowRect.x) * drawn.scale,
    y: drawn.y + (point.y - windowRect.y) * drawn.scale,
  };
}

/**
 * Source crop for a COVER fit: the largest centred region of `source` with
 * `viewport`'s aspect ratio. Used for the wallpaper backdrop, which must fill
 * the tab with no letterboxing and no distortion.
 */
export function coverCrop(source: Size, viewport: Size): Rect {
  if (source.w <= 0 || source.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return { x: 0, y: 0, w: Math.max(1, source.w), h: Math.max(1, source.h) };
  }
  const target = viewport.w / viewport.h;
  const actual = source.w / source.h;
  if (actual > target) {
    const w = source.h * target;
    return { x: (source.w - w) / 2, y: 0, w, h: source.h };
  }
  const h = source.w / target;
  return { x: 0, y: (source.h - h) / 2, w: source.w, h };
}

/**
 * How large to draw the phantom cursor and its bubble.
 *
 * The real overlay draws them at screen scale; a window scaled to 0.35 would
 * therefore give a 4px bubble, which is not an instrument panel, it is a smudge.
 * Tracking the window's scale keeps the cursor reading as part of the picture,
 * and the floor keeps it legible. Clamped, never inverted: the annotation never
 * grows past life size.
 *
 * The floor was 0.78, which at the docked scale of 0.45 drew the annotation at
 * 1.7× the window's own scale — a bubble spanning 28% of the window, over the
 * dialog's Cancel button. The floor was solving the wrong problem: the fix for
 * a too-small window is a bigger window ({@link followWindow}), not an
 * oversized annotation, so it is now 0.62 and the picture carries the rest.
 */
export function annotationScale(windowScale: number, floor = 0.62): number {
  if (!Number.isFinite(windowScale) || windowScale <= 0) return floor;
  return Math.min(1, Math.max(floor, windowScale));
}

/**
 * Place the status bubble beside the cursor, flipping it back inside the
 * viewport near the right/bottom edge — the same rule overlay.html applies with
 * its `.flip-x` / `.flip-y` classes, so the two read as one object.
 *
 * Offsets are in already-scaled canvas pixels; `size` is the bubble's measured
 * box. Returns the bubble's top-left corner.
 */
export function bubbleAnchor(
  cursor: Point,
  size: Size,
  viewport: Size,
  offset: Point = { x: 27, y: 40 },
  margin = 8,
): Point & { flipX: boolean; flipY: boolean } {
  const flipX = cursor.x + offset.x + size.w > viewport.w - margin;
  const flipY = cursor.y + offset.y + size.h > viewport.h - margin;
  const x = flipX
    ? Math.max(margin, Math.min(cursor.x - offset.x - size.w, viewport.w - margin - size.w))
    : cursor.x + offset.x;
  const y = flipY
    ? Math.max(margin, Math.min(cursor.y - offset.y * 0.35 - size.h, viewport.h - margin - size.h))
    : cursor.y + offset.y;
  return { x, y, flipX, flipY };
}

/**
 * The overlay's cursor travel easing — `cubic-bezier(0.22, 0.9, 0.32, 1.1)`,
 * evaluated for a normalized time. Duplicated here (rather than "roughly an
 * ease-out") so the canvas phantom glides on exactly the curve the on-screen one
 * does; a different curve is a different object.
 */
export function cursorEase(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return cubicBezier(0.22, 0.9, 0.32, 1.1, clamped);
}

/** Solve y for x on a CSS cubic-bezier(x1,y1,x2,y2) curve (Newton + bisection). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 6; i++) {
    const dx = sampleX(t) - x;
    if (Math.abs(dx) < 1e-6) break;
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  if (t < 0 || t > 1) {
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-6) break;
      if (dx > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}
