/**
 * Pieces the Scheduled screen shares: the store hook, the clock, the status
 * glyph, the facts under a prompt, template icons, the section label and the
 * two-step delete.
 *
 * Presentational rules: tokens only, the app's own icon recipe, the sibling
 * screens' conventions, and nothing that could be read as progress unless it
 * is measured.
 */
import {
  IconCheck,
  IconClock,
  IconCode,
  IconFolder,
  IconGlobe,
  IconPencil,
  Spinner,
  Switch,
} from '@pi-desktop/ui';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import {
  describeSchedule,
  normalizeTask,
  type ScheduledTask,
} from '../../electron/scheduled/schedule-logic';
import type { TaskRun } from '../../electron/scheduled/scheduled-contract';
import { useLlmStore } from '../state/llm-store';
import { folderName, lastRunModel, reachFromRuns, type TaskState } from './derive';
import {
  IconAlert,
  IconCalendar,
  IconCheckCircle,
  IconDownload,
  IconHand,
  IconMoon,
  IconPause,
  IconStopCircle,
  IconSun,
} from './icons';
import { useTasksStore } from './tasks-store';
import { TASK_TEMPLATES, type TaskTemplate } from './templates';

/* ---- data ---------------------------------------------------------------- */

export function useSchedule() {
  const enabled = useTasksStore((s) => s.enabled);
  const tasks = useTasksStore((s) => s.tasks);
  const runs = useTasksStore((s) => s.runs);
  const loaded = useTasksStore((s) => s.loaded);
  const load = useTasksStore((s) => s.load);
  const loadRuns = useTasksStore((s) => s.loadRuns);
  useEffect(() => {
    void load();
  }, [load]);
  // Each task's history once, so a row can say how its last run went and the
  // page opens with the ledger already there. Live changes arrive by event.
  useEffect(() => {
    for (const t of tasks) if (runs[t.id] === undefined) void loadRuns(t.id);
  }, [tasks, runs, loadRuns]);
  return { enabled, tasks, runs, loaded };
}

export const taskActions = () => {
  const s = useTasksStore.getState();
  return {
    create: s.create,
    update: s.update,
    remove: s.remove,
    runNow: s.runNow,
    stop: s.stop,
    setEnabled: s.setEnabled,
    deleteRun: s.deleteRun,
  };
};

/** Re-render on a clock, so "in 4h" and "24s" stay true without per-row timers. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Width of a container, for layouts that change columns below a threshold. */
export function useContainerWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The one machine fact that changes what happens next: a run cannot start
 * until a model is loaded, and loading one is the slow part of a first run.
 * Null when there is nothing to say — the common case.
 */
export function useModelNote(): string | null {
  const status = useLlmStore((s) => s.status);
  if (status.phase === 'ready') return null;
  if (status.phase === 'starting') return 'the model is still loading';
  if (status.phase === 'downloading') return 'a model is still downloading';
  return 'no model is loaded yet — the first run loads one';
}

/** The loaded model's name, or null. */
export function useLoadedModel(): string | null {
  return useLlmStore((s) =>
    s.status.phase === 'ready' ? (s.status.model?.displayName ?? null) : null,
  );
}

/* ---- status --------------------------------------------------------------- */

/**
 * The glyph in a task's tile: what is happening to it, at a glance. Derived
 * from the newest run and the task's real state, so a green tick means the
 * last run worked and a red mark means it did not — never "not paused".
 */
export function StatusGlyph({
  state,
  runs,
  size = 16,
  muted = false,
}: {
  state: TaskState;
  runs: readonly TaskRun[] | undefined;
  size?: number;
  /**
   * Scheduling is off: the row keeps its own glyph (so the list is not nine
   * pause marks) but loses its colour — a green tick beside a trailing "off"
   * was the row saying "fine" and "off" at once. The amber "!" of a missed
   * slot and the red "!" of a failed run stay: those are facts about the past,
   * and off does not change them.
   */
  muted?: boolean;
}) {
  const last = runs?.[0];
  const style = (color: string) => ({ color, display: 'inline-flex' as const });
  const quiet = 'var(--pd-text-muted)';
  if (state.kind === 'off')
    return <StatusGlyph state={state.inner} runs={runs} size={size} muted />;
  if (state.kind === 'running') return <Spinner size={size - 2} />;
  if (state.kind === 'due')
    return <IconClock size={size} style={style(muted ? quiet : 'var(--pd-accent-primary)')} />;
  if (state.kind === 'missed')
    return <IconAlert size={size} style={style('var(--pd-status-warning-fg)')} />;
  if (state.kind === 'paused') return <IconPause size={size} style={style(quiet)} />;
  if (last?.status === 'error')
    return <IconAlert size={size} style={style('var(--pd-status-danger-fg)')} />;
  if (last?.status === 'stopped') return <IconStopCircle size={size} style={style(quiet)} />;
  if (state.kind === 'manual') return <IconHand size={size} style={style(quiet)} />;
  if (last?.status === 'ok')
    return (
      <IconCheckCircle size={size} style={style(muted ? quiet : 'var(--pd-status-success-fg)')} />
    );
  return <IconClock size={size} style={style(quiet)} />;
}

export function OutcomeGlyph({ run, size = 14 }: { run: TaskRun; size?: number }) {
  if (run.status === 'running') return <Spinner size={size - 2} />;
  if (run.status === 'error')
    return <IconAlert size={size} style={{ color: 'var(--pd-status-danger-fg)' }} />;
  if (run.status === 'stopped')
    return <IconStopCircle size={size} style={{ color: 'var(--pd-text-muted)' }} />;
  return <IconCheck size={size} style={{ color: 'var(--pd-status-success-fg)' }} />;
}

/* ---- the facts under a prompt --------------------------------------------- */

/**
 * What a task has reached, where it runs, and what runs it — three quiet
 * label/value rows. Facts want values: "None loaded yet" is the value, and
 * the sentence about the first run loading one is the tooltip, not the row.
 */
export function ReachBlock({
  task,
  runs,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
}) {
  const folder = folderName(task.cwd);
  const reach = reachFromRuns(runs);
  const ran = (runs?.length ?? 0) > 0;
  const status = useLlmStore((s) => s.status);
  const loaded = status.phase === 'ready' ? (status.model?.displayName ?? null) : null;
  const last = lastRunModel(runs);
  const runsOn =
    loaded !== null
      ? { value: loaded, title: 'The model loaded now; the next run uses it.' }
      : status.phase === 'starting'
        ? { value: 'The model that is loading now', title: undefined }
        : status.phase === 'downloading'
          ? { value: 'The model that is downloading now', title: undefined }
          : last !== undefined
            ? {
                value: `${last} last time · none loaded now`,
                title: 'Nothing is loaded; the next run loads a model first.',
              }
            : {
                value: 'None loaded yet',
                title: 'The first run loads a model — that is the slow part of a first run.',
              };
  return (
    <dl className="sd-facts" data-testid="sd-reach-block">
      <dt>Reaches</dt>
      <dd>
        {reach.length > 0
          ? reach.map((r) => r.label).join(' · ')
          : ran
            ? 'Nothing outside its folder so far'
            : 'Nothing yet — it has not run'}
      </dd>
      <dt>Runs in</dt>
      <dd title={task.cwd}>
        {folder === undefined ? 'Its own folder (a new one per run)' : `${folder} — ${task.cwd}`}
      </dd>
      <dt>Runs on</dt>
      <dd title={runsOn.title} data-testid="sd-runs-on">
        {runsOn.value}
      </dd>
    </dl>
  );
}

/* ---- templates ------------------------------------------------------------ */

export function TemplateIcon({ id, size = 16 }: { id: string; size?: number }) {
  switch (id) {
    case 'morning-brief':
      return <IconSun size={size} />;
    case 'what-did-i-miss':
      return <IconMoon size={size} />;
    case 'draft-replies':
      return <IconPencil size={size} />;
    case 'repo-digest':
      return <IconCode size={size} />;
    case 'test-run':
      return <IconCheckCircle size={size} />;
    case 'deps':
      return <IconDownload size={size} />;
    case 'inbox-folder':
      return <IconFolder size={size} />;
    case 'watch-topic':
      return <IconGlobe size={size} />;
    case 'weekly-review':
      return <IconCalendar size={size} />;
    default:
      return <IconClock size={size} />;
  }
}

export function templateDraft(t: TaskTemplate): Partial<ScheduledTask> {
  return {
    name: t.name,
    prompt: t.prompt,
    frequency: t.frequency,
    hour: t.hour,
    minute: t.minute,
    weekday: t.weekday,
    enabled: true,
  };
}

/** "Weekdays at 7:30 AM" for a template, through the same words a task gets. */
export function describeTemplateSchedule(t: TaskTemplate): string {
  return describeSchedule(normalizeTask({ id: t.id, ...templateDraft(t) }));
}

export { TASK_TEMPLATES };

/* ---- layout bits ----------------------------------------------------------- */

/**
 * A section heading: body size, medium — one step above the 13px medium run
 * dates inside it, so the heading is heavier than its contents. Room for a
 * fact on the right.
 */
export function SectionTitle({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className === undefined ? 'sd-section' : `sd-section ${className}`}>
      <h3 className="sd-section-title">{children}</h3>
      {aside !== undefined ? <span className="sd-section-aside">{aside}</span> : null}
    </div>
  );
}

/* ---- controls ------------------------------------------------------------- */

/** The feature switch, labelled where there is room for the label. */
export function SchedulingSwitch({ enabled, showLabel }: { enabled: boolean; showLabel: boolean }) {
  return (
    <span className="flex items-center gap-2 text-footnote text-text-secondary">
      {showLabel ? <span>{enabled ? 'Scheduling on' : 'Scheduling off'}</span> : null}
      <Switch
        checked={enabled}
        onCheckedChange={(v) => void taskActions().setEnabled(v)}
        aria-label={enabled ? 'Scheduling on' : 'Scheduling off'}
        data-testid="sd-scheduling-switch"
      />
    </span>
  );
}

/**
 * Delete that asks once, in place. The button becomes the question — "Delete
 * for good?" with Delete and Keep — and disarms itself after four seconds.
 * The danger colour appears only on the armed Delete: a red word on a calm
 * page is the loudest thing on it, and this is the least wanted action.
 */
export function TwoStepDelete({
  onConfirm,
  label = 'Delete',
}: {
  onConfirm: () => void;
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!armed) {
    return (
      <button
        type="button"
        className="pd-btn pd-btn--ghost-muted pd-btn--sm pd-focusable"
        onClick={() => setArmed(true)}
        data-testid="sd-delete"
      >
        {label}
      </button>
    );
  }
  return (
    <span className="sd-delete-armed" data-testid="sd-delete-armed">
      <span className="text-footnote text-text-secondary">Delete for good?</span>
      <button
        type="button"
        className="pd-btn pd-btn--danger pd-btn--sm pd-focusable"
        onClick={onConfirm}
        data-testid="sd-delete-confirm"
      >
        Delete
      </button>
      <button
        type="button"
        className="pd-btn pd-btn--ghost pd-btn--sm pd-focusable"
        onClick={() => setArmed(false)}
        data-testid="sd-delete-keep"
      >
        Keep
      </button>
    </span>
  );
}

/**
 * The end of a task's page: a hairline, one sentence on what deleting takes
 * with it, and the control.
 */
export function DeleteFooter({ runCount, onConfirm }: { runCount: number; onConfirm: () => void }) {
  const what =
    runCount === 0
      ? 'Deleting removes the task. It has no runs to lose.'
      : `Deleting removes the task and its ${runCount === 1 ? 'one run' : `${runCount} runs`}.`;
  return (
    <div className="sd-footer" data-testid="sd-delete-footer">
      <span className="text-footnote text-text-muted">{what}</span>
      <TwoStepDelete onConfirm={onConfirm} />
    </div>
  );
}
