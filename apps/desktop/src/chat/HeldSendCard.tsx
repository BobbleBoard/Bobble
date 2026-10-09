/**
 * A MESSAGE WAITING FOR ITS MODEL — under the bubble, why, and the way on.
 *
 * The send held the message because the chat model did not start
 * (held-send-store.ts). This says why in plain words (launch-problem.ts) and
 * carries the fix: Try again starts the model and sends the message; Choose
 * another model opens the composer's model menu; Open Models goes where a
 * model is downloaded. When a model comes up some other way — picked from the
 * menu, finished loading — the message goes by itself.
 */
import { Button, CopyButton, IconChevronRight, IconInfo, Spinner } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
import { navigate } from '../state/app-nav-store';
import { useHeldSendStore } from '../state/held-send-store';
import { useLlmStore } from '../state/llm-store';
import { useModelMenuStore } from '../state/model-menu-store';
import { retryHeldSend } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { describeLaunchProblem, LAUNCH_FIX_LABEL, type LaunchFix } from './launch-problem';

export function HeldSendCard(): JSX.Element | null {
  const held = useHeldSendStore((s) => s.held);
  const sessionFile = usePiStore((s) => s.session?.sessionFile ?? null);
  const echoShown = usePiStore((s) =>
    held === null ? false : s.messages.some((m) => m.id === held.echoId),
  );
  const ready = useLlmStore(
    (s) => s.status.phase === 'ready' && s.status.serverRunning && s.status.model?.id != null,
  );
  const [open, setOpen] = useState(false);
  const mine = held !== null && held.sessionFile === sessionFile && echoShown;

  // A model came up another way (picked from the menu, a load that finished):
  // the message goes by itself.
  useEffect(() => {
    if (mine && ready && held !== null && !held.retrying) void retryHeldSend();
  }, [mine, ready, held]);

  if (!mine || held === null) return null;
  const p = describeLaunchProblem(held.problem);
  const run = (fix: LaunchFix): void => {
    if (fix === 'retry') void retryHeldSend();
    else if (fix === 'other-model') useModelMenuStore.getState().setOpen(true);
    else navigate({ kind: 'view', view: 'models' });
  };
  return (
    <div
      className="pd-turn-problem"
      role="status"
      data-testid="held-send"
      data-kind={held.problem.kind}
    >
      <span className="pd-turn-problem-icon" aria-hidden="true">
        <IconInfo size={16} />
      </span>
      <div className="pd-turn-problem-main">
        <p className="pd-turn-problem-title">{held.retrying ? 'Starting the model…' : p.title}</p>
        <p className="pd-turn-problem-body">
          {held.retrying ? 'Your message sends as soon as it is ready.' : p.body}
        </p>
        <div className="pd-turn-problem-actions">
          {[p.fix, ...p.also].map((f, i) => (
            <Button
              key={f}
              size="sm"
              variant={i === 0 ? 'primary' : 'secondary'}
              disabled={held.retrying}
              data-testid={`held-fix-${f}`}
              onClick={() => run(f)}
            >
              {held.retrying && f === 'retry' ? <Spinner size={12} /> : null}
              {LAUNCH_FIX_LABEL[f]}
            </Button>
          ))}
        </div>
        {p.detail !== '' ? (
          <>
            <button
              type="button"
              className="pd-turn-problem-more pd-focusable"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <IconChevronRight
                size={12}
                className={open ? 'pd-turn-problem-chev--open' : undefined}
              />
              Details
            </button>
            {open ? (
              <div className="pd-turn-problem-detail">
                <pre>{p.detail}</pre>
                <CopyButton value={p.detail} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
