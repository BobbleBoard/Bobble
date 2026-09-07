/**
 * A task's runs as a ledger: one line per run — when, how long, the first
 * sentence of what it reported — opening to the full report, the files it
 * left behind and the tools it used. The dots join into a timeline so a week
 * of mornings reads as a week.
 *
 * Everything shown is in the TaskRun record. Duration is measured. There is
 * no progress figure for a run in flight because the runner has none.
 */
import { IconFile } from '@pi-desktop/ui';
import { useState } from 'react';
import type { RunArtifact, TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { pdFileUrl } from '../../chat/canvas/file-preview';
import { describeDuration, describeMoment, headline } from './derive';
import { IconAlert, IconCheckCircle, IconTimer } from './icons';
import { OutcomeGlyph, taskActions } from './shared';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactTile({ art }: { art: RunArtifact }) {
  const [broken, setBroken] = useState(false);
  const open = () =>
    void window.piDesktop
      .invoke('canvas:open-external', { url: pdFileUrl(art.path) })
      .catch(() => undefined);
  return (
    <button
      type="button"
      className="sc-artifact"
      onClick={open}
      title={`${art.name} · ${fmtBytes(art.bytes)}`}
      data-testid="sc-artifact"
    >
      <span className="sc-artifact-preview">
        {art.kind === 'image' && !broken ? (
          <img
            src={pdFileUrl(art.path)}
            alt={art.name}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : (
          <IconFile size={18} />
        )}
      </span>
      <span className="sc-artifact-name">{art.name}</span>
    </button>
  );
}

function RunDot({ run }: { run: TaskRun }) {
  const tone = run.status === 'ok' ? 'ok' : run.status === 'error' ? 'error' : 'live';
  return (
    <span className="sc-run-dot" data-tone={tone}>
      {run.status === 'running' ? (
        <OutcomeGlyph run={run} size={14} />
      ) : run.status === 'error' ? (
        <IconAlert size={16} />
      ) : (
        <IconCheckCircle size={16} />
      )}
    </span>
  );
}

export function RunLedger({
  taskId,
  runs,
  now,
  open,
  limit,
}: {
  taskId: string;
  runs: readonly TaskRun[] | undefined;
  now: number;
  /** Which run starts expanded; `first` is the usual answer. */
  open?: 'first' | 'none';
  limit?: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    open === 'none' ? null : (runs?.[0]?.id ?? null),
  );
  if (runs === undefined) return null;
  const shown = limit === undefined ? runs : runs.slice(0, limit);
  if (shown.length === 0) {
    return (
      <div
        className="flex items-center gap-2 py-3 text-footnote text-text-muted"
        data-testid="sc-runs-empty"
      >
        <IconTimer size={14} />
        No runs yet. Results appear here, not in a chat.
      </div>
    );
  }
  return (
    <div data-testid="sc-ledger">
      {shown.map((run) => {
        const isOpen = expanded === run.id;
        const tone = run.status === 'error' ? 'error' : undefined;
        return (
          <div
            key={run.id}
            className="sc-run"
            data-status={run.status}
            data-testid={`sc-run-${run.id}`}
          >
            <RunDot run={run} />
            <div className="min-w-0">
              <button
                type="button"
                className="sc-run-head"
                onClick={() => setExpanded(isOpen ? null : run.id)}
                aria-expanded={isOpen}
              >
                <span className="sc-run-when">{describeMoment(run.startedAt, now)}</span>
                <span className="sc-run-took">
                  {run.status === 'running'
                    ? `${describeDuration(run, now)} so far`
                    : describeDuration(run, now)}
                </span>
                {!isOpen ? (
                  <span className="sc-run-headline" data-tone={tone}>
                    {run.status === 'running' ? 'Working…' : headline(run)}
                  </span>
                ) : null}
              </button>
              {isOpen ? <RunBody taskId={taskId} run={run} /> : null}
            </div>
          </div>
        );
      })}
      {limit !== undefined && runs.length > limit ? (
        <p className="pt-1 pl-7 text-caption text-text-muted">
          {runs.length - limit} older {runs.length - limit === 1 ? 'run' : 'runs'} kept
        </p>
      ) : null}
    </div>
  );
}

function RunBody({ taskId, run }: { taskId: string; run: TaskRun }) {
  const trail = [...new Set(run.toolCalls)].slice(0, 12);
  return (
    <div data-testid="sc-run-body">
      {run.error !== undefined ? (
        <p className="sc-run-body" data-tone="error">
          {run.error}
        </p>
      ) : null}
      {run.summary !== '' ? (
        <p className="sc-run-body">{run.summary}</p>
      ) : run.status === 'running' ? (
        <p className="sc-run-body" style={{ color: 'var(--pd-text-muted)' }}>
          Working — the report lands here when it finishes.
        </p>
      ) : null}
      {run.artifacts.length > 0 ? (
        <div className="sc-artifacts" data-testid="sc-run-artifacts">
          {run.artifacts.map((a) => (
            <ArtifactTile key={a.path} art={a} />
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-3">
        {trail.length > 0 ? <p className="sc-run-trail">used {trail.join(' · ')}</p> : null}
        {run.status !== 'running' ? (
          <button
            type="button"
            className="ml-auto text-caption text-text-muted hover:text-status-danger-fg pd-focusable"
            onClick={() => void taskActions().deleteRun(taskId, run.id)}
            data-testid="sc-run-delete"
          >
            Delete run
          </button>
        ) : null}
      </div>
    </div>
  );
}
