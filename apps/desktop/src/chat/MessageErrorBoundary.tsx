/**
 * ONE REPLY MAY FAIL TO DRAW; THE THREAD MAY NOT.
 *
 * The companion of canvas/CanvasErrorBoundary. A reply is one message group —
 * markdown, an activity chain, inline media — and a render error inside it used
 * to reach the app-level boundary and take the window with it. Here it takes
 * one row: the group is replaced by a short line saying so, with the raw text
 * available, and every other message stays exactly where it was.
 *
 * The error and its FULL component stack are logged, the same as the canvas
 * boundary, because the crash this was built after has not yet been caught
 * with a usable stack.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class MessageErrorBoundary extends Component<
  { children: ReactNode; fallbackText?: string },
  State
> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Bobble message error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="pd-message-crash" data-testid="message-crash">
        <span className="text-footnote text-text-muted">
          This reply couldn't be drawn ({error.message.slice(0, 120)}).
        </span>
        {this.props.fallbackText !== undefined && this.props.fallbackText !== '' ? (
          <pre className="whitespace-pre-wrap pt-1 text-code text-text-secondary">
            {this.props.fallbackText.slice(0, 4000)}
          </pre>
        ) : null}
      </div>
    );
  }
}
