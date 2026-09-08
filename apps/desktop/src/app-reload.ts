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
import type { CanvasState } from '@pi-desktop/canvas';
import { lastKnownCanvas, restoreCanvasWhenReady } from './state/canvas-store';

/** Where the thread was, so a re-mount does not scroll you back to the top. */
const SCROLL_SELECTOR = '[data-testid="chat-scroll"]';

/**
 * The thread's scroll position, remembered as it changes.
 *
 * Reading it at reload time only works when the thread is still on screen —
 * and after a render throw it is not: the crash card has replaced it, and the
 * position is already gone. So it is recorded passively instead, in the capture
 * phase because `scroll` does not bubble.
 */
let lastScrollTop = 0;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'scroll',
    (event) => {
      const el = event.target as HTMLElement | null;
      if (el?.matches?.(SCROLL_SELECTOR) === true) lastScrollTop = el.scrollTop;
    },
    { capture: true, passive: true },
  );
}

type Listener = (generation: number) => void;

let generation = 0;
const listeners = new Set<Listener>();

/** What the view owns and the stores do not, held across the re-mount. */
let pending: { canvas: CanvasState | null; scrollTop: number } | null = null;

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

/* E2E hook, on the same `?piE2E=1` opt-in as the store accessors: a probe has to
 * be able to tell a re-mount from an accelerator that never arrived. */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __pi_reload_gen: () => number }).__pi_reload_gen = reloadGeneration;
}

/**
 * Re-mount the app, keeping the chat, the canvas tabs and the scroll position.
 *
 * Safe to call from anywhere, including from inside the error boundary's own
 * render output: it only bumps a counter and notifies the root.
 */
export function softReload(): void {
  const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTOR);
  /*
   * `lastKnownCanvas` / `lastScrollTop` rather than a live read: a render throw
   * has already unmounted the thread and unregistered the canvas controller by
   * the time the crash card's button is pressed, so the live read is empty
   * exactly when the recovery needs it most.
   */
  pending = { canvas: lastKnownCanvas(), scrollTop: scroller?.scrollTop ?? lastScrollTop };
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
  if (held.canvas !== null) restoreCanvasWhenReady(held.canvas);
  if (held.scrollTop > 0) restoreScroll(held.scrollTop);
}

/** Frames to keep re-applying the scroll position for — see {@link restoreScroll}. */
const SCROLL_RESTORE_FRAMES = 24;
/** Frames it has to hold before we let go. */
const SCROLL_SETTLED_FRAMES = 3;

/**
 * Put the thread back where it was, and KEEP putting it back until it stays.
 *
 * A single assignment is not enough and the reason is a race the thread wins
 * about half the time: `ChatThread` mounts with its stick-to-bottom pin ARMED
 * (a fresh mount has no scroll history), and re-pins to the newest line on
 * every render until a scroll event tells it otherwise. Scroll events are
 * asynchronous, so a render landing between our assignment and that event
 * yanks the reader to the bottom — MEASURED as `3832 → 6964` on one run of
 * crash-recovery-probe and correct on the next.
 *
 * So it re-applies each frame until the value holds for a few frames running,
 * which is precisely "the thread has stopped fighting me", and gives up after a
 * short window either way.
 */
function restoreScroll(target: number): void {
  let frames = 0;
  let held = 0;
  const step = (): void => {
    const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTOR);
    if (scroller !== null) {
      if (Math.abs(scroller.scrollTop - target) < 2) held += 1;
      else {
        held = 0;
        scroller.scrollTop = target;
      }
    }
    frames += 1;
    if (held < SCROLL_SETTLED_FRAMES && frames < SCROLL_RESTORE_FRAMES) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
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
