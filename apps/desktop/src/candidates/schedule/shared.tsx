/**
 * Pieces every candidate shares: the store hook (with the seed guard), the
 * once-a-minute clock, the honesty strip, status glyphs and pills, reach chips,
 * the week strip, template icons and the two-step delete.
 *
 * Presentational rules: tokens only, the app's own icon recipe, and nothing
 * that could be read as progress unless it is measured.
 */
import {
  IconCheck,
  IconClock,
  IconCode,
  IconFilm,
  IconFolder,
  IconGlobe,
  IconImage,
  IconPencil,
  IconTerminal,
  IconWaveform,
  Spinner,
  Switch,
} from '@pi-desktop/ui';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import type { ScheduledTask } from '../../../electron/scheduled/schedule-logic';
import type { TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { useTasksStore } from '../../scheduled/tasks-store';
import { TASK_TEMPLATES, type TaskTemplate } from '../../scheduled/templates';
import { useLlmStore } from '../../state/llm-store';
import {
  describeDelta,
  describeDuration,
  describeMoment,
  folderName,
  type Reach,
  reachFromRuns,
  type TaskState,
  weekLabels,
  weekPattern,
} from './derive';
import { runsWereSeeded } from './hook';
import {
  IconAlert,
  IconArrowRight,
  IconBell,
  IconCalendar,
  IconCheckCircle,
  IconChip,
  IconDownload,
  IconHand,
  IconMail,
  IconMoon,
  IconPause,
  IconSun,
  IconTimer,
} from './icons';

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
  useEffect(() => {
    if (runsWereSeeded()) return;
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
    setEnabled: s.setEnabled,
    deleteRun: s.deleteRun,
  };
};

/** Re-render once a minute, so "in 4h" stays true without per-row timers. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Width of a container, for layouts that stack below a threshold. */
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

/* ---- the honesty strip --------------------------------------------------- */

/**
 * What this Mac can promise right now. Every item is a fact the app already
 * holds: the model phase and name from the llm store, the run in flight from
 * the run records, and the two rules of a local scheduler.
 */
export function MachineStrip({
  tasks,
  runs,
  now,
  enabled,
  compact = false,
}: {
  tasks: readonly ScheduledTask[];
  runs: Readonly<Record<string, readonly TaskRun[]>>;
  now: number;
  enabled: boolean;
  compact?: boolean;
}) {
  const status = useLlmStore((s) => s.status);
  const live = tasks.find((t) => runs[t.id]?.[0]?.status === 'running');
  const liveRun = live === undefined ? undefined : runs[live.id]?.[0];
  const modelName = status.model?.displayName ?? null;
  const modelLine =
    status.phase === 'ready' && modelName !== null
      ? `${modelName} loaded`
      : status.phase === 'starting'
        ? 'Loading the model…'
        : status.phase === 'downloading'
          ? 'Downloading a model…'
          : 'No model loaded — the first run loads it';
  return (
    <div className="sc-machine" data-testid="sc-machine">
      {!enabled ? (
        <span className="sc-machine-item" data-tone="warn">
          <IconPause size={14} /> Scheduling is off — nothing fires until you turn it back on
        </span>
      ) : live !== undefined && liveRun !== undefined ? (
        <span className="sc-machine-item" data-tone="live">
          <Spinner size={13} /> Running {live.name} · {describeDuration(liveRun, now)}
        </span>
      ) : (
        <span className="sc-machine-item">
          <IconTimer size={14} /> Runs one task at a time, only while Bobble is open
        </span>
      )}
      <span className="sc-machine-item" data-tone={status.phase === 'ready' ? undefined : 'warn'}>
        <IconChip size={14} /> {modelLine}
      </span>
      {!compact ? (
        <span className="sc-machine-item">
          <IconBell size={14} /> Can read your Mac; cannot send anything
        </span>
      ) : null}
    </div>
  );
}

/* ---- status --------------------------------------------------------------- */

export type Tone = 'ok' | 'error' | 'warn' | 'live' | 'muted';

export function toneOf(state: TaskState, runs: readonly TaskRun[] | undefined): Tone {
  switch (state.kind) {
    case 'running':
      return 'live';
    case 'due':
      return 'live';
    case 'missed':
      return 'warn';
    case 'paused':
    case 'off':
    case 'manual':
      return runs?.[0]?.status === 'error' ? 'error' : 'muted';
    case 'scheduled':
      return runs?.[0]?.status === 'error' ? 'error' : 'ok';
  }
}

/** A 16px glyph for a row: what is happening to this task, at a glance. */
export function StatusGlyph({
  state,
  runs,
  size = 16,
}: {
  state: TaskState;
  runs: readonly TaskRun[] | undefined;
  size?: number;
}) {
  const last = runs?.[0];
  if (state.kind === 'running') return <Spinner size={size - 2} />;
  const style = (color: string) => ({ color, display: 'inline-flex' as const });
  if (state.kind === 'due')
    return <IconTimer size={size} style={style('var(--pd-accent-primary)')} />;
  if (state.kind === 'missed')
    return <IconAlert size={size} style={style('var(--pd-status-warning-fg)')} />;
  if (state.kind === 'paused' || state.kind === 'off')
    return <IconPause size={size} style={style('var(--pd-text-muted)')} />;
  if (last?.status === 'error')
    return <IconAlert size={size} style={style('var(--pd-status-danger-fg)')} />;
  if (state.kind === 'manual')
    return <IconHand size={size} style={style('var(--pd-text-muted)')} />;
  if (last?.status === 'ok')
    return <IconCheckCircle size={size} style={style('var(--pd-status-success-fg)')} />;
  return <IconClock size={size} style={style('var(--pd-text-muted)')} />;
}

/** The state as a word, plus the one fact that matters for it. */
export function stateLine(state: TaskState, now: number): { word: string; detail: string } {
  switch (state.kind) {
    case 'running':
      return { word: 'Running', detail: `running · ${describeDuration(state.run, now)}` };
    case 'due':
      return {
        word: 'Due',
        detail: `due — ${describeMoment(state.slotAt, now)} passed, starts within 30s`,
      };
    case 'missed':
      return {
        word: 'Missed',
        detail: `missed ${describeMoment(state.slotAt, now)} — Bobble was not open · next ${describeMoment(state.nextAt, now)}`,
      };
    case 'paused':
      return { word: 'Paused', detail: 'paused — kept, not fired' };
    case 'off':
      return { word: 'Off', detail: 'scheduling is off' };
    case 'manual':
      return { word: 'Manual', detail: 'only when you run it' };
    case 'scheduled':
      return {
        word: 'Next',
        detail: `next ${describeMoment(state.nextAt, now)} · ${describeDelta(state.nextAt, now)}`,
      };
  }
}

export function StatePill({ state, now }: { state: TaskState; now: number }) {
  const { word } = stateLine(state, now);
  const tone =
    state.kind === 'running' || state.kind === 'due'
      ? 'live'
      : state.kind === 'missed'
        ? 'warn'
        : state.kind === 'scheduled'
          ? 'ok'
          : undefined;
  return (
    <span className="sc-pill" data-tone={tone}>
      {state.kind === 'running' ? <Spinner size={10} /> : null}
      {word}
    </span>
  );
}

export function OutcomeGlyph({ run, size = 14 }: { run: TaskRun; size?: number }) {
  if (run.status === 'running') return <Spinner size={size - 2} />;
  if (run.status === 'error')
    return <IconAlert size={size} style={{ color: 'var(--pd-status-danger-fg)' }} />;
  return <IconCheck size={size} style={{ color: 'var(--pd-status-success-fg)' }} />;
}

/* ---- reach ---------------------------------------------------------------- */

const REACH_ICON: Record<string, (p: { size?: number }) => ReactNode> = {
  calendar: (p) => <IconCalendar {...p} />,
  mail: (p) => <IconMail {...p} />,
  reminders: (p) => <IconCheckCircle {...p} />,
  messages: (p) => <IconBell {...p} />,
  contacts: (p) => <IconHand {...p} />,
  web: (p) => <IconGlobe {...p} />,
  terminal: (p) => <IconTerminal {...p} />,
  files: (p) => <IconFolder {...p} />,
  image: (p) => <IconImage {...p} />,
  video: (p) => <IconFilm {...p} />,
  audio: (p) => <IconWaveform {...p} />,
};

export function ReachChip({ reach }: { reach: Reach }) {
  const icon = REACH_ICON[reach.id];
  return (
    <span className="sc-chip">
      {icon?.({ size: 12 })}
      {reach.label}
    </span>
  );
}

/**
 * Where a task runs and what it has reached. The folder is a fact from the
 * task; the rest is the tool trail of its real runs. A task that has never run
 * shows only the folder — a guess dressed as a chip is worse than nothing.
 */
export function ReachRow({
  task,
  runs,
  max = 6,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  max?: number;
}) {
  const folder = folderName(task.cwd);
  const reach = reachFromRuns(runs).slice(0, max);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span
        className="sc-chip"
        title={task.cwd ?? 'A folder of its own under ~/.pi/desktop/scheduled-runs'}
      >
        <IconFolder size={12} />
        {folder ?? 'Own folder'}
      </span>
      {reach.map((r) => (
        <ReachChip key={r.id} reach={r} />
      ))}
    </span>
  );
}

/** The glyph that stands for a task: its first real reach, else a clock. */
export function TaskGlyph({
  task,
  runs,
  size = 16,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  size?: number;
}) {
  const first = reachFromRuns(runs)[0];
  if (first !== undefined) {
    const icon = REACH_ICON[first.id];
    if (icon !== undefined) return <>{icon({ size })}</>;
  }
  if (task.frequency === 'manual') return <IconHand size={size} />;
  return <IconClock size={size} />;
}

/* ---- week strip ----------------------------------------------------------- */

export function WeekStrip({ task, now }: { task: ScheduledTask; now: number }) {
  const on = weekPattern(task, now);
  const labels = weekLabels(now);
  return (
    <span
      className="sc-week"
      role="img"
      aria-label={`fires on ${on.filter(Boolean).length} of the next 7 days`}
    >
      {on.map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the strip is positional by design
        <span key={i} className="sc-week-day" data-on={v}>
          <span className="sc-week-day-dot" />
          <span className="sc-week-day-label">{labels[i]}</span>
        </span>
      ))}
    </span>
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

export { TASK_TEMPLATES };

/* ---- controls ------------------------------------------------------------- */

/** The feature switch, labelled, wherever a candidate puts it. */
export function SchedulingSwitch({ enabled }: { enabled: boolean }) {
  return (
    <span className="flex items-center gap-2 text-footnote text-text-secondary">
      <span>{enabled ? 'Scheduling on' : 'Scheduling off'}</span>
      <Switch
        checked={enabled}
        onCheckedChange={(v) => void taskActions().setEnabled(v)}
        aria-label="Scheduling"
        data-testid="sc-scheduling-switch"
      />
    </span>
  );
}

/**
 * Delete that asks once, in place. The shipping row deletes on a single click
 * and takes the task's whole history with it; a second click four inches away
 * in a dialog is not the answer either. The button becomes the question.
 */
export function TwoStepDelete({
  onConfirm,
  label = 'Delete',
  compact = false,
}: {
  onConfirm: () => void;
  label?: string;
  compact?: boolean;
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
        data-testid="sc-delete"
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {!compact ? (
        <span className="text-caption text-text-muted">Also deletes its past runs.</span>
      ) : null}
      <button
        type="button"
        className="pd-btn pd-btn--danger pd-btn--sm pd-focusable"
        onClick={onConfirm}
        data-testid="sc-delete-confirm"
      >
        Delete
      </button>
      <button
        type="button"
        className="pd-btn pd-btn--ghost pd-btn--sm pd-focusable"
        onClick={() => setArmed(false)}
      >
        Keep
      </button>
    </span>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-footnote text-text-muted">
      <IconArrowRight size={14} />
      {children}
    </div>
  );
}
