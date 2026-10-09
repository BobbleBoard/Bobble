/**
 * A SMALL DRAWING, DRAWING ITSELF IN — once, when it arrives in the chat.
 *
 * The user (2026-09-25): "ensure those animate/build in real time smoothly apply
 * that to whatever possible generally". A diagram builds while it is typed and
 * a chart grows as its values land; an SVG the model wrote and presented just
 * appeared, whole, in one frame. Now its lines draw themselves along their
 * length (the pen's order: first shape first), its filled shapes and words
 * fade up a beat behind, and the whole thing is done inside ~0.7 s — a
 * flourish on arrival, not a performance. A drawing that already built
 * itself live (the svg tool's, LiveSvgCard) and a card scrolled back to are
 * left alone; reduced motion skips it.
 *
 * `drawInPlan` is the pure part (which shapes draw, which fade, when); the
 * DOM half measures each line and hands the plan to the Web Animations API,
 * whose `fill: 'backwards'` holds a shape at its start until its turn and
 * then leaves the drawing exactly as it was.
 */

/** A shape of the drawing, as the plan needs it. */
export interface ShapeFacts {
  /** Stroked with nothing filled: it can draw along its length. */
  readonly line: boolean;
  /** Its length, for a line (0 when it has none to speak of). */
  readonly length: number;
  /**
   * The paper the drawing is on (a fill over nearly all of it): simply there,
   * so the lines draw onto it — filmed fading in behind lines already drawn
   * on the bare card, it read as the drawing arriving twice.
   */
  readonly backdrop?: boolean;
}

export type DrawStep =
  | {
      readonly kind: 'draw';
      readonly index: number;
      readonly delay: number;
      readonly dur: number;
      readonly length: number;
    }
  | { readonly kind: 'fade'; readonly index: number; readonly delay: number; readonly dur: number };

/** The most shapes animated one by one; past it the drawing fades in whole. */
export const DRAW_IN_MOST = 240;
/** The whole draw-in fits in this, however many shapes. */
export const DRAW_IN_MS = 700;

/**
 * When each shape comes in: lines draw in document order, staggered so the
 * last one finishes by DRAW_IN_MS; fills and words fade a little behind the
 * line drawn nearest before them; a backdrop has no step (it is there from
 * the start). Null: too many shapes to take one by one.
 */
export function drawInPlan(shapes: readonly ShapeFacts[]): DrawStep[] | null {
  const moving = shapes.flatMap((s, index) => (s.backdrop === true ? [] : [{ s, index }]));
  if (moving.length === 0) return [];
  if (moving.length > DRAW_IN_MOST) return null;
  const draw = 420;
  const fade = 260;
  const spread = Math.max(0, DRAW_IN_MS - draw);
  const gap = moving.length > 1 ? Math.min(40, spread / (moving.length - 1)) : 0;
  return moving.map(({ s, index }, order): DrawStep => {
    const delay = Math.round(order * gap);
    if (s.line && s.length > 1) return { kind: 'draw', index, delay, dur: draw, length: s.length };
    return { kind: 'fade', index, delay: Math.min(delay + 120, DRAW_IN_MS - fade), dur: fade };
  });
}

/** A box covering nearly all of the drawing's (both as laid out on screen). */
export function coversDrawing(
  box: { readonly width: number; readonly height: number },
  drawing: { readonly width: number; readonly height: number },
): boolean {
  const area = drawing.width * drawing.height;
  return area > 0 && box.width * box.height >= 0.9 * area;
}

const SHAPES = 'path, line, polyline, polygon, circle, ellipse, rect, text, image, use';

/** Draw `svg` in (the DOM half of drawInPlan). */
export function drawIn(svg: SVGSVGElement): void {
  const els = [...svg.querySelectorAll<SVGGraphicsElement>(SHAPES)].filter(
    (el) => el.closest('defs, marker, clipPath, mask, pattern, symbol') === null,
  );
  const view = svg.getBoundingClientRect();
  const facts = els.map((el): ShapeFacts => {
    const cs = getComputedStyle(el);
    const stroked = cs.stroke !== 'none' && Number.parseFloat(cs.strokeWidth) > 0;
    const filled = cs.fill !== 'none' && cs.fill !== 'transparent' && cs.fillOpacity !== '0';
    if (filled && coversDrawing(el.getBoundingClientRect(), view)) {
      return { line: false, length: 0, backdrop: true };
    }
    const dashed = cs.strokeDasharray !== 'none' && cs.strokeDasharray !== '';
    const line = stroked && !filled && !dashed && el instanceof SVGGeometryElement;
    let length = 0;
    if (line) {
      try {
        length = (el as SVGGeometryElement).getTotalLength();
      } catch {
        length = 0;
      }
    }
    return { line, length };
  });
  const plan = drawInPlan(facts);
  const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  if (plan === null) {
    svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: ease });
    return;
  }
  for (const step of plan) {
    const el = els[step.index];
    if (el === undefined) continue;
    if (step.kind === 'draw') {
      const dash = `${step.length} ${step.length}`;
      el.animate(
        [
          { strokeDasharray: dash, strokeDashoffset: String(step.length) },
          { strokeDasharray: dash, strokeDashoffset: '0' },
        ],
        { duration: step.dur, delay: step.delay, easing: ease, fill: 'backwards' },
      );
    } else {
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: step.dur,
        delay: step.delay,
        easing: 'ease-out',
        fill: 'backwards',
      });
    }
  }
}
