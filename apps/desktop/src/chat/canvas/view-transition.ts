/**
 * Run a DOM update inside a View Transition, so an element that exists before
 * and after it under the same `view-transition-name` MOVES rather than pops.
 *
 * the user: "with a smooth animation have an inline thing either resize and move
 * over smoothly leaving the inline chat to become the canvas … or a tab in
 * the canvas dropping out and becoming an inline card." Chromium's
 * `document.startViewTransition` is that animation: it snapshots the page,
 * runs the update, snapshots again, and tweens every named element between
 * its two boxes. The update has to land in ONE synchronous commit — React's
 * batching would otherwise leave the "after" snapshot identical to the
 * "before" — hence `flushSync`.
 *
 * Without the API (a test DOM) or with reduced motion on, the update simply
 * runs; the card and the tab still swap, only instantly.
 */
import { flushSync } from 'react-dom';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

export function withViewTransition(update: () => void): void {
  const doc = document as ViewTransitionDocument;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof doc.startViewTransition !== 'function' || reduced) {
    update();
    return;
  }
  doc.startViewTransition(() => {
    flushSync(update);
  });
}
