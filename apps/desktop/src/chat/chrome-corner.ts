/**
 * Publish the top-left corner cluster's real right edge as `--pd-chrome-corner`.
 *
 * The corner beside the traffic lights holds the sidebar toggle and Chat|Work.
 * It is absolutely positioned (it has to be — with the sidebar open it sits over
 * the sidebar, not in the top bar's flow), so nothing in the top bar knows how
 * wide it is. The collapsed top bar used to state that width by hand as `124px`,
 * which was correct for exactly as long as the corner held one button: when
 * Chat|Work moved in beside it, the chat title was laid out straight through the
 * toggle. the user: "the title overlaps with this chat/work buttons."
 *
 * Measuring it removes the number from the argument. Whatever ends up in that
 * corner, the title starts after it.
 */

/** The value CSS falls back to before the first measurement lands. */
export const CHROME_CORNER_FALLBACK = 175;

/**
 * Watch `zone` and keep `--pd-chrome-corner` equal to its right edge in window
 * coordinates. Returns the unsubscribe. Written against the structural bits of
 * the DOM it needs so it unit-tests without a browser.
 */
export function trackChromeCorner(
  zone: { getBoundingClientRect(): { right: number } },
  set: (px: number) => void,
  observe?: (cb: () => void) => () => void,
): () => void {
  const publish = () => set(Math.round(zone.getBoundingClientRect().right));
  publish();
  return observe?.(publish) ?? (() => undefined);
}
