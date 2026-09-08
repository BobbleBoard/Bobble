/**
 * A task's runs as a ledger: one line per run — when, how long, what ran it,
 * the first sentence of what it reported — opening to the full report, the
 * files it left behind and what it used. The dots join into a timeline so a
 * week of mornings reads as a week.
 *
 * Everything shown is in the TaskRun record. Duration is measured. "by hand"
 * is `trigger: 'manual'`; "1h 42m late" is a scheduled run that started well
 * after its slot (derive.ts lateBy) — a run from before `trigger` existed says
 * neither, because we cannot know. The model is the one the record carries.
 * A stopped run is a stopped run: a quiet square, not a red mark. There is no
 * progress figure for a run in flight because the runner has none. An image
 * the run made is on the row.
 */
import { IconFile } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import type { ScheduledTask } from '../../electron/scheduled/schedule-logic';
import type { RunArtifact, TaskRun } from '../../electron/scheduled/scheduled-contract';
import { pdFileUrl } from '../chat/canvas/file-preview';
import {
  describeDuration,
  describeMoment,
  describeSpan,
  describeTrail,
  firstImage,
  headline,
  lateBy,
} from './derive';
import { IconAlert, IconCheckCircle, IconStopCircle, IconTimer } from './icons';
import { OutcomeGlyph, taskActions } from './shared';

/** How many runs the pane shows before it asks; the rest are one click away. */
const SHOWN_AT_FIRST = 8;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function openArtifact(art: RunArtifact) {
  void window.piDesktop
    .invoke('canvas:open-external', { url: pdFileUrl(art.path) })
    .catch(() => undefined);
}

function ArtifactTile({ art }: { art: RunArtifact }) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      className="sd-artifact pd-focusable"
      onClick={() => openArtifact(art)}
      title={`${art.name} · ${fmtBytes(art.bytes)}`}
      data-testid="sd-artifact"
    >
      <span className="sd-artifact-preview">
        {art.kind === 'image' && !broken ? (
          <img
            src={pdFileUrl(art.path)}
            alt={art.name}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : art.kind === 'video' ? (
          // muted, so a wall of past runs is quiet until you play one.
          <video src={pdFileUrl(art.path)} muted controls />
        ) : art.kind === 'audio' ? (
          // biome-ignore lint/a11y/useMediaCaption: user-generated run output
          <audio src={pdFileUrl(art.path)} controls />
        ) : (
          <IconFile size={18} />
        )}
      </span>
      <span className="sd-artifact-name">{art.name}</span>
    </button>
  );
}

/** The picture on the row, for an image-producing run; nothing if it will not load. */
function RowThumb({ art }: { art: RunArtifact }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <img
      className="sd-run-thumb"
      src={pdFileUrl(art.path)}
      alt={art.name}
      loading="lazy"
      onError={() => setBroken(true)}
      data-testid="sd-run-thumb"
    />
  );
}

function RunDot({ run }: { run: TaskRun }) {
  const tone =
    run.status === 'ok'
      ? 'ok'
      : run.status === 'error'
        ? 'error'
        : run.status === 'stopped'
          ? 'stopped'
          : 'live';
  return (
    <span className="sd-run-dot" data-tone={tone}>
      {run.status === 'running' ? (
        <OutcomeGlyph run={run} size={14} />
      ) : run.status === 'error' ? (
        <IconAlert size={16} />
      ) : run.status === 'stopped' ? (
        <IconStopCircle size={16} />
      ) : (
        <IconCheckCircle size={16} />
      )}
    </span>
  );
}

function RunTag({ task, run }: { task: ScheduledTask; run: TaskRun }) {
  if (run.trigger === 'manual')
    return (
      <span className="sd-run-tag" data-testid="sd-run-tag">
        by hand
      </span>
    );
  const late = lateBy(task, run);
  if (late === undefined) return null;
  return (
    <span
      className="sd-run-tag"
      data-tone="warn"
      title="Started this long after its slot — caught up when the Mac woke or Bobble reopened"
      data-testid="sd-run-tag"
    >
      {describeSpan(late)} late
    </span>
  );
}

export function RunLedger({
  task,
  runs,
  now,
  open,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  now: number;
  /** Which run starts expanded; `first` is the usual answer. */
  open?: 'first' | 'none';
}) {
  const [expanded, setExpanded] = useState<string | null>(
    open === 'none' ? null : (runs?.[0]?.id ?? null),
  );
  const [showAll, setShowAll] = useState(false);
  // The newest run stays the open one as new runs arrive — a run that starts
  // while you are looking opens itself, unless you had opened an older one.
  const newest = runs?.[0]?.id ?? null;
  const lastNewest = useRef(newest);
  useEffect(() => {
    if (newest === lastNewest.current) return;
    const previous = lastNewest.current;
    lastNewest.current = newest;
    if (open !== 'none' && (expanded === null || expanded === previous)) setExpanded(newest);
  }, [newest, expanded, open]);
  if (runs === undefined) return null;
  const shown = showAll ? runs : runs.slice(0, SHOWN_AT_FIRST);
  const older = runs.length - shown.length;
  if (shown.length === 0) {
    return (
      <div
        className="flex items-start gap-2 py-3 text-footnote text-text-muted"
        data-testid="sd-runs-empty"
      >
        <IconTimer size={14} style={{ marginTop: 2, flex: 'none' }} />
        <span>No runs yet — the report lands here.</span>
      </div>
    );
  }
  return (
    <div data-testid="sd-ledger">
      {shown.map((run) => {
        const isOpen = expanded === run.id;
        const tone = run.status === 'error' ? 'error' : undefined;
        const image = firstImage(run);
        return (
          <div
            key={run.id}
            className="sd-run"
            data-status={run.status}
            data-testid={`sd-run-${run.id}`}
          >
            <RunDot run={run} />
            <div className="min-w-0">
              <button
                type="button"
                className="sd-run-head pd-focusable"
                onClick={() => setExpanded(isOpen ? null : run.id)}
                aria-expanded={isOpen}
                data-testid={`sd-run-head-${run.id}`}
              >
                <span className="sd-run-when">{describeMoment(run.startedAt, now)}</span>
                <span className="sd-run-took">
                  {run.status === 'running'
                    ? `${describeDuration(run, now)} so far`
                    : describeDuration(run, now)}
                  {run.model !== undefined ? ` · ${run.model.displayName}` : ''}
                </span>
                <RunTag task={task} run={run} />
                {!isOpen ? (
                  <span className="sd-run-headline" data-tone={tone}>
                    {run.status === 'running' ? 'Working…' : headline(run)}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                {!isOpen && image !== undefined ? <RowThumb art={image} /> : null}
              </button>
              {isOpen ? <RunBody task={task} run={run} /> : null}
            </div>
          </div>
        );
      })}
      {older > 0 ? (
        <button
          type="button"
          className="sd-ledger-more pd-focusable"
          onClick={() => setShowAll(true)}
          data-testid="sd-ledger-more"
        >
          Show {older} older {older === 1 ? 'run' : 'runs'}
        </button>
      ) : null}
    </div>
  );
}

function RunBody({ task, run }: { task: ScheduledTask; run: TaskRun }) {
  const trail = [...new Set(run.toolCalls)];
  return (
    <div data-testid="sd-run-body">
      {run.error !== undefined ? (
        <p className="sd-run-body" data-tone="error">
          {run.error}
        </p>
      ) : null}
      {run.status === 'stopped' ? (
        <p className="sd-run-body" style={{ color: 'var(--pd-text-muted)' }}>
          Stopped by hand{run.summary !== '' ? ' — what it had said so far:' : '.'}
        </p>
      ) : null}
      {run.summary !== '' ? (
        <p className="sd-run-body">{run.summary}</p>
      ) : run.status === 'running' ? (
        <p className="sd-run-body" style={{ color: 'var(--pd-text-muted)' }}>
          Working — the report lands here when it finishes.
        </p>
      ) : null}
      {run.artifacts.length > 0 ? (
        <div className="sd-artifacts" data-testid="sd-run-artifacts">
          {run.artifacts.map((a) => (
            <ArtifactTile key={a.path} art={a} />
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-3">
        {trail.length > 0 ? (
          <p className="sd-run-trail" title={trail.join(', ')}>
            used {describeTrail(trail)}
          </p>
        ) : null}
        {run.status !== 'running' ? (
          // Quiet until the pointer or the keyboard is on the run: the newest
          // run is often the only evidence the task works, and "Delete run"
          // beside it at rest read as an invitation.
          <button
            type="button"
            className="sd-run-delete ml-auto text-caption text-text-muted pd-focusable"
            onClick={() => void taskActions().deleteRun(task.id, run.id)}
            data-testid="sd-run-delete"
          >
            Delete run
          </button>
        ) : null}
      </div>
    </div>
  );
}
