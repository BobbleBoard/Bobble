/**
 * THE RELOAD THAT KEEPS YOUR CHAT.
 *
 * the user, on the render-error screen: the two buttons "do not work", he has to
 * press ⌘R, and ⌘R "clears really everything".
 *
 * Both halves of that are one mistake — treating "the view is broken" as "the
 * document is broken". Almost nothing on screen belongs to the document: the
 * conversation lives in the pi child and on disk, the settings, models, session
 * list and canvas tabs are zustand stores at module scope, and a re-mount keeps
 * every one of them. The only thing a render throw actually breaks is the React
 * tree.
 *
 * So this rebuilds THAT and nothing else:
 *
 *   1. snapshot what the view owns and the stores do not — the canvas tab set
 *      (its controller is created per-mount inside ChatApp) and where the thread
 *      was scrolled to;
 *   2. bump a generation counter that keys the root, so React unmounts the whole
 *      tree — error boundary included, which is what clears the crash card — and
 *      mounts a fresh one;
 *   3. put the canvas and the scroll position back.
 *
 * The DOCUMENT reload still exists, because a renderer too far gone to run this
 * has to have a way out: it is ⌘⇧R and the crash card's second button, and it
 * goes through main (`app:reload-window`) because a renderer-initiated
 * navigation is refused by design — see the IPC contract for why that made the
 * buttons inert in the first place.
 */
import { restoreCanvas, snapshotCanvas } from './state/canvas-store';

/** Where the thread was, so a re-mount does not scroll you back to the top. */
const SCROLL_SELECTOR = '[data-testid="chat-scroll"]';

type Listener = (generation: number) => void;

let generation = 0;
const listeners = new Set<Listener>();

/** What the view owns and the stores do not, held across the re-mount. */
let pending: { canvas: ReturnType<typeof snapshotCanvas>; scrollTop: number } | null = null;

/** Subscribe the root to re-mount requests. Returns an unsubscribe. */
export function onSoftReload(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current mount generation — the key the root renders under. */
export function reloadGeneration(): number {
  return generation;
}

/**
 * Re-mount the app, keeping the chat, the canvas tabs and the scroll position.
 *
 * Safe to call from anywhere, including from inside the error boundary's own
 * render output: it only bumps a counter and notifies the root.
 */
export function softReload(): void {
  const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTOR);
  pending = { canvas: snapshotCanvas(), scrollTop: scroller?.scrollTop ?? 0 };
  generation += 1;
  for (const listener of [...listeners]) {
    try {
      listener(generation);
    } catch {
      // One bad listener must not strand the reload half-done.
    }
  }
}

/**
 * Put back what {@link softReload} was holding. Called by the root once the
 * fresh tree has mounted — the canvas controller has registered itself by then,
 * which is why this cannot happen any earlier.
 */
export function completeSoftReload(): void {
  const held = pending;
  pending = null;
  if (held === null) return;
  if (held.canvas !== null) restoreCanvas(held.canvas);
  if (held.scrollTop > 0) {
    /*
     * A frame later, twice: the thread mounts empty and fills from the store on
     * its first effect pass, so the scroller has no height to scroll to yet.
     * Two frames is after that pass has painted.
     */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTOR);
        if (scroller !== null) scroller.scrollTop = held.scrollTop;
      });
    });
  }
}

/**
 * The document reload — everything goes. Routed through main because
 * `window.location.reload()` is a renderer-initiated navigation and main
 * refuses those (main.ts `will-navigate`), which is exactly why the crash
 * card's buttons did nothing.
 *
 * `fresh` reloads the entry point with no query at all: a genuinely fresh
 * window, dev/route params included.
 */
export function hardReload(options: { fresh?: boolean } = {}): void {
  void window.piDesktop.invoke('app:reload-window', { fresh: options.fresh === true }).catch(() => {
    // Main is the only path that works; if it is gone there is nothing left to
    // try, and a thrown promise here would take the crash card down with it.
  });
}
