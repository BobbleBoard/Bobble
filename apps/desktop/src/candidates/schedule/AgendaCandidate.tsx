/**
 * CANDIDATE 2 — THE AGENDA.
 *
 * The argument: a schedule is a question about TIME ON THIS MAC. What runs
 * next, what is due right now, what was missed while the laptop was shut —
 * and whether the machine can even run it (Bobble open, a model loaded, one
 * run at a time). So the page is one column, grouped the way a calendar app
 * groups a day: Now / Today / Tomorrow / This week / Later / By hand / Paused,
 * with the exact time on the left of every row and a seven-day strip showing
 * which days it fires.
 *
 * Creation is the ChatGPT-style sentence, but the parse is shown LIVE under
 * the composer as you type — "Weekdays at 9:00 AM · first run tomorrow" — so
 * the deterministic parser is a preview, not a surprise, and the confirm step
 * is an inline card rather than a modal.
 */
import {
  Button,
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTrash,
  ScrollArea,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeSchedule,
  formatTime,
  nextRun,
  normalizeTask,
  parseTaskDraft,
  type ScheduledTask,
} from '../../../electron/scheduled/schedule-logic';
import type { TaskDraft, TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { cx } from '../../onboarding/cx';
import {
  type AgendaBucket,
  agendaBucket,
  BUCKET_TITLE,
  describeDelta,
  describeDuration,
  describeMoment,
  type TaskState,
  taskState,
} from './derive';
import { registerCandidateStates } from './hook';
import { IconPause, IconPlay, IconRepeat, IconTimer } from './icons';
import { RunLedger } from './RunLedger';
import {
  MachineStrip,
  OutcomeGlyph,
  ReachRow,
  SchedulingSwitch,
  StatusGlyph,
  TASK_TEMPLATES,
  TemplateIcon,
  taskActions,
  templateDraft,
  useContainerWidth,
  useNow,
  useSchedule,
  WeekStrip,
} from './shared';
import { TaskEditor } from './TaskEditor';

const BUCKET_ORDER: readonly AgendaBucket[] = [
  'now',
  'today',
  'tomorrow',
  'week',
  'later',
  'manual',
  'paused',
];

const SAMPLE_SENTENCE = 'every weekday at 9am, summarise what changed in my working folder';

function timeCell(
  state: TaskState,
  task: ScheduledTask,
  now: number,
): { main: string; sub: string } {
  const clock =
    task.frequency === 'hourly'
      ? `:${String(task.minute).padStart(2, '0')}`
      : formatTime(task.hour, task.minute);
  switch (state.kind) {
    case 'running':
      return { main: clock, sub: describeDuration(state.run, now) };
    case 'due':
      return { main: clock, sub: 'due now' };
    case 'missed':
      return { main: clock, sub: describeDelta(state.nextAt, now) };
    case 'scheduled':
      return { main: clock, sub: describeDelta(state.nextAt, now) };
    case 'manual':
      return { main: '—', sub: 'by hand' };
    case 'paused':
      return { main: clock, sub: 'paused' };
    case 'off':
      return { main: clock, sub: 'off' };
  }
}

function LiveParse({ text, now }: { text: string; now: number }) {
  const parsed = useMemo(() => parseTaskDraft(text), [text]);
  const task = normalizeTask({ id: 'p', ...parsed, enabled: true, createdAt: now });
  const next = nextRun(task, now, true);
  return (
    <div className="sc-parse" data-testid="sc-parse">
      <span className="sc-chip">
        <IconRepeat size={12} />
        {describeSchedule(task)}
      </span>
      {next !== undefined ? (
        <span className="sc-chip">
          <IconTimer size={12} />
          first run {describeMoment(next, now)}
        </span>
      ) : null}
      <span className="min-w-0 truncate">“{parsed.prompt}”</span>
      <span className="ml-auto text-caption">↵ to review</span>
    </div>
  );
}

function AgendaRow({
  task,
  runs,
  state,
  now,
  narrow,
  expanded,
  editing,
  onToggle,
  onEdit,
  onSaved,
  onCancelEdit,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  narrow: boolean;
  expanded: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onSaved: (draft: TaskDraft) => void;
  onCancelEdit: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const last = runs?.[0];
  const { main, sub } = timeCell(state, task, now);
  const muted = state.kind === 'paused' || state.kind === 'off';
  const meta =
    state.kind === 'missed'
      ? `missed ${describeMoment(state.slotAt, now)} — Bobble was not open`
      : last === undefined
        ? 'not run yet'
        : last.status === 'running'
          ? `started ${describeDelta(last.startedAt, now)}`
          : `last ${last.status === 'ok' ? 'ok' : 'failed'} ${describeDelta(last.startedAt, now)}`;
  return (
    <div data-testid={`sc-agenda-row-${task.id}`}>
      <div className="sc-row" data-selected={expanded} data-muted={muted}>
        <button type="button" className="sc-row-hit" onClick={onToggle} aria-expanded={expanded}>
          <span className="sc-agenda-time">
            <span className="sc-agenda-time-main block">{main}</span>
            <span className="sc-agenda-time-sub block">{sub}</span>
          </span>
          <StatusGlyph state={state} runs={runs} />
          <span className="min-w-0 flex-1">
            <span className="sc-row-name block">{task.name}</span>
            <span
              className="sc-row-meta block"
              style={state.kind === 'missed' ? { color: 'var(--pd-status-warning-fg)' } : undefined}
            >
              {describeSchedule(task)} · {meta}
            </span>
          </span>
          {!narrow ? <WeekStrip task={task} now={now} /> : null}
        </button>
        <span className="sc-row-trailing inline-flex w-5 justify-center">
          {last !== undefined ? (
            <OutcomeGlyph run={last} />
          ) : (
            <IconChevronRight size={14} style={{ color: 'var(--pd-text-muted)' }} />
          )}
        </span>
        <span className="sc-row-actions">
          {armed ? (
            <span className="inline-flex items-center gap-1 text-caption text-text-muted">
              and its runs?
              <button
                type="button"
                className="pd-btn pd-btn--danger pd-btn--sm"
                onClick={() => void taskActions().remove(task.id)}
                data-testid="sc-delete-confirm"
              >
                Delete
              </button>
              <button
                type="button"
                className="pd-btn pd-btn--ghost pd-btn--sm"
                onClick={() => setArmed(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="sc-icon-btn"
                title={state.kind === 'running' ? 'Running' : 'Run now'}
                disabled={state.kind === 'running'}
                onClick={() => void taskActions().runNow(task.id)}
                data-testid="sc-run-now"
              >
                <IconPlay size={14} />
              </button>
              <button
                type="button"
                className="sc-icon-btn"
                title={task.enabled ? 'Pause' : 'Resume'}
                onClick={() => void taskActions().update(task.id, { enabled: !task.enabled })}
              >
                {task.enabled ? <IconPause size={14} /> : <IconPlay size={14} />}
              </button>
              <button
                type="button"
                className="sc-icon-btn"
                title="Edit"
                onClick={onEdit}
                data-testid="sc-edit"
              >
                <IconPencil size={14} />
              </button>
              <button
                type="button"
                className="sc-icon-btn"
                data-tone="danger"
                title="Delete"
                onClick={() => setArmed(true)}
                data-testid="sc-delete"
              >
                <IconTrash size={14} />
              </button>
            </>
          )}
        </span>
      </div>
      {expanded ? (
        <div className="sc-agenda-expand" data-testid="sc-agenda-expand">
          {editing ? (
            <TaskEditor
              initial={task}
              editingId={task.id}
              onCancel={onCancelEdit}
              onSave={onSaved}
              layout="card"
            />
          ) : (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ReachRow task={task} runs={runs} />
                <button
                  type="button"
                  className="text-caption text-text-muted hover:text-text-primary pd-focusable"
                  onClick={onEdit}
                >
                  Edit the prompt
                </button>
              </div>
              <p
                className="sc-clamp-3 mt-3 text-footnote text-text-secondary"
                style={{ whiteSpace: 'pre-wrap' }}
              >
                {task.prompt}
              </p>
              <div className="mt-3">
                <RunLedger
                  key={task.id}
                  taskId={task.id}
                  runs={runs ?? []}
                  now={now}
                  open="first"
                  limit={3}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AgendaCandidate() {
  const { enabled, tasks, runs, loaded } = useSchedule();
  const now = useNow();
  const [rootRef, width] = useContainerWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 700;
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Partial<ScheduledTask> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const groups = useMemo(() => {
    const by = new Map<
      AgendaBucket,
      Array<{ task: ScheduledTask; state: TaskState; at: number }>
    >();
    for (const task of tasks) {
      const state = taskState(task, runs[task.id], now, enabled);
      const bucket = agendaBucket(state, now);
      const at =
        state.kind === 'scheduled' || state.kind === 'missed'
          ? state.nextAt
          : state.kind === 'due'
            ? state.slotAt
            : Number.POSITIVE_INFINITY;
      const list = by.get(bucket) ?? [];
      list.push({ task, state, at });
      by.set(bucket, list);
    }
    return BUCKET_ORDER.filter((b) => by.has(b)).map((b) => ({
      bucket: b,
      items: (by.get(b) ?? []).sort(
        (x, y) => x.at - y.at || x.task.name.localeCompare(y.task.name),
      ),
    }));
  }, [tasks, runs, now, enabled]);

  const latest = useRef({ tasks, runs });
  latest.current = { tasks, runs };
  useEffect(
    () =>
      registerCandidateStates('agenda', ['default', 'typing', 'expanded', 'editor'], (s) => {
        const { tasks: ts, runs: rs } = latest.current;
        setText(s === 'typing' ? SAMPLE_SENTENCE : '');
        setDraft(s === 'editor' ? parseTaskDraft(SAMPLE_SENTENCE) : null);
        setEditingId(null);
        // Expand the task with the most history — the one that shows the ledger.
        const richest = [...ts].sort(
          (a, b) => (rs[b.id]?.length ?? 0) - (rs[a.id]?.length ?? 0),
        )[0];
        setExpandedId(s === 'expanded' ? (richest?.id ?? null) : null);
      }),
    [],
  );

  const review = () => {
    const t = text.trim();
    if (t.length === 0) return;
    setDraft(parseTaskDraft(t));
    setText('');
  };

  const create = (d: TaskDraft) => {
    void taskActions().create(d);
    setDraft(null);
  };

  return (
    <div ref={rootRef} className={cx('sc-page', narrow && 'sc-narrow')} data-testid="sc-agenda">
      {/* The header shares the column with the content, so the title and the list share a left edge. */}
      <header className="mx-auto flex w-full max-w-[880px] flex-wrap items-start justify-between gap-3 px-6 pt-4 pb-2">
        <div>
          <h1 className="sc-title">Scheduled</h1>
          <p className="sc-subtitle">When things run on this Mac — and whether they can.</p>
        </div>
        <div className="flex items-center gap-3">
          <SchedulingSwitch enabled={enabled} />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setDraft({});
              setText('');
            }}
            data-testid="sc-new"
          >
            <IconPlus size={14} /> New task
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[880px] px-6 pt-2 pb-16">
          <MachineStrip tasks={tasks} runs={runs} now={now} enabled={enabled} compact={narrow} />

          {/* The sentence. */}
          <div className="mt-4" data-testid="sc-composer">
            <div className="sc-card flex items-center gap-2 py-1.5 pr-1.5 pl-3">
              <span style={{ color: 'var(--pd-text-muted)', display: 'inline-flex' }}>
                <IconPlus size={16} />
              </span>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') review();
                }}
                placeholder={SAMPLE_SENTENCE}
                className="min-w-0 flex-1 bg-transparent py-1.5 text-body text-text-primary outline-none placeholder:text-text-placeholder"
                data-testid="sc-composer-input"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={text.trim().length === 0}
                onClick={review}
                data-testid="sc-composer-go"
              >
                Review
              </Button>
            </div>
            {text.trim().length > 0 ? (
              <div className="mt-2">
                <LiveParse text={text} now={now} />
              </div>
            ) : null}
            {draft !== null ? (
              <div className="sc-card mt-3 p-4" data-testid="sc-agenda-editor">
                <p className="mb-3 text-footnote text-text-muted">
                  Check the schedule before it goes on the calendar.
                </p>
                <TaskEditor
                  initial={draft}
                  onCancel={() => setDraft(null)}
                  onSave={create}
                  layout="card"
                />
              </div>
            ) : null}
          </div>

          {/* The agenda. */}
          {loaded && tasks.length === 0 ? (
            <div className="mt-8" data-testid="sc-agenda-empty">
              <h3 className="sc-section-title">Start with</h3>
              <div className="sc-card py-1">
                {TASK_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="sc-row"
                    onClick={() => setDraft(templateDraft(t))}
                    data-testid={`sc-template-${t.id}`}
                  >
                    <span className="sc-agenda-time">
                      <span className="sc-agenda-time-main block">
                        {formatTime(t.hour, t.minute)}
                      </span>
                      <span className="sc-agenda-time-sub block">
                        {t.frequency === 'weekly' ? 'weekly' : t.frequency}
                      </span>
                    </span>
                    <span className="sc-tile">
                      <TemplateIcon id={t.id} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="sc-row-name block">{t.name}</span>
                      <span className="sc-row-meta block" style={{ whiteSpace: 'normal' }}>
                        {t.blurb}
                      </span>
                    </span>
                    <span style={{ color: 'var(--pd-text-muted)', display: 'inline-flex' }}>
                      <IconPlus size={16} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-6">
              {groups.map(({ bucket, items }) => (
                <section
                  key={bucket}
                  className="sc-agenda-group"
                  data-testid={`sc-bucket-${bucket}`}
                >
                  <h3 className="sc-section-title">{BUCKET_TITLE[bucket]}</h3>
                  <div className="sc-card py-1">
                    {items.map(({ task, state }) => (
                      <AgendaRow
                        key={task.id}
                        task={task}
                        runs={runs[task.id]}
                        state={state}
                        now={now}
                        narrow={narrow}
                        expanded={expandedId === task.id}
                        editing={editingId === task.id}
                        onToggle={() => {
                          setExpandedId(expandedId === task.id ? null : task.id);
                          setEditingId(null);
                        }}
                        onEdit={() => {
                          setExpandedId(task.id);
                          setEditingId(task.id);
                        }}
                        onCancelEdit={() => setEditingId(null)}
                        onSaved={(d) => {
                          void taskActions().update(task.id, d);
                          setEditingId(null);
                        }}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {tasks.length > 0 ? (
                <div className="mt-6">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-footnote text-text-muted hover:text-text-primary pd-focusable"
                    onClick={() => setTemplatesOpen((v) => !v)}
                    aria-expanded={templatesOpen}
                    data-testid="sc-agenda-more"
                  >
                    <IconChevronDown
                      size={14}
                      style={{ transform: templatesOpen ? 'rotate(180deg)' : undefined }}
                    />
                    More things Bobble can do on a clock
                  </button>
                  {templatesOpen ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {TASK_TEMPLATES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="sc-card sc-card--clickable flex items-center gap-3 p-3 text-left"
                          onClick={() => setDraft(templateDraft(t))}
                        >
                          <span className="sc-tile">
                            <TemplateIcon id={t.id} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="sc-row-name block">{t.name}</span>
                            <span className="sc-row-meta block">
                              {formatTime(t.hour, t.minute)} · {t.frequency}
                            </span>
                          </span>
                          <IconPlus size={14} style={{ color: 'var(--pd-text-muted)' }} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
