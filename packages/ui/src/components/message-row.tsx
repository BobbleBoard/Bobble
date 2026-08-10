import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export type ThreadProps = HTMLAttributes<HTMLDivElement>;

/** Thread column — max-width --pd-thread-width (claude 840 / codex 736). */
export const Thread = forwardRef<HTMLDivElement, ThreadProps>(function Thread(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-thread', className)} {...rest} />;
});

export interface MessageRowProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * `briefing` is a message an AGENT was given — the manager's contract to an
   * engineer, the CEO's vision to the manager.
   *
   * It is a user-shaped bubble because that is what it IS from the receiving
   * agent's point of view: the thing it was asked to do. But it is LEFT aligned
   * with a blue border rather than right aligned, so a transcript never implies
   * the user typed it. the user: "the manager/CEO provided messages need to be shown as
   * if they are a user message, however their message bubble should be left
   * aligned instead of right aligned and should have a blue tint/border."
   *
   * Without it a subagent's view opened mid-thought — "right now it just starts
   * working without us being able to scroll up and see 'what hapened'".
   */
  kind: 'user' | 'assistant' | 'briefing';
  /** Hover-revealed action cluster (copy/edit/retry — codex extras, adopted
   * unconditionally per spec-message-row ADAPTATION). */
  actions?: ReactNode;
}

/**
 * Message row — spec-message-row.md. User bubble is a pure token swap
 * (--pd-user-bubble-*, --pd-radius-bubble); codex right-alignment is the
 * bubbleAlign flavor flag in CSS. Assistant voice rides the response tokens
 * (claude serif 16/1.5 with dark wght-360 drop; codex sans 14/22).
 */
export const MessageRow = forwardRef<HTMLDivElement, MessageRowProps>(function MessageRow(
  { kind, actions, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'pd-msg',
        kind === 'user'
          ? 'pd-msg--user'
          : kind === 'briefing'
            ? 'pd-msg--briefing'
            : 'pd-msg--assistant',
        className,
      )}
      {...rest}
    >
      {kind === 'user' || kind === 'briefing' ? (
        <div className={clsx('pd-msg-bubble', kind === 'briefing' && 'pd-msg-bubble--briefing')}>
          {children}
        </div>
      ) : (
        children
      )}
      {actions !== undefined ? <div className="pd-msg-actions">{actions}</div> : null}
    </div>
  );
});
