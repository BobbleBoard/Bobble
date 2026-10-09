/**
 * What could not happen, in words, with the button that fixes it.
 */
import { Button, IconButton, IconClose, IconInfo, IconShield } from '@pi-desktop/ui';
import type { JSX } from 'react';
import type { QuickProblem } from '../../electron/quick/quick-contract';
import { runFix } from './quick-panel';
import { type PanelProblem, problemCopy } from './quick-problem';
import { useQuickStore } from './quick-store';

const PERMISSION_KINDS = new Set(['screen-recording', 'accessibility', 'automation']);

export function QuickProblemCard(): JSX.Element | null {
  const problem = useQuickStore((s) => s.problem);
  const note = useQuickStore((s) => s.note);
  const set = useQuickStore((s) => s.set);
  const shown: PanelProblem | QuickProblem | null = problem ?? note;
  if (shown === null) return null;
  const copy = problemCopy(shown);
  const close = () => set(problem !== null ? { problem: null, retry: null } : { note: null });
  return (
    <section
      className="qp-card"
      role="status"
      aria-live="polite"
      data-testid="quick-problem"
      data-kind={shown.kind}
    >
      <span className="qp-card-icon">
        {PERMISSION_KINDS.has(shown.kind) ? <IconShield size={18} /> : <IconInfo size={18} />}
      </span>
      <div className="qp-card-text">
        <p className="qp-card-title">{copy.title}</p>
        <p className="qp-card-body">{copy.body}</p>
        {copy.fixes.length > 0 ? (
          <div className="qp-card-fixes">
            {copy.fixes.map((fix, i) => (
              <Button
                key={fix.label}
                size="sm"
                variant={i === 0 ? 'accent' : 'secondary'}
                data-testid={`quick-fix-${fix.kind}`}
                onClick={() => void runFix(fix)}
              >
                {fix.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <IconButton aria-label="Dismiss" size="sm" className="qp-card-close" onClick={close}>
        <IconClose size={12} />
      </IconButton>
    </section>
  );
}
