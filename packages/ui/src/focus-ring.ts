/**
 * WHEN A FOCUS RING SHOULD BE ON SCREEN.
 *
 * `:focus-visible` is the right primitive and it is broader than what anyone
 * means by "the user is navigating with the keyboard". Two of its spec-correct
 * matches are exactly what the user kept reporting as a bug — a blue box around
 * controls he had only clicked:
 *
 *   1. ESCAPE closing a menu. Radix hands focus back to the trigger, Escape was
 *      a keypress, so the ring lights up and stays there. Dismissing something
 *      is not navigating to it.
 *   2. WINDOW REFOCUS. Chromium restores focus AND its focus-visible state, so
 *      clicking away to another app and back lights up the last thing touched.
 *      His words: "if I click to something else, and then come back to clicking
 *      an element, that's when the box appears."
 *
 * So the modality is tracked here instead of inferred, and `--pd-focus-ring`
 * (base.css) collapses to transparent while it is off. Deliberately small:
 *
 * - Only NAVIGATION keys turn it on. Typing a letter into a field is not
 *   navigation, and neither is Escape — treating every keydown as intent is how
 *   a mouse user ends up ringed for pressing Escape.
 * - Any pointer press turns it off, before focus moves, so the ring never
 *   flashes on the way down.
 * - Window blur/focus deliberately change NOTHING. A keyboard user who alt-tabs
 *   away comes back to their ring; a mouse user comes back to no ring. Both are
 *   right, and both fall out of simply not touching the mode.
 *
 * Text inputs are not gated by this at all (they draw their own focus
 * treatment): a clicked field with no sign that it is focused is a worse bug
 * than the one this fixes.
 */

/** Keys that MOVE focus, as opposed to typing into or dismissing something. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
]);

export const FOCUS_RING_ATTR = 'data-focus-ring';

/** True when this key is the user saying "I am moving around with the keyboard". */
export function isNavigationKey(key: string): boolean {
  return NAVIGATION_KEYS.has(key);
}

/**
 * The mode a given event should leave the app in, or null to leave it alone.
 * Pure, so the rule is testable without a DOM.
 */
export function nextFocusRingMode(event: {
  readonly type: string;
  readonly key?: string;
}): 'on' | 'off' | null {
  if (event.type === 'keydown') {
    return event.key !== undefined && isNavigationKey(event.key) ? 'on' : null;
  }
  if (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'touchstart') {
    return 'off';
  }
  return null;
}

/**
 * Start tracking. Idempotent, and returns a teardown for tests.
 *
 * Listens in the CAPTURE phase so the mode is already correct by the time focus
 * moves and the ring would paint — doing it on the way up means one frame of
 * ring on every click.
 */
export function installFocusRingTracking(doc: Document = document): () => void {
  const root = doc.documentElement;
  if (root.getAttribute(FOCUS_RING_ATTR) === null) root.setAttribute(FOCUS_RING_ATTR, 'off');

  const onEvent = (e: Event): void => {
    const next = nextFocusRingMode({
      type: e.type,
      ...(e instanceof KeyboardEvent ? { key: e.key } : {}),
    });
    if (next !== null) root.setAttribute(FOCUS_RING_ATTR, next);
  };

  const types = ['keydown', 'pointerdown', 'mousedown', 'touchstart'] as const;
  for (const t of types) doc.addEventListener(t, onEvent, { capture: true, passive: true });
  return () => {
    for (const t of types) doc.removeEventListener(t, onEvent, { capture: true });
  };
}
