import { Component, type ErrorInfo, type ReactNode } from 'react';

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
          <pre className="pd-crash-detail">{error.message || String(error)}</pre>
          <div className="pd-crash-actions">
            <button
              type="button"
              className="pd-crash-primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            {/* A thread that cannot render is the likeliest cause, and it is
                what survives a reload — so offer the way past it. */}
            <button
              type="button"
              className="pd-crash-secondary"
              onClick={() => {
                window.location.search = '';
              }}
            >
              Reload with a fresh window
            </button>
          </div>
        </div>
      </div>
    );
  }
}
