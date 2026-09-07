/**
 * CANDIDATE 1 — THE LEDGER.
 *
 * The argument: a scheduled task is judged by what it left behind. A run
 * happens in a throwaway session with nobody watching, so its record is the
 * only trace — and the shipping screen hides that record behind a "Past runs"
 * button on every row. Here the run history IS the page: a list of tasks on
 * the left, and on the right the selected task's contract, where it works,
 * what it has actually reached, and its runs as a timeline you read top-down.
 *
 * Mail-client anatomy on purpose — the thing people already know for "a list
 * of sources, and what each one delivered". Under ~720px the panes stack and
 * a row pushes its detail in.
 */
import {
  Button,
  IconChevronLeft,
  IconPencil,
  IconPlus,
  ScrollArea,
  SearchInput,
  Switch,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduledTask } from '../../../electron/scheduled/schedule-logic';
import type { TaskDraft, TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { cx } from '../../onboarding/cx';
import { describeDelta, describeSchedule, type TaskState, tally, taskState } from './derive';
import { registerCandidateStates } from './hook';
import { IconPlay } from './icons';
import { RunLedger } from './RunLedger';
import {
  MachineStrip,
  ReachRow,
  SchedulingSwitch,
  StatePill,
  StatusGlyph,
  stateLine,
  TASK_TEMPLATES,
  TaskGlyph,
  TemplateIcon,
  TwoStepDelete,
  taskActions,
  templateDraft,
  useContainerWidth,
  useNow,
  useSchedule,
} from './shared';
import { TaskEditor } from './TaskEditor';

type Mode = { kind: 'view' } | { kind: 'new'; initial?: Partial<ScheduledTask> } | { kind: 'edit' };

/** Attention first: running and due, then by next run, then by-hand, then paused. */
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
    case 'off':
      return 5;
  }
}

function trailing(state: TaskState, now: number): string {
  switch (state.kind) {
    case 'running':
      return 'running';
    case 'due':
      return 'due';
    case 'missed':
      return 'missed';
    case 'scheduled':
      return describeDelta(state.nextAt, now);
    case 'manual':
      return 'by hand';
    case 'paused':
      return 'paused';
    case 'off':
      return 'off';
  }
}

function TaskRow({
  task,
  runs,
  state,
  now,
  selected,
  onSelect,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const muted = state.kind === 'paused' || state.kind === 'off';
  return (
    <button
      type="button"
      className="sc-row"
      data-selected={selected}
      data-muted={muted}
      onClick={onSelect}
      data-testid={`sc-ledger-row-${task.id}`}
    >
      <StatusGlyph state={state} runs={runs} />
      <span className="min-w-0 flex-1">
        <span className="sc-row-name block">{task.name}</span>
        {/* The glyph already says how the last run went; the line stays a schedule. */}
        <span className="sc-row-meta block">{describeSchedule(task)}</span>
      </span>
      <span className="sc-time shrink-0 text-caption text-text-muted">{trailing(state, now)}</span>
    </button>
  );
}

function TemplatesPane({
  onPick,
  hasTasks,
}: {
  onPick: (t: Partial<ScheduledTask>) => void;
  hasTasks: boolean;
}) {
  return (
    <div data-testid="sc-ledger-templates">
      <h2 className="text-heading font-medium text-text-primary">
        {hasTasks ? 'Add another' : 'Nothing scheduled yet'}
      </h2>
      <p className="mt-1 text-footnote text-text-muted">
        Start from one of these, or write your own. Every one runs on this Mac and nothing it reads
        leaves it.
      </p>
      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {TASK_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="sc-card sc-card--clickable flex items-start gap-3 p-3.5 text-left"
            onClick={() => onPick(templateDraft(t))}
            data-testid={`sc-template-${t.id}`}
          >
            <span className="sc-tile">
              <TemplateIcon id={t.id} />
            </span>
            <span className="min-w-0">
              <span className="block text-body font-medium text-text-primary">{t.name}</span>
              <span className="sc-clamp-2 mt-0.5 block text-footnote text-text-secondary">
                {t.blurb}
              </span>
              <span className="mt-1.5 block text-caption text-text-muted">
                {describeSchedule({
                  id: t.id,
                  name: t.name,
                  prompt: t.prompt,
                  frequency: t.frequency,
                  hour: t.hour,
                  minute: t.minute,
                  weekday: t.weekday,
                  enabled: true,
                  createdAt: 0,
                })}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Detail({
  task,
  runs,
  state,
  now,
  onEdit,
  onDeleted,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { detail } = stateLine(state, now);
  const counts = tally(runs);
  const running = state.kind === 'running';
  return (
    <div data-testid="sc-ledger-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="sc-tile sc-tile--lg">
              <TaskGlyph task={task} runs={runs} size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="sc-detail-title truncate text-text-primary">{task.name}</h2>
              <p className="text-footnote text-text-muted">
                {describeSchedule(task)} · {detail}
              </p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => void taskActions().runNow(task.id)}
            data-testid="sc-run-now"
          >
            <IconPlay size={12} /> {running ? 'Running…' : 'Run now'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} data-testid="sc-edit">
            <IconPencil size={12} /> Edit
          </Button>
          <span className="ml-1 flex items-center gap-2 text-footnote text-text-muted">
            <Switch
              size="sm"
              checked={task.enabled}
              aria-label={task.enabled ? 'Pause this task' : 'Resume this task'}
              onCheckedChange={(v) => void taskActions().update(task.id, { enabled: v })}
              data-testid="sc-task-switch"
            />
          </span>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <StatePill state={state} now={now} />
        <ReachRow task={task} runs={runs} />
      </div>

      <pre className="sc-prompt mt-4">{task.prompt}</pre>

      <div className="mt-6 flex items-baseline justify-between">
        <h3 className="sc-section-title">Runs</h3>
        {counts.ok + counts.error > 0 ? (
          <span className="text-caption text-text-muted sc-time">
            {counts.ok} ok{counts.error > 0 ? ` · ${counts.error} failed` : ''}
          </span>
        ) : null}
      </div>
      <RunLedger key={task.id} taskId={task.id} runs={runs ?? []} now={now} open="first" />

      <div className="mt-8 flex justify-end">
        <TwoStepDelete
          onConfirm={() => {
            void taskActions().remove(task.id);
            onDeleted();
          }}
        />
      </div>
    </div>
  );
}

export function LedgerCandidate() {
  const { enabled, tasks, runs, loaded } = useSchedule();
  const now = useNow();
  const [rootRef, width] = useContainerWidth<HTMLDivElement>();
  const stacked = width > 0 && width < 720;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [query, setQuery] = useState('');
  const [detailShown, setDetailShown] = useState(false);

  const rows = useMemo(
    () =>
      tasks
        .map((task) => ({ task, state: taskState(task, runs[task.id], now, enabled) }))
        .filter(({ task }) => task.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => {
          const r = rank(a.state) - rank(b.state);
          if (r !== 0) return r;
          const an = a.state.kind === 'scheduled' ? a.state.nextAt : Number.POSITIVE_INFINITY;
          const bn = b.state.kind === 'scheduled' ? b.state.nextAt : Number.POSITIVE_INFINITY;
          return an - bn || a.task.name.localeCompare(b.task.name);
        }),
    [tasks, runs, now, enabled, query],
  );

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const shown = mode.kind === 'view' && selected === null ? (rows[0]?.task ?? null) : selected;
  const shownState = shown === null ? null : taskState(shown, runs[shown.id], now, enabled);

  // The probe's named states: default (the task with the most history — the one
  // that shows the ledger), running, new.
  const latest = useRef({ tasks, runs });
  latest.current = { tasks, runs };
  useEffect(
    () =>
      registerCandidateStates('ledger', ['default', 'running', 'new'], (s) => {
        const { tasks: ts, runs: rs } = latest.current;
        if (s === 'new') {
          setMode({ kind: 'new' });
          return;
        }
        setMode({ kind: 'view' });
        if (s === 'running') {
          const live = ts.find((t) => rs[t.id]?.[0]?.status === 'running');
          setSelectedId(live?.id ?? null);
        } else {
          const richest = [...ts].sort(
            (a, b) => (rs[b.id]?.length ?? 0) - (rs[a.id]?.length ?? 0),
          )[0];
          setSelectedId(richest?.id ?? null);
        }
        setDetailShown(true);
      }),
    [],
  );

  const save = (draft: TaskDraft) => {
    if (mode.kind === 'edit' && shown !== null) void taskActions().update(shown.id, draft);
    else
      void taskActions()
        .create(draft)
        .then((t) => {
          if (t !== null) setSelectedId(t.id);
        });
    setMode({ kind: 'view' });
  };

  const showList = !stacked || !detailShown;
  const showDetail = !stacked || detailShown;

  return (
    <div ref={rootRef} className={cx('sc-page', stacked && 'sc-narrow')} data-testid="sc-ledger">
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-4 pb-3">
        <div>
          <h1 className="sc-title">Scheduled</h1>
          <p className="sc-subtitle">What ran while you were away, and what runs next.</p>
        </div>
        <div className="flex items-center gap-3">
          <SchedulingSwitch enabled={enabled} />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setMode({ kind: 'new' });
              setDetailShown(true);
            }}
            data-testid="sc-new"
          >
            <IconPlus size={14} /> New task
          </Button>
        </div>
      </header>
      <div className="px-6 pb-3">
        <MachineStrip tasks={tasks} runs={runs} now={now} enabled={enabled} />
      </div>

      <div className="flex min-h-0 flex-1 border-t border-border-subtle">
        {showList ? (
          <aside
            className={cx(
              'flex shrink-0 flex-col border-border-subtle',
              stacked ? 'w-full' : 'w-[320px] border-r',
            )}
          >
            <div className="px-3 pt-3 pb-2">
              <SearchInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tasks"
                data-testid="sc-ledger-search"
              />
            </div>
            <ScrollArea className="min-h-0 flex-1 px-2 pb-4">
              {loaded && rows.length === 0 ? (
                <p className="px-3 py-6 text-footnote text-text-muted">
                  {query !== '' ? 'No task matches.' : 'Nothing scheduled yet.'}
                </p>
              ) : (
                rows.map(({ task, state }) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    runs={runs[task.id]}
                    state={state}
                    now={now}
                    selected={shown?.id === task.id && mode.kind !== 'new'}
                    onSelect={() => {
                      setSelectedId(task.id);
                      setMode({ kind: 'view' });
                      setDetailShown(true);
                    }}
                  />
                ))
              )}
              {loaded && tasks.length > 0 ? (
                <button
                  type="button"
                  className="sc-row mt-2"
                  onClick={() => {
                    setSelectedId(null);
                    setMode({ kind: 'new' });
                    setDetailShown(true);
                  }}
                  data-testid="sc-ledger-add-row"
                >
                  <span style={{ color: 'var(--pd-text-muted)', display: 'inline-flex' }}>
                    <IconPlus size={16} />
                  </span>
                  <span className="sc-row-meta">Add a task</span>
                </button>
              ) : null}
            </ScrollArea>
          </aside>
        ) : null}

        {showDetail ? (
          <section className="flex min-w-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-[780px] px-7 py-5">
                {stacked ? (
                  <button
                    type="button"
                    className="mb-3 inline-flex items-center gap-1 text-footnote text-text-secondary pd-focusable"
                    onClick={() => setDetailShown(false)}
                  >
                    <IconChevronLeft size={14} /> All tasks
                  </button>
                ) : null}
                {mode.kind === 'new' ? (
                  <div>
                    <h2 className="mb-4 text-heading font-medium text-text-primary">New task</h2>
                    <TaskEditor
                      initial={mode.initial}
                      onCancel={() => setMode({ kind: 'view' })}
                      onSave={save}
                      layout="pane"
                    />
                    {tasks.length === 0 || mode.initial === undefined ? (
                      <div className="mt-8">
                        <TemplatesPane
                          hasTasks={tasks.length > 0}
                          onPick={(initial) => setMode({ kind: 'new', initial })}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : mode.kind === 'edit' && shown !== null ? (
                  <div>
                    <h2 className="mb-4 text-heading font-medium text-text-primary">
                      Edit {shown.name}
                    </h2>
                    <TaskEditor
                      initial={shown}
                      editingId={shown.id}
                      onCancel={() => setMode({ kind: 'view' })}
                      onSave={save}
                      layout="pane"
                    />
                  </div>
                ) : shown !== null && shownState !== null ? (
                  <Detail
                    task={shown}
                    runs={runs[shown.id]}
                    state={shownState}
                    now={now}
                    onEdit={() => setMode({ kind: 'edit' })}
                    onDeleted={() => {
                      setSelectedId(null);
                      setDetailShown(false);
                    }}
                  />
                ) : (
                  <TemplatesPane
                    hasTasks={false}
                    onPick={(initial) => setMode({ kind: 'new', initial })}
                  />
                )}
              </div>
            </ScrollArea>
          </section>
        ) : null}
      </div>
    </div>
  );
}
