/**
 * PAST RUNS for one scheduled task.
 *
 * A scheduled run leaves no chat behind (it happens in a throwaway session in
 * main), so this drawer IS where you see what it did — the user: "shown somewhere in
 * a view past runs button when the user views specific scheduled tasks." Opened
 * from the task's row, never from the sidebar.
 *
 * Each run shows: when it ran and how long, whether it worked, the final report,
 * a compact trail of the tools it used, and — the point of a task like "make me
 * a news video and a portrait" — the ARTIFACTS it produced, rendered inline.
 */
import { Spinner } from '@pi-desktop/ui';
import { useEffect } from 'react';
import type {
  RunArtifact,
  ScheduledTask,
  TaskRun,
} from '../../electron/scheduled/scheduled-contract';
import { pdFileUrl } from '../chat/canvas/file-preview';
import { cx } from '../onboarding/cx';
import { isRunning, useTasksStore } from './tasks-store';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtDuration(run: TaskRun): string {
  if (run.finishedAt === undefined) return 'running…';
  const s = Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ArtifactTile({ art }: { art: RunArtifact }) {
  const open = () =>
    void window.piDesktop
      .invoke('canvas:open-external', { url: pdFileUrl(art.path) })
      .catch(() => undefined);
  return (
    <button
      type="button"
      data-testid="run-artifact"
      onClick={open}
      title={`${art.name} · ${fmtBytes(art.bytes)}`}
      className="pd-focusable group flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-inset text-left transition-colors hover:border-border-strong"
    >
      {art.kind === 'image' ? (
        <img
          src={pdFileUrl(art.path)}
          alt={art.name}
          className="h-28 w-full object-cover"
          loading="lazy"
        />
      ) : art.kind === 'video' ? (
        // muted preview so a wall of past runs is quiet until you play one.
        <video src={pdFileUrl(art.path)} className="h-28 w-full object-cover" muted controls />
      ) : art.kind === 'audio' ? (
        <div className="flex h-28 w-full items-center px-2">
          {/* biome-ignore lint/a11y/useMediaCaption: user-generated run output */}
          <audio src={pdFileUrl(art.path)} className="w-full" controls />
        </div>
      ) : (
        <div className="flex h-28 w-full items-center justify-center text-caption text-text-muted">
          {art.kind}
        </div>
      )}
      <span className="truncate px-2 py-1 text-caption text-text-secondary">{art.name}</span>
    </button>
  );
}

function RunCard({ taskId, run }: { taskId: string; run: TaskRun }) {
  const deleteRun = useTasksStore((s) => s.deleteRun);
  const dot =
    run.status === 'ok'
      ? 'bg-status-success-fg'
      : run.status === 'error'
        ? 'bg-status-danger-fg'
        : 'bg-status-warning-fg';
  return (
    <div
      className="rounded-xl border border-border-subtle bg-bg-raised p-3.5"
      data-testid={`run-card-${run.id}`}
      data-status={run.status}
    >
      <div className="flex items-center gap-2">
        <span className={cx('h-2 w-2 shrink-0 rounded-full', dot)} />
        <span className="text-footnote text-text-primary">{fmtWhen(run.startedAt)}</span>
        <span className="text-caption text-text-muted">· {fmtDuration(run)}</span>
        {run.status === 'running' ? <Spinner size={12} /> : null}
        <button
          type="button"
          data-testid={`run-delete-${run.id}`}
          onClick={() => void deleteRun(taskId, run.id)}
          className="pd-focusable ml-auto rounded-md px-2 py-0.5 text-caption text-text-muted hover:bg-bg-hover hover:text-status-danger-fg"
        >
          Delete
        </button>
      </div>

      {run.error !== undefined ? (
        <p className="mt-2 text-footnote text-status-danger-fg">{run.error}</p>
      ) : null}

      {run.summary !== '' ? (
        <p className="mt-2 whitespace-pre-wrap text-footnote text-text-secondary">
          {run.summary.length > 600 ? `${run.summary.slice(0, 600)}…` : run.summary}
        </p>
      ) : run.status === 'running' ? (
        <p className="mt-2 text-footnote text-text-muted">Working…</p>
      ) : null}

      {run.artifacts.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="run-artifacts">
          {run.artifacts.map((a) => (
            <ArtifactTile key={a.path} art={a} />
          ))}
        </div>
      ) : null}

      {run.toolCalls.length > 0 ? (
        <p className="mt-2 text-caption text-text-muted">
          {/* A compact "what it did" trail — deduped, capped. */}
          {[...new Set(run.toolCalls)].slice(0, 12).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

export function TaskRuns({ task, onClose }: { task: ScheduledTask; onClose: () => void }) {
  const runs = useTasksStore((s) => s.runs[task.id]);
  const loadRuns = useTasksStore((s) => s.loadRuns);
  const runNow = useTasksStore((s) => s.runNow);

  useEffect(() => {
    void loadRuns(task.id);
  }, [task.id, loadRuns]);

  const busy = isRunning(runs);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="task-runs">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-[var(--pd-bg-backdrop)]"
        onClick={onClose}
      />
      <div className="relative flex h-full w-[min(560px,100%)] flex-col border-l border-border-subtle bg-bg-base">
        <header className="flex items-center gap-2 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title text-text-primary">{task.name}</h2>
            <p className="text-caption text-text-muted">Past runs</p>
          </div>
          <button
            type="button"
            data-testid="task-runs-run"
            disabled={busy}
            onClick={() => void runNow(task.id)}
            className={cx(
              'pd-focusable rounded-lg px-3 py-1.5 text-footnote transition-opacity',
              busy
                ? 'cursor-default bg-bg-active text-text-muted'
                : 'bg-accent-primary text-text-on-accent hover:opacity-90',
            )}
          >
            {busy ? 'Running…' : 'Run now'}
          </button>
          <button
            type="button"
            aria-label="Close"
            data-testid="task-runs-close"
            onClick={onClose}
            className="pd-focusable rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {runs === undefined ? (
            <div className="flex justify-center pt-8 text-accent-primary">
              <Spinner size={18} />
            </div>
          ) : runs.length === 0 ? (
            <p className="pt-6 text-center text-footnote text-text-muted" data-testid="runs-empty">
              No runs yet. Use “Run now” to try it — the result appears here, not in a chat.
            </p>
          ) : (
            runs.map((run) => <RunCard key={run.id} taskId={task.id} run={run} />)
          )}
        </div>
      </div>
    </div>
  );
}
