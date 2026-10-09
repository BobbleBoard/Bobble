import { Component, type ErrorInfo, type ReactNode } from 'react';
import { hardReload, softReload } from './app-reload';

/**
 * THE LAST THING BETWEEN A RENDER THROW AND A BLANK WINDOW.
 *
 * the user, top of his chat list: "total blank screen."
 *
 * There are two ways to get one, and only one of them was handled. When the
 * renderer PROCESS dies, main reloads the window (electron/renderer-recovery.ts).
 * When a React render THROWS, the process is perfectly alive — React unmounts
 * the entire tree by design and leaves an empty <div id="root">. Nothing in the
 * app caught that, so a single bad render in any component anywhere emptied the
 * window, and the only clue was in a devtools console nobody had open.
 *
 * So: catch it, say what happened, and offer the two things that actually
 * recover — reload the window, or start a new chat (a thread that cannot render
 * is the likeliest culprit, and it is the one piece of state a reload keeps).
 * The error text is shown rather than hidden: this is a local app, the user is
 * the developer's only reporter, and "something went wrong" wastes the report.
 */
interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only — main has no channel for renderer exceptions, and the point
    // here is that the window is no longer blank, not that we ship a report.
    console.error('Bobble render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="pd-crash" data-testid="app-crash">
        <div className="pd-crash-card">
          <h1 className="pd-crash-title">Bobble hit a rendering error</h1>
          <p className="pd-crash-copy">
            The window stopped drawing. Your chats are on disk and were not affected.
          </p>
          <details className="pd-crash-more">
            <summary>Details</summary>
            <pre className="pd-crash-detail">{error.message || String(error)}</pre>
          </details>
          <div className="pd-crash-actions">
            {/*
              BOTH OF THESE USED TO DO NOTHING.

              They were `window.location.reload()` and `window.location.search =
              ''` — a renderer-initiated navigation and, when the search was
              already empty, not even that. main refuses renderer navigations by
              design (`will-navigate` → preventDefault), so the one screen whose
              whole job is escape had two dead buttons and the user was left pressing
              ⌘R. See app-reload.ts.
            */}
            <button
              type="button"
              className="pd-crash-primary"
              data-testid="app-crash-reload"
              onClick={softReload}
            >
              Reload
            </button>
            {/* The document reload, for a tree that breaks again on re-mount:
                a fresh window, no query, nothing carried over. The chats are on
                disk and come back with it. */}
            <button
              type="button"
              className="pd-crash-secondary"
              data-testid="app-crash-fresh"
              onClick={() => hardReload({ fresh: true })}
            >
              Reload with a fresh window
            </button>
          </div>
        </div>
      </div>
    );
  }
}
