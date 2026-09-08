/**
 * Canvas rail width (drag-resize) state — the only chat-owned canvas UI state
 * left after the tabbed rework (THEME 1): open/collapse/fullscreen/active-tab
 * now live in the shared `CanvasController` (@pi-desktop/canvas), and inline-vs-
 * canvas routing is derived per-artifact via `shouldGoToCanvas`. Width is kept
 * here so the rail persists a user's drag independent of the tab set.
 */
import type { CanvasController, CanvasState } from '@pi-desktop/canvas';
import { useCallback, useSyncExternalStore } from 'react';
import { create } from 'zustand';

export const CANVAS_MIN_WIDTH = 320;
export const CANVAS_MAX_WIDTH = 760;
const CANVAS_DEFAULT_WIDTH = 440;

interface CanvasUiState {
  sideWidth: number;
  setSideWidth: (width: number) => void;
  /**
   * App-owned desired open/closed state of the canvas rail. The persistent
   * top-right toggle (round-7) drives this so the canvas can be opened/closed
   * even when no artifact is showing; the panel-toggle inside the rail and a new
   * routed-in artifact drive it too. Starts closed (no rail until there's
   * something to show, or the user opens it).
   */
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;
  toggleCanvasOpen: () => void;
}

const clampWidth = (w: number): number => Math.max(CANVAS_MIN_WIDTH, Math.min(CANVAS_MAX_WIDTH, w));

export const useCanvasStore = create<CanvasUiState>((set) => ({
  sideWidth: CANVAS_DEFAULT_WIDTH,
  setSideWidth: (width) => set({ sideWidth: clampWidth(width) }),
  canvasOpen: false,
  setCanvasOpen: (open) => set({ canvasOpen: open }),
  toggleCanvasOpen: () => set((s) => ({ canvasOpen: !s.canvasOpen })),
}));

// ── Canvas controller bridge (per-session isolation) ───────────────────────
// The canvas TAB set lives in the React-owned CanvasController (@pi-desktop/
// canvas), which the non-React session lifecycle (pi-connect's newSession /
// switchSession) can't reach directly. The app shell registers the live
// controller here on mount, so the session lifecycle can reset / SNAPSHOT /
// RESTORE the canvas — each chat keeps its OWN canvas (its tabs are saved on
// switch-away and restored on switch-back) instead of leaking across chats.

let controller: CanvasController | null = null;
/**
 * The tab set as it was when the last controller went away.
 *
 * A render throw unmounts the whole tree, which unregisters the controller —
 * so by the time anything asks "what was open?", the answer is gone. That is
 * exactly when the question matters: the crash card's Reload puts the canvas
 * back, and without this it came back empty (MEASURED by
 * tests/e2e/crash-recovery-probe.mjs). Kept here rather than in app-reload
 * because here is the only place that sees the controller leave.
 */
let lastKnown: CanvasState | null = null;

/**
 * A canvas waiting for a controller to put it back into.
 *
 * The app re-mounts from the ROOT on a safe reload, and `ChatApp` — which owns
 * the controller — is behind the first-run gate, an async IPC round trip. So the
 * restore is asked for before there is anywhere to restore INTO, and a plain
 * `controller?.restore()` silently did nothing (MEASURED: the canvas came back
 * empty from the crash card's Reload). Held here until the controller arrives.
 */
let pendingRestore: CanvasState | null = null;

/** App shell → register (or, with `null`, unregister) the live CanvasController.
 * Idempotent; the latest registration wins. */
export function registerCanvasController(c: CanvasController | null): void {
  if (c === null && controller !== null) lastKnown = controller.getState();
  controller = c;
  if (c !== null && pendingRestore !== null) {
    const state = pendingRestore;
    pendingRestore = null;
    restoreCanvas(state);
  }
}

/** The live canvas state, or the last one there was — see {@link lastKnown}. */
export function lastKnownCanvas(): CanvasState | null {
  return controller?.getState() ?? lastKnown;
}

/** The app's canvas controller, for code that runs outside React (event wiring). */
export function getCanvasController(): CanvasController | null {
  return controller;
}

/**
 * Subscribe a component to the REGISTERED controller, without needing to be
 * inside `<CanvasProvider>`.
 *
 * `useCanvasTabs` throws when there is no provider above it, which makes it the
 * wrong tool for a component that must also render in a unit test or before the
 * shell mounts. This returns an empty tab list in those cases instead — the
 * caller is asking "is the panel busy?", and "there is no panel" is a perfectly
 * good answer to that.
 */
export function useCanvasTabsSafe(): CanvasState['tabs'] {
  const subscribe = useCallback((listener: () => void) => {
    // The controller can be registered AFTER this subscribes (shell mount
    // order), so re-check on every store change as well as on its own updates.
    const off = controller?.subscribe(listener);
    return () => off?.();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => controller?.getState().tabs ?? EMPTY_TABS,
    () => EMPTY_TABS,
  );
}

/** One frozen array so the no-controller snapshot is referentially stable —
 * a fresh `[]` each call makes useSyncExternalStore loop forever. */
const EMPTY_TABS: CanvasState['tabs'] = [];

/**
 * Reset the canvas for a conversation with no saved state: drop every tab and
 * slide the rail closed so it starts empty. Safe before the shell mounts (no-op).
 */
export function resetCanvasForNewSession(): void {
  controller?.reset();
  useCanvasStore.getState().setCanvasOpen(false);
}

/** Snapshot the live canvas state (tabs/active/collapsed/fullscreen) so the
 * current chat's canvas can be restored on return. Null before the shell mounts. */
export function snapshotCanvas(): CanvasState | null {
  return controller?.getState() ?? null;
}

/** Restore a previously-snapshotted canvas for a returned-to chat, opening the
 * rail only when the snapshot actually had tabs (else it stays closed). */
export function restoreCanvas(state: CanvasState): void {
  controller?.restore(state);
  useCanvasStore.getState().setCanvasOpen(state.tabs.length > 0);
}

/**
 * Restore a canvas as soon as there is one to restore into.
 *
 * The same as {@link restoreCanvas} when the shell is up; when it is not — the
 * frames after a safe reload, before `ChatApp` clears the first-run gate — the
 * state is held and applied by the next {@link registerCanvasController}.
 */
export function restoreCanvasWhenReady(state: CanvasState): void {
  if (controller !== null) {
    restoreCanvas(state);
    return;
  }
  pendingRestore = state;
}
