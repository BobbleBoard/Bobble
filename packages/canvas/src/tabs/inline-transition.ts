/**
 * The shared name that lets a card in the chat and its tab in the canvas be
 * ONE element to the View Transitions API.
 *
 * the user: "a quick button in the canvas and on the inline items to with a
 * smooth animation have an inline thing either resize and move over smoothly
 * leaving the inline chat to become the canvas … or a tab in the canvas
 * dropping out and becoming an inline card". `document.startViewTransition`
 * does exactly that when the element before the change and the element after
 * it carry the same `view-transition-name`: the browser snapshots both and
 * animates position and size between them. The inline card sets the name on
 * itself; the canvas sets it on its tab panel while the active tab is one that
 * was lifted from a card (`tab.inline`). The two are never in the document at
 * once — the card collapses to a stub while its tab is open — which is what
 * the API requires of a name.
 *
 * A name must be a CSS identifier; a tab key is a path. Hashed, not escaped.
 */
export function inlineTransitionName(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return `pd-inline-${(h >>> 0).toString(16)}`;
}

/**
 * The class every inline ⇄ canvas pair shares, so one stylesheet rule can
 * shape the morph (`::view-transition-group(.pd-inline)`) without knowing the
 * per-element name.
 */
export const INLINE_TRANSITION_CLASS = 'pd-inline';

/** The style that names an element for the inline ⇄ canvas transition. */
export function inlineTransitionStyle(key: string): {
  viewTransitionName: string;
  viewTransitionClass: string;
} {
  return {
    viewTransitionName: inlineTransitionName(key),
    viewTransitionClass: INLINE_TRANSITION_CLASS,
  };
}
