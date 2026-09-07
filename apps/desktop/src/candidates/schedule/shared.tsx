/**
 * Pieces every candidate shares: the store hook (with the seed guard), the
 * once-a-minute clock, status glyphs and pills, reach chips, template icons,
 * the section label and the two-step delete.
 *
 * Presentational rules: tokens only, the app's own icon recipe, the sibling
 * screens' conventions (Connectors' section heading, the Model hub's detail
 * title), and nothing that could be read as progress unless it is measured.
 *
 * Gone since round one: the "honesty strip" — three sentences under every
 * header, two of which never changed. What it said now lives where it changes
 * something: the subtitle, the editor's consequence line, the empty run list.
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
import {
  describeSchedule,
  normalizeTask,
  type ScheduledTask,
} from '../../../electron/scheduled/schedule-logic';
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
} from './derive';
import { runsWereSeeded } from './hook';
import {
  IconAlert,
  IconBell,
  IconCalendar,
  IconCheckCircle,
  IconDownload,
  IconHand,
  IconMail,
  IconMoon,
  IconPause,
  IconSun,
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

/**
 * The one machine fact that changes what happens next: a run cannot start
 * until a model is loaded, and loading one is the slow part of a first run.
 * Null when there is nothing to say — which is the common case, and why this
 * is a sentence in two places rather than a banner on every visit.
 */
export function useModelNote(): string | null {
  const status = useLlmStore((s) => s.status);
  if (status.phase === 'ready') return null;
  if (status.phase === 'starting') return 'the model is still loading';
  if (status.phase === 'downloading') return 'a model is still downloading';
  return 'no model is loaded yet — the first run loads one';
}

/**
 * What a run of this task would run ON, as far as the renderer can know it:
 * the model loaded right now, or the fact that none is. The run record does
 * not carry a model (NOTES proposes it should), so a PAST run cannot be
 * named — only what the next one would use. Said once, in the Reach block
 * and the editor's consequence line, because for a local app the model is
 * the quality, speed and memory decision.
 */
export function useRunsOn(): string {
  const status = useLlmStore((s) => s.status);
  // Loaded: the name and nothing else. "Gemma 4 12B, the model loaded now"
  // was a value explaining its own label (round-4 item 3).
  if (status.phase === 'ready' && status.model !== null) return status.model.displayName;
  if (status.phase === 'starting') return 'the model that is loading now';
  if (status.phase === 'downloading') return 'the model that is downloading now';
  return 'whichever model Bobble loads first — none is loaded yet';
}

/* ---- notices --------------------------------------------------------------- */

/** Shown only when scheduling is off: the one state where every row's countdown is a lie. */
export function OffNotice({ enabled }: { enabled: boolean }) {
  if (enabled) return null;
  return (
    <p className="sc-notice" data-testid="sc-off-notice">
      <IconPause size={14} />
      Scheduling is off. Nothing fires until you turn it back on; every task is kept, and you can
      still run one by hand.
    </p>
  );
}

/* ---- status --------------------------------------------------------------- */

/** A 16px glyph for a row: what is happening to this task, at a glance. */
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
   * was the row saying "fine" and "off" at once (round-4 item 5). The amber
   * "!" of a missed slot and the red "!" of a failed run stay: those are
   * facts about the past, and off does not change them.
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
  if (state.kind === 'manual') return <IconHand size={size} style={style(quiet)} />;
  if (last?.status === 'ok')
    return (
      <IconCheckCircle size={size} style={style(muted ? quiet : 'var(--pd-status-success-fg)')} />
    );
  return <IconClock size={size} style={style(quiet)} />;
}

/**
 * The state as a word, plus the one fact that matters for it. The detail is a
 * single clause: round one's "next Tomorrow 7:30 AM · in 22h 57m" said one
 * thing twice, and "missed … — Bobble was not open" claimed a cause the app
 * cannot know (closed, asleep, or scheduling off at the time all look the same).
 */
export function stateLine(state: TaskState, now: number): { word: string; detail: string } {
  switch (state.kind) {
    case 'running':
      return { word: 'Running', detail: `started ${describeDelta(state.run.startedAt, now)}` };
    case 'due':
      return {
        word: 'Due',
        detail: `${describeMoment(state.slotAt, now)} passed · starts within 30s`,
      };
    case 'missed':
      return {
        word: 'Missed',
        detail: `missed ${describeMoment(state.slotAt, now)} · next ${describeMoment(state.nextAt, now)}`,
      };
    case 'paused':
      return { word: 'Paused', detail: 'kept, not fired' };
    case 'off':
      return { word: 'Off', detail: 'scheduling is off' };
    case 'manual':
      return { word: 'By hand', detail: 'only when you run it' };
    case 'scheduled':
      return { word: 'Next', detail: `next ${describeMoment(state.nextAt, now)}` };
  }
}

/**
 * A pill only where the word IS the information: running, due, missed,
 * paused, by hand. A scheduled task gets no pill — round one gave it a
 * green "Next", which is colour reporting nothing — and neither does "off":
 * the header switch, the banner and the subtitle already say it, and a
 * fourth copy next to a blue per-task switch is the screen arguing with itself.
 */
export function StatePill({ state, now }: { state: TaskState; now: number }) {
  if (state.kind === 'scheduled' || state.kind === 'off') return null;
  const { word } = stateLine(state, now);
  const tone =
    state.kind === 'running' || state.kind === 'due'
      ? 'live'
      : state.kind === 'missed'
        ? 'warn'
        : undefined;
  return (
    <span className="sc-pill" data-tone={tone}>
      {state.kind === 'running' ? <Spinner size={10} /> : null}
      {state.kind === 'running' ? `Running · ${describeDuration(state.run, now)}` : word}
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

/**
 * The same facts as label/value rows, under the prompt — Connectors' "Reach"
 * block ("Touches", "Runs as") and the Claude reference's "Details" both put
 * the facts BELOW the text. A chip row between the title and the prompt was
 * an 82px stack before the contract; this is three quiet lines after it, and
 * "Own folder" stops pretending to be a reach: it is a place, on its own line.
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
  const runsOn = useRunsOn();
  return (
    <dl className="sc-facts" data-testid="sc-reach-block">
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
        {folder === undefined ? 'A folder of its own, kept per run' : `${folder} — ${task.cwd}`}
      </dd>
      <dt>Runs on</dt>
      <dd>{runsOn}</dd>
    </dl>
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
 * A section heading in the convention Connectors already uses — body weight,
 * primary colour, a muted count — with room for a fact on the right. Round one
 * used uppercase tracked captions, a convention no sibling screen has.
 */
export function SectionTitle({
  children,
  count,
  aside,
  className,
}: {
  children: ReactNode;
  count?: number;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className === undefined ? 'sc-section' : `sc-section ${className}`}>
      <h3 className="sc-section-title">
        {children}
        {count !== undefined ? <span className="sc-section-count">{count}</span> : null}
      </h3>
      {aside !== undefined ? <span className="sc-section-aside">{aside}</span> : null}
    </div>
  );
}

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
 * in a dialog is not the answer either. The button becomes the question —
 * "Delete for good?" — and disarms itself after four seconds. What deleting
 * takes with it is said by the footer the button sits in (DeleteFooter), not
 * repeated here.
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
        data-testid="sc-delete"
      >
        {label}
      </button>
    );
  }
  return (
    <span className="sc-delete-armed" data-testid="sc-delete-armed">
      <span className="text-footnote text-text-secondary">Delete for good?</span>
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
        data-testid="sc-delete-keep"
      >
        Keep
      </button>
    </span>
  );
}

/**
 * The end of a detail pane, in Connectors' form: a hairline, one sentence on
 * what deleting takes with it, and the control. A lone "Delete" at a height
 * that depended on the ledger's length said nothing about the 5 runs it
 * would take; this says it before the question is asked.
 */
export function DeleteFooter({ runCount, onConfirm }: { runCount: number; onConfirm: () => void }) {
  const what =
    runCount === 0
      ? 'Deleting removes the task. It has no runs to lose.'
      : `Deleting removes the task and its ${runCount === 1 ? 'one run' : `${runCount} runs`}.`;
  return (
    <div className="sc-footer" data-testid="sc-delete-footer">
      <span className="text-footnote text-text-muted">{what}</span>
      <TwoStepDelete onConfirm={onConfirm} />
    </div>
  );
}
