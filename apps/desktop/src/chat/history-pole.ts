/**
 * THE HISTORY POLE — a line down the right edge of a long conversation, with a
 * few marked places on it you can jump to.
 *
 * the user: "when hovering on the right side of the chat area, not the canvas, I
 * want a long pole to appear … has circles on it, when the circles are hovered
 * they show a quick preview … these dots are (max 4), don't show a dot for every
 * message, only for sessions at least 5 screen heights of scroll … these circles
 * should be just like holes on the line of a graph looking … clicking takes them
 * there … but ensure it just appears on hover on that area (smoothly) and only
 * when useful."
 *
 * This file is the "only when useful" and "which four" half, kept pure so both
 * decisions are stated once and can be argued with in a test rather than in a
 * screenshot.
 *
 * WHY FOUR DOTS AND NOT FORTY. A jump bar is not an index; it is a way of
 * dividing something too long to hold in your head into pieces you can aim at.
 * Past about four targets you are reading a list, which is what the conversation
 * already is. So the dots are not "every message" and not "the last four" —
 * they are the user turns nearest the quarter-points of the scroll, which means
 * they always cut the conversation into roughly equal visual thirds/quarters no
 * matter how uneven the turns are.
 */

/** A user turn as the pole sees it: where it is, and what it said. */
export interface PoleTurn {
  readonly id: string;
  /** Pixels from the top of the scrolled content. */
  readonly offsetTop: number;
  /** The message text, for the hover preview. */
  readonly text: string;
}

export interface PoleGeometry {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface PoleDot {
  readonly id: string;
  /** 0–1 down the pole. */
  readonly fraction: number;
  readonly offsetTop: number;
  /** Short preview text. */
  readonly label: string;
  /** 1-based position among ALL user turns, for "message 7 of 22". */
  readonly ordinal: number;
  readonly total: number;
}

/**
 * How many screens of scroll before the pole earns its place.
 *
 * the user guessed "at least 5 screen heights … or that's just a random thing I
 * threw out because I don't have a sense for pixels, you do, use your sense,
 * have an objective measure."
 *
 * The objective measure is what the ordinary scrollbar stops being able to do.
 * A scrollbar thumb is proportional: at 2 screens it is half the track and drags
 * precisely; at 4 it is a quarter and a one-pixel slip moves you a whole screen;
 * past that it is a nub. Four is where aiming with it starts failing, and it is
 * also the point where you can no longer have seen a quarter of the thread — so
 * that is the threshold, one screen earlier than his guess and for a reason
 * rather than a feel.
 */
export const POLE_MIN_SCREENS = 4;

/** Fewer turns than dots and the pole is decoration — the thread IS the index. */
export const POLE_MIN_TURNS = 4;

/** The most dots the pole will ever carry. */
export const POLE_MAX_DOTS = 4;

/** First words of a message, for the hover preview. */
export function poleLabel(text: string, maxChars = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  // Cut at a word so the preview never ends mid-token.
  const cut = flat.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxChars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Whether a conversation is long enough to be worth a pole.
 *
 * Both conditions, deliberately: a short thread of enormous messages scrolls a
 * long way but has nowhere to jump TO, and forty one-line turns that fit on two
 * screens do not need jumping at all.
 */
export function poleIsUseful(geometry: PoleGeometry, turnCount: number): boolean {
  const { scrollHeight, clientHeight } = geometry;
  if (clientHeight <= 0) return false;
  return scrollHeight >= clientHeight * POLE_MIN_SCREENS && turnCount >= POLE_MIN_TURNS;
}

/**
 * Pick the dots: the user turns nearest the evenly spaced interior points of the
 * scroll, at most {@link POLE_MAX_DOTS} of them, in order and never repeated.
 *
 * The ends are left alone on purpose — the top and bottom of the pole already go
 * to the top and bottom of the thread, and a dot sitting on the end of a line
 * reads as a cap rather than a target.
 */
export function poleDots(geometry: PoleGeometry, turns: readonly PoleTurn[]): PoleDot[] {
  if (!poleIsUseful(geometry, turns.length)) return [];
  const span = Math.max(1, geometry.scrollHeight - geometry.clientHeight);
  const wanted = Math.min(POLE_MAX_DOTS, turns.length);
  const chosen = new Map<string, PoleTurn>();
  for (let i = 1; i <= wanted; i++) {
    const target = (span * i) / (wanted + 1);
    let best = turns[0] as PoleTurn;
    for (const t of turns) {
      if (Math.abs(t.offsetTop - target) < Math.abs(best.offsetTop - target)) best = t;
    }
    // A turn already taken by a nearer quarter-point is not taken again; the
    // pole shows three dots rather than two stacked on one another.
    if (!chosen.has(best.id)) chosen.set(best.id, best);
  }
  const ordinalOf = new Map(turns.map((t, i) => [t.id, i + 1]));
  return [...chosen.values()]
    .sort((a, b) => a.offsetTop - b.offsetTop)
    .map((t) => ({
      id: t.id,
      offsetTop: t.offsetTop,
      fraction: Math.min(1, Math.max(0, t.offsetTop / span)),
      label: poleLabel(t.text),
      ordinal: ordinalOf.get(t.id) ?? 0,
      total: turns.length,
    }));
}

/** Ease-in-out cubic — slow at both ends, quick through the middle. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Where a click at `fraction` down the pole should leave `scrollTop`. */
export function scrollTargetFor(geometry: PoleGeometry, fraction: number): number {
  const span = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  return Math.round(span * Math.min(1, Math.max(0, fraction)));
}
