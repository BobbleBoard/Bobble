/**
 * SCHEDULED TASKS — the page.
 *
 * The argument: a scheduled task is judged by what it left behind. A run
 * happens in a throwaway session with nobody watching, so its record is the
 * only trace — and it belongs ON the task's page, as a ledger you read
 * top-down, not behind a button on every row.
 *
 * Two pages, one thing on screen at a time:
 *
 *   THE LIST. A plain title, one line under it, and the tasks as rows straight
 *   on the background — a tile that says how the last run went, the name, the
 *   schedule with the day it fires next, and a trailing word only where the
 *   state is the information (running with its elapsed time, due, missed,
 *   paused, off). Sorted by attention, then by when: running, due, missed,
 *   then by next run, then by-hand, then paused. Under the list, one quiet
 *   row offers the suggestions; on an empty schedule they are the page.
 *
 *   THE TASK. Opened from a row, with "All tasks" as the way back: Run now (or
 *   Stop, which is real — tasks:stop disposes the run's bridge and finalises
 *   the record), Edit, the switch; the instruction; three facts (what it has
 *   reached, where it runs, what runs it); and the ledger — every run's real
 *   result, duration, error and model.
 *
 * New task and Edit are one dialog (TaskEditor.tsx). The sentence parse lives
 * under the dialog's instruction field, where it is used once per task,
 * rather than as a box on the page at rest. The model can also create tasks
 * mid-chat with `create_scheduled_task`; they land in the list live.
 *
 * This replaced a two-pane list+detail with a sentence box over it — judged
 * right on substance and too much apparatus. What was kept is the substance:
 * the ledger, the derived states, the consequence line, Stop.
 */
import './scheduled.css';
import {
  Button,
  CollapsibleSearch,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconPlus,
  ScrollArea,
  Switch,
} from '@pi-desktop/ui';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduledTask } from '../../electron/scheduled/schedule-logic';
import type { TaskDraft, TaskRun } from '../../electron/scheduled/scheduled-contract';
import { cx } from '../onboarding/cx';
import {
  describeDuration,
  describeNextDay,
  describeSchedule,
  stateClause,
  type TaskState,
  tally,
  taskState,
} from './derive';
import { IconPause, IconPlay, IconStop } from './icons';
import { RunLedger } from './RunLedger';
import {
  DeleteFooter,
  describeTemplateSchedule,
  ReachBlock,
  SchedulingSwitch,
  SectionTitle,
  StatusGlyph,
  TASK_TEMPLATES,
  TemplateIcon,
  taskActions,
  templateDraft,
  useContainerWidth,
  useNow,
  useSchedule,
} from './shared';
import { TaskDialog } from './TaskEditor';
import type { TaskTemplate } from './templates';

/**
 * The dialog's draft. `seq` is its identity: the dialog is keyed by it, so a
 * new draft is a fresh form, never the previous values under a new heading.
 */
type Draft =
  | { kind: 'new'; seq: number; initial?: Partial<ScheduledTask> }
  | { kind: 'edit'; seq: number; task: ScheduledTask };

/** Below this much page, the switch drops its label and the suggestions go to one column. */
const COMPACT_BELOW = 700;
const TWO_COLUMNS_FROM = 808;

/** Attention first: running, then due, then missed, then by next run, then by-hand, then paused. */
function rank(state: TaskState): number {
  switch (state.kind) {
    case 'running':
      return 0;
    case 'due':
      return 1;
    case 'missed':
      return 2;
    case 'scheduled':
      return 3;
    case 'manual':
      return 4;
    case 'paused':
      return 5;
    case 'off':
      // Where it would be — flipping the switch must not reshuffle the list.
      return rank(state.inner);
  }
}

/** The moment a row sorts by within its rank. */
function sortKey(state: TaskState): number {
  switch (state.kind) {
    case 'scheduled':
    case 'missed':
      return state.nextAt;
    case 'due':
      return state.slotAt;
    case 'running':
      return state.run.startedAt;
    case 'off':
      return sortKey(state.inner);
    default:
      return 0;
  }
}

/**
 * The trailing word of a row. The line already says the schedule and the day
 * it fires next, so only a state that is not "on schedule" has anything to
 * add — running (with its elapsed time), due, missed, paused, off.
 */
function trailing(state: TaskState, now: number): string {
  switch (state.kind) {
    case 'running':
      return describeDuration(state.run, now);
    case 'due':
      return 'due';
    case 'missed':
      return 'missed';
    case 'paused':
      return 'paused';
    case 'off':
      return 'off';
    case 'manual':
    case 'scheduled':
      return '';
  }
}

/** The clause after the schedule in a ROW: only the day it fires next. */
function rowClause(state: TaskState, now: number): string {
  if (state.kind === 'scheduled' || state.kind === 'missed')
    return ` · next ${describeNextDay(state.nextAt, now)}`;
  return '';
}

/* ---- pieces ---------------------------------------------------------------- */

function TaskRow({
  task,
  runs,
  state,
  now,
  onOpen,
  rowRef,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  onOpen: () => void;
  rowRef: (el: HTMLButtonElement | null) => void;
}) {
  const muted = state.kind === 'paused' || state.kind === 'off';
  const word = trailing(state, now);
  return (
    <button
      ref={rowRef}
      type="button"
      className="sd-row pd-focusable"
      data-muted={muted}
      data-state={state.kind}
      onClick={onOpen}
      data-testid={`sd-row-${task.id}`}
    >
      <span className="sd-tile">
        <StatusGlyph state={state} runs={runs} />
      </span>
      <span className="sd-row-text">
        <span className="sd-row-name">{task.name}</span>
        <span className="sd-row-line">
          {describeSchedule(task)}
          {rowClause(state, now)}
        </span>
      </span>
      {word !== '' ? (
        <span
          className={cx(
            'sd-row-word',
            state.kind === 'missed'
              ? 'sd-warn'
              : state.kind === 'running'
                ? 'sd-live'
                : 'text-text-muted',
          )}
          data-testid={`sd-row-word-${task.id}`}
        >
          {word}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The suggestions, as rows: tile · name · what it does · when · "+". Two
 * columns when the page is wide enough for two, one otherwise. A template
 * whose name is already a task is not offered twice.
 */
function Suggestions({
  templates,
  columns,
  onPick,
}: {
  templates: readonly TaskTemplate[];
  columns: 1 | 2;
  onPick: (t: TaskTemplate) => void;
}) {
  return (
    <div className="sd-suggest-grid" data-columns={columns} data-testid="sd-templates">
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          className="sd-row pd-focusable"
          onClick={() => onPick(t)}
          data-testid={`sd-template-${t.id}`}
        >
          <span className="sd-tile">
            <TemplateIcon id={t.id} />
          </span>
          <span className="sd-row-text">
            <span className="sd-row-name">{t.name}</span>
            <span className="sd-row-line sd-row-line--wrap">{t.blurb}</span>
            <span className="sd-row-when">{describeTemplateSchedule(t)}</span>
          </span>
          <span className="sd-row-plus" aria-hidden="true">
            <IconPlus size={16} />
          </span>
        </button>
      ))}
    </div>
  );
}

function TaskPage({
  task,
  runs,
  state,
  now,
  schedulingOn,
  onBack,
  onEdit,
  onDeleted,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  schedulingOn: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const counts = tally(runs);
  const running = state.kind === 'running';
  const total = runs?.length ?? 0;
  const clause = stateClause(state, now);
  // The page takes the keyboard as it opens — the row that opened it is gone —
  // so Escape and Tab start from its title, not from nowhere.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const finished = counts.ok + counts.error + counts.stopped;
  // Only the counts that are not zero: "0 ok · 1 stopped" is a zero doing nothing.
  const runsAside =
    finished === 0
      ? undefined
      : [
          counts.ok > 0 ? `${counts.ok} ok` : null,
          counts.error > 0 ? `${counts.error} failed` : null,
          counts.stopped > 0 ? `${counts.stopped} stopped` : null,
        ]
          .filter((s) => s !== null)
          .join(' · ');
  return (
    <div className="sd-task" data-testid="sd-detail">
      <button type="button" className="sd-back pd-focusable" onClick={onBack} data-testid="sd-back">
        <IconChevronLeft size={14} /> All tasks
      </button>
      <div className="sd-task-head">
        <span className="sd-tile">
          <StatusGlyph state={state} runs={runs} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 ref={titleRef} className="sd-task-title" tabIndex={-1} data-testid="sd-detail-title">
            {task.name}
          </h1>
          <p className="sd-task-line" data-testid="sd-detail-schedule">
            {describeSchedule(task)}
            {clause !== '' ? (
              <>
                {' · '}
                <span
                  className={cx(
                    state.kind === 'missed' && 'sd-warn',
                    state.kind === 'running' && 'sd-live',
                  )}
                  data-testid="sd-state"
                >
                  {clause}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="sd-task-actions">
          {/*
           * Run now becomes Stop while a run is going, in the same place at the
           * same size — the button's job flips, its footprint does not. Stop is
           * real: main disposes the run's bridge, which frees the model slot it
           * held, and the record is finalised as stopped.
           */}
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void taskActions().stop(task.id)}
              data-testid="sd-stop"
            >
              <IconStop size={12} /> Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void taskActions().runNow(task.id)}
              data-testid="sd-run-now"
            >
              <IconPlay size={12} /> Run now
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onEdit} data-testid="sd-edit">
            <IconPencil size={12} /> Edit
          </Button>
          {/* Dimmed, not disabled, while scheduling is off: on, but not firing. */}
          <span
            className={cx('ml-1 flex items-center', !schedulingOn && 'sd-dim')}
            title={
              schedulingOn
                ? undefined
                : 'Scheduling is off. This keeps its own setting for when it is back on.'
            }
          >
            <Switch
              size="sm"
              checked={task.enabled}
              aria-label={task.enabled ? 'Pause this task' : 'Resume this task'}
              onCheckedChange={(v) => void taskActions().update(task.id, { enabled: v })}
              data-testid="sd-task-switch"
            />
          </span>
        </div>
      </div>

      {/* The instruction, as the plain text it is. */}
      <p className="sd-prompt">{task.prompt}</p>
      <ReachBlock task={task} runs={runs} />

      <SectionTitle className="mt-7" aside={runsAside}>
        Runs
      </SectionTitle>
      <RunLedger key={task.id} task={task} runs={runs ?? []} now={now} open="first" />

      <DeleteFooter
        runCount={total}
        onConfirm={() => {
          void taskActions().remove(task.id);
          onDeleted();
        }}
      />
    </div>
  );
}

/* ---- the page ---------------------------------------------------------------- */

export function ScheduledView() {
  const { enabled, tasks, runs, loaded } = useSchedule();
  const anyRunning = useMemo(
    () => tasks.some((t) => runs[t.id]?.[0]?.status === 'running'),
    [tasks, runs],
  );
  // A running row counts seconds; otherwise a minute is plenty.
  const now = useNow(anyRunning ? 1000 : 30_000);
  const [rootRef, width] = useContainerWidth<HTMLDivElement>();
  const compact = width > 0 && width < COMPACT_BELOW;
  const columns: 1 | 2 = width >= TWO_COLUMNS_FROM ? 2 : 1;
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  /** A row (by task id) that should take focus once it exists — after a save, or coming back. */
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftSeq = useRef(0);
  const nextSeq = () => ++draftSeq.current;

  const needle = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      tasks
        .map((task) => ({ task, state: taskState(task, runs[task.id], now, enabled) }))
        .filter(
          ({ task }) =>
            needle === '' ||
            task.name.toLowerCase().includes(needle) ||
            task.prompt.toLowerCase().includes(needle),
        )
        .sort((a, b) => {
          const r = rank(a.state) - rank(b.state);
          if (r !== 0) return r;
          const an = sortKey(a.state) || Number.POSITIVE_INFINITY;
          const bn = sortKey(b.state) || Number.POSITIVE_INFINITY;
          return an - bn || a.task.name.localeCompare(b.task.name);
        }),
    [tasks, runs, now, enabled, needle],
  );
  const orderedIds = useMemo(() => rows.map((r) => r.task.id), [rows]);

  // A template already on the list is not offered again.
  const suggestions = useMemo(() => {
    const names = new Set(tasks.map((t) => t.name.trim().toLowerCase()));
    return TASK_TEMPLATES.filter((t) => !names.has(t.name.toLowerCase()));
  }, [tasks]);

  const open = tasks.find((t) => t.id === openId) ?? null;
  const openState = open === null ? null : taskState(open, runs[open.id], now, enabled);
  const empty = loaded && tasks.length === 0;
  const page: 'list' | 'task' = open === null ? 'list' : 'task';

  // A new page starts at its top.
  const lastPage = useRef(page);
  useEffect(() => {
    if (lastPage.current === page) return;
    lastPage.current = page;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page]);

  // After a save, or coming back from a task, its row takes focus so ↓/↑ carry
  // on from it. Deferred a tick: the dialog that just closed hands the keyboard
  // back to the button that opened it in a timeout of its own (Radix's focus
  // scope), and this has to land after that, not before.
  useEffect(() => {
    if (focusRow === null || page !== 'list') return;
    const row = rowRefs.current.get(focusRow);
    if (row === undefined) return;
    const t = setTimeout(() => {
      row.focus();
      setFocusRow(null);
    }, 0);
    return () => clearTimeout(t);
  }, [focusRow, page]);

  // Escape on a task's page goes back to the list — from anywhere but a dialog or menu.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null || open === null || draft !== null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
      e.preventDefault();
      back();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  });

  const back = () => {
    if (open !== null) setFocusRow(open.id);
    setOpenId(null);
  };

  const save = (d: TaskDraft) => {
    if (draft?.kind === 'edit') {
      void taskActions().update(draft.task.id, d);
      setDraft(null);
      return;
    }
    void taskActions()
      .create(d)
      .then((t) => {
        if (t === null) return;
        setFocusRow(t.id);
      });
    setDraft(null);
    setSuggestionsOpen(false);
  };

  const newBlank = () => setDraft({ kind: 'new', seq: nextSeq() });
  const pickTemplate = (t: TaskTemplate) =>
    setDraft({ kind: 'new', seq: nextSeq(), initial: templateDraft(t) });

  /** ↓ / ↑ on the list move between rows. */
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const active = document.activeElement;
    const current = orderedIds.findIndex((id) => rowRefs.current.get(id) === active);
    if (current === -1) return;
    const nextIndex = Math.min(
      orderedIds.length - 1,
      Math.max(0, current + (e.key === 'ArrowDown' ? 1 : -1)),
    );
    const id = orderedIds[nextIndex];
    if (id === undefined) return;
    e.preventDefault();
    rowRefs.current.get(id)?.focus();
  };

  const moreNames = suggestions.slice(0, 2).map((t) => t.name);
  const moreRest = suggestions.length - moreNames.length;

  return (
    <div ref={rootRef} className="sd-page" data-testid="scheduled-view">
      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        {page === 'task' && open !== null && openState !== null ? (
          <div className="sd-body" key={`task-${open.id}`}>
            <TaskPage
              task={open}
              runs={runs[open.id]}
              state={openState}
              now={now}
              schedulingOn={enabled}
              onBack={back}
              onEdit={() => setDraft({ kind: 'edit', seq: nextSeq(), task: open })}
              onDeleted={() => setOpenId(null)}
            />
          </div>
        ) : (
          <div className="sd-body" key="list">
            <header className="sd-header">
              <h1 className="sd-title" data-testid="sd-title">
                Scheduled
              </h1>
              <div className="sd-header-actions">
                {tasks.length > 0 ? (
                  // A magnifier, not a field: nine tasks do not need a search box.
                  <div data-testid="sd-search">
                    <CollapsibleSearch
                      placeholder="Search"
                      value={query}
                      onChange={setQuery}
                      expanded={searchOpen}
                      onExpandedChange={(o) => {
                        setSearchOpen(o);
                        // Collapsing clears: a filtered list with no visible
                        // filter is a list that has lost rows for no reason.
                        if (!o) setQuery('');
                      }}
                      iconSize={14}
                    />
                  </div>
                ) : null}
                <SchedulingSwitch enabled={enabled} showLabel={!compact} />
                <Button variant="primary" size="sm" onClick={newBlank} data-testid="sd-new">
                  <IconPlus size={14} /> New task
                </Button>
              </div>
              {/* The line says what this is — and, when scheduling is off, says that instead. */}
              <p className="sd-lede" data-off={!enabled} data-testid="sd-lede">
                {enabled ? (
                  'What Bobble does on its own while it is open.'
                ) : (
                  <>
                    <IconPause size={14} />
                    <span>
                      Scheduling is off. Nothing fires until it is back on; you can still run a task
                      by hand.
                    </span>
                  </>
                )}
              </p>
            </header>

            {empty ? (
              <section className="sd-empty">
                <p className="sd-empty-title">No scheduled tasks yet.</p>
                <p className="sd-empty-line">
                  Start from one of these, or write your own with New task. Every one runs on this
                  Mac; it can read what is here and cannot send anything.
                </p>
                <Suggestions templates={suggestions} columns={columns} onPick={pickTemplate} />
              </section>
            ) : (
              <>
                <section className="sd-list" aria-label="Tasks" onKeyDown={onListKey}>
                  {loaded && rows.length === 0 ? (
                    <p className="sd-nothing">No task matches.</p>
                  ) : (
                    rows.map(({ task, state }) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        runs={runs[task.id]}
                        state={state}
                        now={now}
                        onOpen={() => setOpenId(task.id)}
                        rowRef={(el) => {
                          if (el === null) rowRefs.current.delete(task.id);
                          else rowRefs.current.set(task.id, el);
                        }}
                      />
                    ))
                  )}
                </section>
                {suggestions.length > 0 && needle === '' ? (
                  <section className="sd-more-section">
                    {/* One quiet row for the suggestions, the way a list says "and more". */}
                    <button
                      type="button"
                      className="sd-more pd-focusable"
                      aria-expanded={suggestionsOpen}
                      onClick={() => setSuggestionsOpen((v) => !v)}
                      data-testid="sd-more-templates"
                    >
                      <span className="sd-cluster" aria-hidden="true">
                        {suggestions.slice(0, 3).map((t) => (
                          <span key={t.id} className="sd-tile sd-tile--xs">
                            <TemplateIcon id={t.id} size={12} />
                          </span>
                        ))}
                      </span>
                      <span className="sd-more-text">
                        {suggestionsOpen ? 'Suggestions' : 'Start from a suggestion'}
                        {suggestionsOpen
                          ? ''
                          : ` — ${moreNames.join(', ')}${moreRest > 0 ? ` and ${moreRest} more` : ''}`}
                      </span>
                      <span className="sd-more-chev" data-open={suggestionsOpen}>
                        <IconChevronRight size={14} />
                      </span>
                    </button>
                    {suggestionsOpen ? (
                      <Suggestions
                        templates={suggestions}
                        columns={columns}
                        onPick={pickTemplate}
                      />
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </div>
        )}
      </ScrollArea>

      {draft !== null ? (
        <TaskDialog
          key={draft.seq}
          open
          initial={draft.kind === 'edit' ? draft.task : draft.initial}
          editingId={draft.kind === 'edit' ? draft.task.id : undefined}
          onClose={() => setDraft(null)}
          onSave={save}
        />
      ) : null}
    </div>
  );
}
