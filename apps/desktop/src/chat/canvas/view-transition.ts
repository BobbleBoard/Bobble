/**
 * Run a DOM update inside a View Transition, so an element that exists before
 * and after it under the same `view-transition-name` MOVES rather than pops.
 *
 * The user: "with a smooth animation have an inline thing either resize and move
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
  /*
   * THE LAYOUT IS FINAL WHEN IT IS CAPTURED. The user (2026-10-08): "the animation
   * seems smooth mostly but theres some jitteriness both ways". MEASURED
   * (inline-move-film.mjs): the canvas rail animates its own width, so the
   * "after" snapshot caught it mid-way — into the canvas the morph aimed at the
   * panel's spot with the rail still 0 wide (x 1440) and the panel then slid to
   * x 1000; back into the chat it aimed at the card beside the open canvas
   * (x 301) and the card then slid to x 521 as the rail closed. While a
   * transition runs, `data-vt` switches those layout transitions off
   * (global.css), so the update lands in its final shape and the morph — the
   * rail is a named element too — carries all of the movement.
   */
  const root = document.documentElement;
  root.dataset.vt = '1';
  const clear = () => {
    delete root.dataset.vt;
  };
  try {
    const t = doc.startViewTransition(() => {
      flushSync(update);
    });
    t.finished.then(clear, clear);
  } catch {
    clear();
    update();
  }
}
