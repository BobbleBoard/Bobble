/**
 * Pure support logic for the Mac computer-use cursor overlay, extracted from
 * overlay-controller.ts so it unit-tests in plain Node (window-policy.ts
 * precedent): window-bounds diffing for the tracking loop, the delta the
 * phantom rides when the controlled window is dragged, occluder-set change
 * detection for the mask push, the app-scoped visibility rule, and the
 * key-combo → display-label prettifier the status pill shows.
 *
 * All coordinates are global macOS screen POINTS (top-left origin) — the same
 * space AX positions, CGEvent posts and CGWindowList bounds share, and the same
 * space the native overlay panel is addressed in. There is no screen→window
 * mapping left to do: the panel spans the whole desktop and never moves, so a
 * screen point IS the coordinate we send. (The previous overlay was a
 * window-sized BrowserWindow, which is why this file used to carry
 * OVERLAY_BUFFER and a toLocalPoint mapping — both of them workarounds for a
 * canvas that could clip.)
 */

/** A window rect in global screen points. */
export interface OverlayRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Did the tracked window move/resize enough for the overlay to react?
 * (Sub-point AX jitter is ignored so the tracker doesn't thrash the helper.) */
export function rectsDiffer(a: OverlayRect | null, b: OverlayRect | null): boolean {
  if (a === null || b === null) return a !== b;
  return (
    Math.abs(a.x - b.x) >= 1 ||
    Math.abs(a.y - b.y) >= 1 ||
    Math.abs(a.w - b.w) >= 1 ||
    Math.abs(a.h - b.h) >= 1
  );
}

/**
 * How far the phantom cursor must travel to stay glued to the controlled window
 * after it moved from `from` to `to` — its ORIGIN delta, rounded to whole
 * points.
 *
 * The old overlay got this for free: the window moved and dragged its contents
 * with it. A screen-coordinate canvas has to shift the cursor explicitly, and it
 * has to, because the cursor marks a place INSIDE the app (the button it is
 * about to click), not an absolute spot on the desktop. A pure resize from the
 * bottom-right leaves the origin alone and so leaves the cursor alone, which is
 * also right — the content under it did not move.
 */
export function rectDelta(from: OverlayRect, to: OverlayRect): { dx: number; dy: number } {
  return { dx: Math.round(to.x - from.x), dy: Math.round(to.y - from.y) };
}

/** Windows stacked ABOVE the controlled one, in screen points — the rects the
 * native overlay masks out so the phantom never paints over them. */
export type OverlayOccluders = readonly OverlayRect[];

/**
 * Is this occluder set meaningfully different from the last one we pushed?
 *
 * The tracker samples bounds every ~16ms while visible, and the helper answers
 * with the full occluder list each time; re-sending an identical list would put
 * a CoreAnimation mask rebuild on every one of those ticks for nothing. Whole
 * points are the comparison unit — the same sub-point-jitter reasoning as
 * rectsDiffer, and the mask is a screen-space cut-out where a fraction of a
 * point is invisible.
 */
export function occludersDiffer(a: OverlayOccluders | null, b: OverlayOccluders | null): boolean {
  if (a === null || b === null) return a !== b;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) return true;
    if (rectsDiffer(left, right)) return true;
  }
  return false;
}

/** Inputs the overlay-visibility rule reads each tracking tick. */
export interface OverlayVisibilityState {
  /** The controlled app currently owns the user's focus (its window is front). */
  readonly controlledFrontmost: boolean;
  /** The controlled window is present/on-screen (a bounds read succeeded — not
   * minimized, closed, or on another space we can't see). */
  readonly appVisible: boolean;
  /** The model is actively driving the app right now (a tool act in flight or
   * within the recent activity window). */
  readonly driving: boolean;
  /** Z-ORDER TRUTH from the helper (CGWindowList): is the controlled window
   * meaningfully covered by OTHER apps' windows above it? `null`/undefined =
   * unknown (old helper / no windowId) → fall back to the driving/frontmost
   * proxy rule. */
  readonly occluded?: boolean | null;
}

/**
 * Should the phantom cursor overlay be VISIBLE AT ALL?
 *
 * macOS window levels are global bands, not per-app, so a click-through panel
 * can't be truly z-sandwiched between the controlled app and whatever else is
 * on screen. Two things scope it instead, and this is the COARSE one: a
 * whole-overlay show/hide tied to the controlled app, so the phantom never
 * floats over an app the user has turned to on their own. The FINE one is the
 * occluder mask the native panel applies (see occludersDiffer), which stops the
 * cursor painting on individual windows above the app long before their
 * coverage trips the hide threshold.
 *
 *   - The window must exist at all (`appVisible`) — nothing to overlay
 *     otherwise.
 *   - OCCLUSION IS TRUTH when the helper reports it: a controlled window
 *     substantially covered by another app's window must never wear the phantom
 *     (even while the model is driving — the cursor lives ON the app, not on
 *     whatever the user dragged over it), and a CLEAR window keeps its cursor
 *     even when the model is idle and the app is backgrounded.
 *   - Occlusion unknown (old helper): fall back to the proxy rule — show
 *     while DRIVING or while the controlled app is FRONTMOST, tuck away
 *     otherwise.
 */
export function overlayShouldShow(s: OverlayVisibilityState): boolean {
  if (!s.appVisible) return false;
  if (s.occluded === true) return false;
  if (s.occluded === false) return true;
  return s.driving || s.controlledFrontmost;
}

const MODIFIER_GLYPHS: Record<string, string> = {
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  super: '⌘',
  win: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  opt: '⌥',
  ctrl: '⌃',
  control: '⌃',
  fn: 'fn',
  function: 'fn',
};

const KEY_LABELS: Record<string, string> = {
  return: '↩',
  enter: '↩',
  tab: '⇥',
  space: 'Space',
  escape: 'Esc',
  esc: 'Esc',
  delete: '⌫',
  backspace: '⌫',
  forwarddelete: '⌦',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

/** Render "cmd+shift+s" as the label macOS users read: "⌘⇧S". Unknown tokens
 * pass through capitalized, so the pill never shows an empty label. */
export function comboLabel(combo: string): string {
  const parts = combo
    .split(/[+-]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '');
  if (parts.length === 0) return combo;
  let mods = '';
  let key = '';
  for (const part of parts) {
    const glyph = MODIFIER_GLYPHS[part];
    if (glyph !== undefined) {
      mods += glyph;
      continue;
    }
    key = KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : capitalize(part));
  }
  return `${mods}${key}` === '' ? combo : `${mods}${key}`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The states the status bubble can be in — the exact set overlay.html's STATUS
 * map handles, plus `idle` for "no bubble is showing".
 */
export type MacCursorState =
  | 'idle'
  | 'opening'
  | 'thinking'
  | 'clicking'
  | 'typing'
  | 'pressing'
  | 'scrolling'
  | 'reading';

/** What the bubble reads: a label, an optional monospace detail, and whether
 * the animated dots are running. */
export interface BubbleContent {
  label: string;
  /** The `<em>` tail (the typed preview) — '' when the state has none. */
  detail: string;
  dots: boolean;
}

/**
 * The SAME words overlay.html paints, computed here so the canvas monitor tab
 * and the on-screen overlay can never disagree about what Pi is doing.
 *
 * overlay.html is a static file with no build step, so it cannot import this;
 * what it CAN do is stay a one-to-one mirror of these seven cases, which is
 * cheap to check and is what this test-covered function pins down. `text` is
 * the already-prepared payload the controller pushes — a {@link typingPreview}
 * for typing, a {@link comboLabel} for a key press, an app name for opening.
 */
export function bubbleContent(state: MacCursorState, text = ''): BubbleContent {
  switch (state) {
    case 'opening':
      return { label: text === '' ? 'Opening' : text, detail: '', dots: true };
    case 'thinking':
      return { label: 'Thinking', detail: '', dots: true };
    case 'clicking':
      return { label: 'Clicking', detail: '', dots: false };
    case 'typing':
      return { label: 'Typing', detail: text, dots: true };
    case 'pressing':
      return { label: `Pressing ${text}`.trimEnd(), detail: '', dots: false };
    case 'scrolling':
      return { label: 'Scrolling', detail: '', dots: true };
    case 'reading':
      return { label: 'Reading the screen', detail: '', dots: true };
    default:
      return { label: '', detail: '', dots: false };
  }
}

/**
 * EVERYTHING THE PHANTOM IS DOING, IN ONE PLACE.
 *
 * The computer-use canvas tab draws the same cursor and the same bubble over a
 * live picture of the controlled window, and the two must never disagree — a
 * monitor showing the cursor somewhere the real overlay is not is worse than no
 * monitor. So the overlay controller, which already owns all of this to drive
 * overlay.html, publishes it; monitor.ts reads it rather than deriving a second
 * copy from the same tool events.
 *
 * `cursor` is in GLOBAL SCREEN POINTS (the space `rect` is in), not the
 * overlay's padded-window local space — the canvas maps it with the same pure
 * helpers, and a local coordinate would be meaningless there.
 */
export interface MacOverlayState {
  /** An app is under computer-use control (the overlay is targeted). */
  engaged: boolean;
  pid: number | null;
  /** The controlled window's frame in global screen points. */
  rect: OverlayRect | null;
  /** Phantom cursor position in GLOBAL screen points (null before placement). */
  cursor: { x: number; y: number } | null;
  cursorState: MacCursorState;
  /** The payload for the state: typed preview, key combo, app name — ''. */
  statusText: string;
  /** Is the bubble showing at all (it fades after BUBBLE_IDLE_MS of silence)? */
  bubbleVisible: boolean;
  /** What the visibility rule decided, before the background-mode gate. */
  wantsVisible: boolean;
}

/** Truncate the live-typing preview so the bubble stays a bubble. */
/** Truncate the live-typing preview so the pill stays a pill. */
export function typingPreview(text: string, max = 44): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
