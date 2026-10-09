/**
 * THE AGENT CURSOR — one drawing for every phantom pointer Bobble shows.
 *
 * There are three of them: the native NSPanel painted over the real screen
 * during computer use (packages/pi-mac/swift/.../Overlay.swift `pointerGlyph`),
 * the one painted over the PICTURE of that window in the canvas's computer-use
 * tab (packages/canvas computer-use-surface), and the one injected into the
 * page of the built-in browser while the model browses (apps/desktop/electron
 * browser-scripts). The user, seeing the browser one: "cursor is an old version not
 * the computer use cursor … these should be linked and the same, current
 * computer use one is correct." And of the canvas one: "shows the old colored
 * cursor with the status pill really far away from it … it's drawn correctly
 * on the real application window."
 *
 * So the numbers live HERE, once, and the Swift overlay is the reference they
 * are copied from — the shape is the user's own SVG (their path verbatim, arcs and
 * all), the paint is their 2026-09-15 brief ("a black fill, and a subtle blue
 * edge glow", the white keyline kept at their thickness), the size their "size
 * cursor up maybe 15%", and the pill's distance their "bring pill a bit closer to
 * it". Anything that draws a phantom pointer reads these; nothing else may
 * carry its own copy. This package imports nothing, so the Electron main
 * process (which injects the browser cursor) and the canvas package (which
 * paints the monitor) can both reach it.
 */

/** His path, in the artwork's own 291-wide, y-down viewBox. */
export const AGENT_CURSOR_PATH =
  'M 58.48 87.06 A 24.06 25.11 -36 0 1 93.89 61.34 L 223.67 137.27 ' +
  'A 18.23 19.02 -36 0 1 218.85 171.89 A 117.23 122.31 -36 0 0 131.29 247.95 ' +
  'A 19.66 20.51 -36 0 1 92.88 244.4 Z';

/** His keyline width, in viewBox units, so it scales WITH the glyph rather
 * than going fat as the cursor shrinks. */
export const AGENT_CURSOR_STROKE_W = 13.79;

/**
 * The box the glyph is drawn in: the path's bounds (control points included —
 * CGPath.boundingBox, which is what the Swift measures) grown by half the
 * keyline, because the stroke straddles the outline and anything less shaves it.
 */
export const AGENT_CURSOR_BOX = { x: 49.499, y: 49.514, w: 191.719, h: 219.132 } as const;

/** How tall the pointer is drawn, in points/CSS px, at real size. The overlay's
 * OVERLAY_GLYPH_HEIGHT: 22 × 1.15. */
export const AGENT_CURSOR_HEIGHT = 25.3;

/**
 * THE HOT SPOT, as a fraction of the box: the point of the pointer — the
 * rounded corner between the first arc's ends (his apex at 67.563, 62.329),
 * pulled out along the up-left diagonal by half the keyline so the tip is the
 * tip of what is DRAWN, not of the centre line.
 */
export const AGENT_CURSOR_TIP = { x: 0.06905, y: 0.03646 } as const;

/** The body: near-black, the way the Mac's own pointer is drawn. */
export const AGENT_CURSOR_BODY = '#0a0b0f';
/** The keyline over it, at his thickness, plus a thin bright line on top. */
export const AGENT_CURSOR_KEYLINE = '#ffffff';
/** The fraction of the keyline the thin top line is. */
export const AGENT_CURSOR_KEYLINE_THIN = 0.34;
/** The edge glow: the pill's blue, not the old teal halo. */
export const AGENT_CURSOR_GLOW = '#2769ef';
/**
 * The glow is the outline stroked in that blue (1.1 keylines wide) and blurred
 * outward by five keylines, at a low opacity — a hint at the edge; the black
 * body carries the shape. A second copy, screen-blended, adds light only on a
 * dark ground ("slightly more glow on dark, keep white as is").
 */
export const AGENT_CURSOR_GLOW_BAND = 1.1;
export const AGENT_CURSOR_GLOW_SIGMA = 5;
export const AGENT_CURSOR_GLOW_OPACITY = 0.36;
export const AGENT_CURSOR_GLOW_DARK_OPACITY = 0.32;
/** One soft neutral shadow under the glyph (σ and offset in points at real size). */
export const AGENT_CURSOR_SHADOW = { color: 'rgba(13, 15, 33, 0.3)', sigma: 3.2, dy: 1.4 } as const;

/** The press: the glyph squeezes to 0.78 and back in 150 ms, about its tip.
 * No ring, no ripple — the overlay dropped those. */
export const AGENT_CURSOR_PRESS = { scale: 0.78, ms: 150 } as const;

/** Travel time for a glide; the tool side waits the animation out. */
export const AGENT_CURSOR_TRAVEL_MS = 300;
/** The glide's curve — CSS `cubic-bezier(0.22, 0.9, 0.32, 1.1)`. */
export const AGENT_CURSOR_EASE = [0.22, 0.9, 0.32, 1.1] as const;

/** The status pill: the overlay's blue, its corner radius, and where it parks —
 * below-right of the tip by this much, flipping to the other side and clamped
 * inside the window it belongs to. */
export const AGENT_PILL_FILL = 'rgba(39, 105, 239, 0.96)';
export const AGENT_PILL_RADIUS = 13;
export const AGENT_PILL_OFFSET = { x: 11, y: 15 } as const;
/** Flip this close to the window's edge; clamp this far inside it. */
export const AGENT_PILL_FLIP_MARGIN = 8;
export const AGENT_PILL_CLAMP_INSET = 4;

/** The drawn size at a given height, and the tip's position inside it (px). */
export function agentCursorSize(height = AGENT_CURSOR_HEIGHT): {
  w: number;
  h: number;
  tip: { x: number; y: number };
} {
  const w = (height * AGENT_CURSOR_BOX.w) / AGENT_CURSOR_BOX.h;
  return { w, h: height, tip: { x: AGENT_CURSOR_TIP.x * w, y: AGENT_CURSOR_TIP.y * height } };
}

/**
 * The cursor as a self-contained SVG at `height` CSS px — the same layer stack
 * the overlay paints: the soft shadow, the blurred blue rim (the glow), the
 * black body under the white keyline, the thin line on top. The filters spill
 * past the box on purpose (`overflow: visible`): a glow that stops at the
 * element's edge is a square.
 *
 * The screen-blended "more on dark" glow is not here: an SVG can only blend
 * with its own contents, and the page under an overlay is not among them.
 */
export function agentCursorSvg(height = AGENT_CURSOR_HEIGHT): string {
  const { w, h } = agentCursorSize(height);
  const scale = height / AGENT_CURSOR_BOX.h;
  const box = `${AGENT_CURSOR_BOX.x} ${AGENT_CURSOR_BOX.y} ${AGENT_CURSOR_BOX.w} ${AGENT_CURSOR_BOX.h}`;
  const glowSigma = AGENT_CURSOR_STROKE_W * AGENT_CURSOR_GLOW_SIGMA;
  const shadowSigma = AGENT_CURSOR_SHADOW.sigma / scale;
  const shadowDy = AGENT_CURSOR_SHADOW.dy / scale;
  const band = (AGENT_CURSOR_STROKE_W * AGENT_CURSOR_GLOW_BAND).toFixed(2);
  const thin = (AGENT_CURSOR_STROKE_W * AGENT_CURSOR_KEYLINE_THIN).toFixed(2);
  return (
    `<svg width="${w.toFixed(2)}" height="${h.toFixed(2)}" viewBox="${box}" ` +
    'style="overflow:visible;display:block" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs>' +
    '<filter id="pi-cur-glow" x="-150%" y="-150%" width="400%" height="400%" color-interpolation-filters="sRGB">' +
    `<feGaussianBlur stdDeviation="${glowSigma.toFixed(2)}"/></filter>` +
    '<filter id="pi-cur-shadow" x="-80%" y="-80%" width="260%" height="260%" color-interpolation-filters="sRGB">' +
    `<feGaussianBlur stdDeviation="${shadowSigma.toFixed(2)}"/></filter>` +
    '</defs>' +
    `<path d="${AGENT_CURSOR_PATH}" fill="${AGENT_CURSOR_SHADOW.color}" ` +
    `transform="translate(0 ${shadowDy.toFixed(2)})" filter="url(#pi-cur-shadow)"/>` +
    `<path d="${AGENT_CURSOR_PATH}" fill="${AGENT_CURSOR_GLOW}" stroke="${AGENT_CURSOR_GLOW}" ` +
    `stroke-width="${band}" stroke-linejoin="round" opacity="${AGENT_CURSOR_GLOW_OPACITY}" filter="url(#pi-cur-glow)"/>` +
    `<path d="${AGENT_CURSOR_PATH}" fill="${AGENT_CURSOR_BODY}" stroke="${AGENT_CURSOR_KEYLINE}" ` +
    `stroke-width="${AGENT_CURSOR_STROKE_W}" stroke-linejoin="round"/>` +
    `<path d="${AGENT_CURSOR_PATH}" fill="none" stroke="${AGENT_CURSOR_KEYLINE}" ` +
    `stroke-width="${thin}" stroke-linejoin="round"/>` +
    '</svg>'
  );
}

/** Where the pill's box goes beside a tip, the overlay's `layoutBubble` rule:
 * below-right by the offset, flipped to the other side within `flipMargin` of
 * the bounds' right/bottom edge, then clamped `inset` inside the bounds so no
 * part lands outside them (a cursor in a corner, a window narrower than the
 * pill). Everything in the same units (points or px); `bounds` is the window
 * the phantom belongs to — spilling past it is spilling onto another app. */
export function agentPillPlacement(
  tip: { x: number; y: number },
  size: { w: number; h: number },
  bounds: { x: number; y: number; w: number; h: number },
  scale = 1,
): { x: number; y: number; flipX: boolean; flipY: boolean } {
  const dx = AGENT_PILL_OFFSET.x * scale;
  const dy = AGENT_PILL_OFFSET.y * scale;
  const margin = AGENT_PILL_FLIP_MARGIN * scale;
  const inset = AGENT_PILL_CLAMP_INSET * scale;
  const maxX = bounds.x + bounds.w;
  const maxY = bounds.y + bounds.h;
  const flipX = tip.x + dx + size.w > maxX - margin;
  const flipY = tip.y + dy + size.h > maxY - margin;
  let x = flipX ? tip.x - dx - size.w : tip.x + dx;
  let y = flipY ? tip.y - dy - size.h : tip.y + dy;
  if (x < bounds.x + inset) x = bounds.x + inset;
  if (x + size.w > maxX - inset) x = maxX - inset - size.w;
  if (y < bounds.y + inset) y = bounds.y + inset;
  if (y + size.h > maxY - inset) y = maxY - inset - size.h;
  return { x, y, flipX, flipY };
}
