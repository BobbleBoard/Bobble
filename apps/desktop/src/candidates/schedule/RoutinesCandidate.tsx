/**
 * CANDIDATE 3 — ROUTINES.
 *
 * The argument: a scheduled task is a PROMPT WITH A CLOCK, and a connector or
 * a skill is just something that prompt can reach. So there are no cabinets:
 * a task, a template and "new" are the same kind of card, on one board, and
 * each card says what it has actually reached (from its runs) beside where it
 * works. the user: separate menus for plugins / connectors / skills are confusing;
 * this page never asks you to visit one.
 *
 * A card opens a sheet — the contract, the reach, the runs. Since round one
 * the card leads with the RESULT of its last run (the first sentence of the
 * report) rather than how long it took, the prompt is one line, and "new" is
 * a row, not a cell.
 */
import {
  Button,
  IconClose,
  IconPencil,
  IconPlus,
  ScrollArea,
  SearchInput,
  SegmentedControl,
  Switch,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeSchedule, type ScheduledTask } from '../../../electron/scheduled/schedule-logic';
import type { TaskDraft, TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { cx } from '../../onboarding/cx';
import { describeDelta, describeSoon, headline, type TaskState, tally, taskState } from './derive';
import { registerCandidateStates } from './hook';
import { IconPlay, IconRepeat } from './icons';
import { RunLedger } from './RunLedger';
import {
  describeTemplateSchedule,
  OffNotice,
  OutcomeGlyph,
  ReachRow,
  SchedulingSwitch,
  SectionTitle,
  StatePill,
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

type Filter = 'all' | 'active' | 'paused' | 'manual';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'manual', label: 'By hand' },
];

function matches(task: ScheduledTask, f: Filter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'active':
      return task.enabled && task.frequency !== 'manual';
    case 'paused':
      return !task.enabled;
    case 'manual':
      return task.frequency === 'manual';
  }
}

function nextLine(state: TaskState, now: number): string {
  switch (state.kind) {
    case 'running':
      return ''; // the pill says it
    case 'due':
      return 'due now';
    case 'missed':
      return `next ${describeSoon(state.nextAt, now)}`; // the pill says "Missed"
    case 'scheduled':
      return `next ${describeSoon(state.nextAt, now)}`;
    case 'manual':
      return '';
    case 'paused':
      return 'paused';
    case 'off':
      return 'scheduling off';
  }
}

function RoutineCard({
  task,
  runs,
  state,
  now,
  onOpen,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  onOpen: () => void;
}) {
  const last = runs?.[0];
  const muted = state.kind === 'paused' || state.kind === 'off';
  return (
    <button
      type="button"
      className="sc-card sc-card--clickable flex flex-col p-4 text-left"
      onClick={onOpen}
      data-testid={`sc-routine-${task.id}`}
      style={muted ? { opacity: 0.72 } : undefined}
    >
      <span className="flex items-start gap-3">
        <span className="sc-tile">
          <TaskGlyph task={task} runs={runs} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="sc-row-name min-w-0 flex-1">{task.name}</span>
            <StatePill state={state} now={now} />
          </span>
          <span className="sc-clamp-1 mt-0.5 block text-footnote text-text-muted">
            {task.prompt}
          </span>
        </span>
      </span>
      <span className="mt-3 flex items-center justify-between gap-2 text-caption text-text-muted">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <IconRepeat size={12} />
          <span className="truncate">{describeSchedule(task)}</span>
        </span>
        <span className="sc-time shrink-0">{nextLine(state, now)}</span>
      </span>
      {/* What it left behind, last time: the sentence, not the stopwatch. */}
      <span className="mt-2 flex items-center gap-1.5 text-footnote">
        {last !== undefined ? (
          <>
            <OutcomeGlyph run={last} size={13} />
            <span className="shrink-0 text-text-muted">
              {last.status === 'running' ? 'working' : describeDelta(last.startedAt, now)}
            </span>
            <span
              className={cx(
                'sc-clamp-1 min-w-0',
                last.status === 'error' ? 'text-status-danger-fg' : 'text-text-secondary',
              )}
            >
              {last.status === 'running' ? '' : `— ${headline(last)}`}
            </span>
          </>
        ) : (
          <span className="text-text-muted">Not run yet</span>
        )}
      </span>
      <span className="mt-3">
        <ReachRow task={task} runs={runs} max={3} />
      </span>
    </button>
  );
}

function TemplateCard({ id, onPick }: { id: string; onPick: () => void }) {
  const t = TASK_TEMPLATES.find((x) => x.id === id);
  if (t === undefined) return null;
  return (
    <button
      type="button"
      className="sc-card sc-card--ghost sc-card--clickable flex items-start gap-3 p-4 text-left"
      onClick={onPick}
      data-testid={`sc-template-${t.id}`}
    >
      <span className="sc-tile">
        <TemplateIcon id={t.id} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="sc-row-name min-w-0 flex-1">{t.name}</span>
          <IconPlus size={14} style={{ color: 'var(--pd-text-muted)' }} />
        </span>
        <span className="sc-clamp-2 mt-0.5 block text-footnote text-text-secondary">{t.blurb}</span>
        <span className="mt-2 block text-caption text-text-muted">
          {describeTemplateSchedule(t)}
        </span>
      </span>
    </button>
  );
}

function Sheet({
  task,
  runs,
  state,
  now,
  onClose,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const { detail } = stateLine(state, now);
  const counts = tally(runs);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, editing]);
  return (
    <>
      <button type="button" aria-label="Close" className="sc-sheet-backdrop" onClick={onClose} />
      <div className="sc-sheet" role="dialog" aria-label={task.name} data-testid="sc-sheet">
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <span className="sc-tile sc-tile--lg">
            <TaskGlyph task={task} runs={runs} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-heading font-medium text-text-primary">{task.name}</h2>
              <StatePill state={state} now={now} />
            </div>
            <p className="text-footnote text-text-muted">
              {describeSchedule(task)}
              {/* A by-hand task's schedule line already is its state; do not say it twice. */}
              {state.kind === 'manual' ? '' : ` · ${detail}`}
            </p>
          </div>
          <button
            type="button"
            className="sc-icon-btn"
            aria-label="Close"
            onClick={onClose}
            data-testid="sc-sheet-close"
          >
            <IconClose size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 px-5 pb-3">
          <Button
            variant="outline"
            size="sm"
            disabled={state.kind === 'running'}
            onClick={() => void taskActions().runNow(task.id)}
            data-testid="sc-run-now"
          >
            <IconPlay size={12} /> {state.kind === 'running' ? 'Running…' : 'Run now'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing((v) => !v)}
            data-testid="sc-edit"
          >
            <IconPencil size={12} /> {editing ? 'Stop editing' : 'Edit'}
          </Button>
          <span className="ml-auto flex items-center gap-2 text-footnote text-text-muted">
            {task.enabled ? 'Active' : 'Paused'}
            <Switch
              size="sm"
              checked={task.enabled}
              aria-label={task.enabled ? 'Pause this routine' : 'Resume this routine'}
              onCheckedChange={(v) => void taskActions().update(task.id, { enabled: v })}
            />
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 pt-3 pb-6">
            {editing ? (
              <TaskEditor
                initial={task}
                editingId={task.id}
                layout="pane"
                onCancel={() => setEditing(false)}
                onSave={(d: TaskDraft) => {
                  void taskActions().update(task.id, d);
                  setEditing(false);
                }}
              />
            ) : (
              <>
                <div className="mb-3">
                  <ReachRow task={task} runs={runs} />
                </div>
                <pre className="sc-prompt">{task.prompt}</pre>
                <SectionTitle
                  className="mt-5"
                  count={runs !== undefined && runs.length > 0 ? runs.length : undefined}
                  aside={
                    counts.ok + counts.error > 0
                      ? `${counts.ok} ok${counts.error > 0 ? ` · ${counts.error} failed` : ''}`
                      : undefined
                  }
                >
                  Runs
                </SectionTitle>
                <RunLedger key={task.id} task={task} runs={runs ?? []} now={now} open="first" />
                <div className="mt-6 flex justify-end">
                  <TwoStepDelete
                    onConfirm={() => {
                      void taskActions().remove(task.id);
                      onClose();
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </>
  );
}

export function RoutinesCandidate() {
  const { enabled, tasks, runs, loaded } = useSchedule();
  const now = useNow();
  const [rootRef, width] = useContainerWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 700;
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<ScheduledTask> | null>(null);

  const cards = useMemo(
    () =>
      tasks
        .filter((t) => matches(t, filter))
        .filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()))
        .map((task) => ({ task, state: taskState(task, runs[task.id], now, enabled) }))
        .sort((a, b) => a.task.name.localeCompare(b.task.name)),
    [tasks, runs, now, enabled, filter, query],
  );
  const open = tasks.find((t) => t.id === openId) ?? null;
  const boardIsEmpty = loaded && tasks.length === 0;

  const latest = useRef({ tasks });
  latest.current = { tasks };
  useEffect(
    () =>
      registerCandidateStates('routines', ['default', 'editor', 'open'], (s) => {
        const { tasks: ts } = latest.current;
        setDraft(s === 'editor' ? {} : null);
        setOpenId(s === 'open' ? (ts[0]?.id ?? null) : null);
      }),
    [],
  );

  const create = (d: TaskDraft) => {
    void taskActions().create(d);
    setDraft(null);
  };

  return (
    <div
      ref={rootRef}
      className={cx('sc-page relative', narrow && 'sc-narrow')}
      data-testid="sc-routines"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-4 pb-3">
        <div>
          <h1 className="sc-title">Scheduled tasks</h1>
          <p className="sc-subtitle">Prompts with a clock, and what each one reached last time.</p>
        </div>
        <div className="flex items-center gap-3">
          <SchedulingSwitch enabled={enabled} />
          <Button variant="primary" size="sm" onClick={() => setDraft({})} data-testid="sc-new">
            <IconPlus size={14} /> New routine
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        <SegmentedControl
          aria-label="Show"
          options={FILTERS}
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
          data-testid="sc-filter"
        />
        <div className="min-w-[200px] flex-1">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search routines"
            data-testid="sc-routines-search"
          />
        </div>
      </div>
      {!enabled ? (
        <div className="px-6 pb-3">
          <OffNotice enabled={enabled} />
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pt-1 pb-16">
          {draft !== null ? (
            <div className="sc-card mb-3 max-w-[640px] p-4" data-testid="sc-routines-editor">
              <h2 className="mb-3 text-body font-medium text-text-primary">New routine</h2>
              <TaskEditor
                initial={draft}
                onCancel={() => setDraft(null)}
                onSave={create}
                layout="card"
              />
            </div>
          ) : (
            /* "New" is a row, not a cell: round one gave a button a 175px card. */
            <button
              type="button"
              className="sc-card sc-card--ghost sc-card--clickable mb-3 flex w-full items-center gap-3 px-4 py-2.5 text-left"
              onClick={() => setDraft({})}
              data-testid="sc-routines-new-card"
            >
              <span style={{ color: 'var(--pd-text-muted)', display: 'inline-flex' }}>
                <IconPlus size={16} />
              </span>
              <span className="text-body font-medium text-text-primary">New routine</span>
              <span className="text-footnote text-text-muted">
                — describe it in a sentence, time included, or start from one below
              </span>
            </button>
          )}
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}
            data-testid="sc-board"
          >
            {cards.map(({ task, state }) => (
              <RoutineCard
                key={task.id}
                task={task}
                runs={runs[task.id]}
                state={state}
                now={now}
                onOpen={() => setOpenId(task.id)}
              />
            ))}
            {/* Nothing scheduled yet: the templates ARE the board — the same
                cards you will have, drawn dashed until you make them. */}
            {boardIsEmpty
              ? TASK_TEMPLATES.map((t) => (
                  <TemplateCard key={t.id} id={t.id} onPick={() => setDraft(templateDraft(t))} />
                ))
              : null}
          </div>
          {loaded && cards.length === 0 && tasks.length > 0 ? (
            <p className="mt-4 text-footnote text-text-muted">Nothing matches.</p>
          ) : null}

          {!boardIsEmpty ? (
            <>
              <SectionTitle className="mt-8">Start from</SectionTitle>
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}
                data-testid="sc-suggestions"
              >
                {TASK_TEMPLATES.map((t) => (
                  <TemplateCard key={t.id} id={t.id} onPick={() => setDraft(templateDraft(t))} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </ScrollArea>

      {open !== null ? (
        <Sheet
          task={open}
          runs={runs[open.id]}
          state={taskState(open, runs[open.id], now, enabled)}
          now={now}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
