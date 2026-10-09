/**
 * A TURN THAT DID NOT FINISH, SAID PLAINLY, WITH ITS FIX ON A BUTTON.
 *
 * Takes the place of the red line that used to print an engine error under a
 * reply (the user, 2026-10-08: "red text that's just a real unknown error or
 * something that doesn't have handling attached to it … just can't exist
 * anymore"). What happened and which fix applies come from
 * describeTurnProblem (turn-problem.ts); this draws them and runs the fix:
 *
 *  - Try again: the message sent again (ChatThread's retry, a fork at it).
 *  - Restart the model and try again: the model engine started afresh on the
 *    model it was running, then the message sent again.
 *  - Choose a smaller model / a model that reads more: the composer's model
 *    menu, opened.
 *  - Continue in a new chat: a new chat.
 *
 * The engine's words stay one click away under Details, with Copy, for a bug
 * report — never as the message.
 */
import { Button, CopyButton, IconChevronRight, IconInfo, Spinner } from '@pi-desktop/ui';
import { type JSX, useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { useModelMenuStore } from '../state/model-menu-store';
import { newSession } from '../state/pi-connect';
import { FIX_LABEL, type TurnFix, type TurnProblem } from './turn-problem';

/** Restart the model the engine is running, on the same launch. */
async function restartModel(): Promise<boolean> {
  const { status } = useLlmStore.getState();
  const id = status.model?.id;
  if (id === undefined) return false;
  const launchMode = status.launchMode === 'multimodal' ? 'multimodal' : 'fast-text';
  const res = await activateLocalModel(id, status.model?.quant, launchMode, {
    waitForIdleTurn: true,
  });
  return res.success;
}

export function TurnProblemCard({
  problem,
  onRetry,
}: {
  problem: TurnProblem;
  /** Send the turn's message again. Absent where a turn cannot be resent (a replayed feed). */
  onRetry?: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<TurnFix | null>(null);
  const [failed, setFailed] = useState<TurnFix | null>(null);
  const [open, setOpen] = useState(false);
  const fixes = [problem.fix, ...problem.also].filter(
    (f) => onRetry !== undefined || (f !== 'retry' && f !== 'restart'),
  );

  const run = async (fix: TurnFix): Promise<void> => {
    setFailed(null);
    if (fix === 'retry') {
      onRetry?.();
      return;
    }
    if (fix === 'smaller-model' || fix === 'longer-model') {
      useModelMenuStore.getState().setOpen(true);
      return;
    }
    if (fix === 'new-chat') {
      setBusy(fix);
      await newSession();
      setBusy(null);
      return;
    }
    // restart
    setBusy(fix);
    const ok = await restartModel().catch(() => false);
    setBusy(null);
    if (ok) onRetry?.();
    else setFailed(fix);
  };

  return (
    <div
      className="pd-turn-problem"
      role="status"
      data-testid="turn-problem"
      data-kind={problem.kind}
    >
      <span className="pd-turn-problem-icon" aria-hidden="true">
        <IconInfo size={16} />
      </span>
      <div className="pd-turn-problem-main">
        <p className="pd-turn-problem-title">{problem.title}</p>
        <p className="pd-turn-problem-body">
          {failed === 'restart'
            ? 'The model did not come back. Choosing it again from the model menu starts it.'
            : problem.body}
        </p>
        {fixes.length > 0 ? (
          <div className="pd-turn-problem-actions">
            {fixes.map((f, i) => (
              <Button
                key={f}
                size="sm"
                variant={i === 0 ? 'primary' : 'secondary'}
                disabled={busy !== null}
                data-testid={`turn-fix-${f}`}
                onClick={() => void run(f)}
              >
                {busy === f ? <Spinner size={12} /> : null}
                {busy === f && f === 'restart' ? 'Restarting the model…' : FIX_LABEL[f]}
              </Button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="pd-turn-problem-more pd-focusable"
          aria-expanded={open}
          data-testid="turn-problem-details"
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevronRight size={12} className={open ? 'pd-turn-problem-chev--open' : undefined} />
          Details
        </button>
        {open ? (
          <div className="pd-turn-problem-detail">
            <pre>{problem.detail}</pre>
            <CopyButton value={problem.detail} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
