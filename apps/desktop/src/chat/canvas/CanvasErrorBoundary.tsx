/**
 * THE CANVAS MAY FAIL; THE WINDOW MAY NOT.
 *
 * the user, on the renderer crash in the canvas assessment: "that cannot happen".
 * Twice, mid-turn, a React update loop (error #185) inside the canvas took the
 * whole window to the app-level boundary — chat, composer, sidebar, all gone
 * behind "Bobble hit a rendering error", while the model was still working and
 * the user's chat was fine on disk.
 *
 * The loop's trigger is not yet pinned (it did not reproduce under a controller
 * burst, a store burst, compaction, or three more model runs), and the app
 * cannot wait on that. This boundary sits around the canvas rail only, so a
 * failure there stays there:
 *
 *   1. it is logged with the FULL component stack, which is the evidence the
 *      hunt needs — the app-level boundary logs it too, but by then the tree
 *      that failed is the whole app;
 *   2. the canvas is reset and remounted ONCE, automatically — the tab that
 *      looped is dropped, the rail comes back empty, the chat never noticed;
 *   3. if it fails again straight after, it stays down behind a small card with
 *      a Reset button rather than looping the reset itself.
 *
 * The chat and composer are never inside this boundary.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { resetCanvasForNewSession, useCanvasStore } from '../../state/canvas-store';

/** A second failure inside this window after an automatic reset stays down. */
const AUTO_RESET_WINDOW_MS = 10_000;

interface State {
  error: Error | null;
  /** Remount key: bumping it throws the failed subtree away. */
  generation: number;
  lastResetAt: number;
}

export class CanvasErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, generation: 0, lastResetAt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The whole stack, unsliced — a minified frame with a sourcemap beside it is
    // enough to name the component; a truncated one is not (SEEN: 300 chars).
    console.error('Bobble canvas error', error, info.componentStack);
    const now = Date.now();
    if (now - this.state.lastResetAt > AUTO_RESET_WINDOW_MS) {
      // First failure in a while: drop the canvas state and come back empty.
      this.reset(now);
    }
  }

  private reset(at: number = Date.now()): void {
    try {
      resetCanvasForNewSession();
    } catch {
      // The store is what failed; the remount below still happens.
    }
    this.setState((s) => ({ error: null, generation: s.generation + 1, lastResetAt: at }));
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      // The card stands where the rail stood, at the rail's own width: the
      // panel that failed owned that width, and without it the card would size
      // itself to its longest line and squash the chat beside it (SEEN).
      const width = useCanvasStore.getState().sideWidth;
      return (
        <aside
          className="pd-canvas-rail relative flex h-full shrink-0 flex-col overflow-hidden bg-bg-raised"
          data-open="true"
          style={{ width }}
          data-testid="canvas-tabs-panel"
        >
          <div className="pd-canvas-crash" data-testid="canvas-crash">
            <p className="pd-canvas-crash-copy">
              The canvas hit an error twice in a row, so it is closed for now. Your chat is
              unaffected.
            </p>
            <pre className="pd-canvas-crash-detail">{this.state.error.message}</pre>
            <button
              type="button"
              className="pd-btn-ghost pd-focusable"
              data-testid="canvas-crash-reset"
              onClick={() => this.reset()}
            >
              Reset canvas
            </button>
          </div>
        </aside>
      );
    }
    // A fresh key after a reset: the failed subtree is unmounted, not retried.
    return (
      <div key={this.state.generation} className="contents">
        {this.props.children}
      </div>
    );
  }
}
