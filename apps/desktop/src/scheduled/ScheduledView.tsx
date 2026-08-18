/**
 * SCHEDULED TASKS — the surface.
 *
 * Three ways in, in the order people reach for them:
 *
 *   1. TYPE IT. "every weekday at 9am summarise what changed" — parsed locally
 *      (schedule-logic's parseTaskDraft) into a prefilled dialog you confirm.
 *      the user asked for "somewhere here that just lets you prompt directly for a
 *      scheduled task"; parsing it offline and showing the result beats sending
 *      it to a model, because it answers instantly and identically every time,
 *      and the confirm step means a misread never silently becomes a task.
 *   2. A TEMPLATE, when the list is empty and you want to see what this is for.
 *   3. THE FULL DIALOG, for anything precise.
 *
 * And the model can create them mid-chat with `create_scheduled_task`, which
 * lands in the same list — see packages/harness/src/scheduled.
 *
 * The whole feature has one switch at the top. It stops tasks FIRING; it does
 * not delete or disable them individually, so flipping it back restores exactly
 * what you had.
 */
import { Spinner } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import {
  describeNextRun,
  describeSchedule,
  nextRun,
  parseTaskDraft,
} from '../../electron/scheduled/schedule-logic';
import type { ScheduledTask, TaskDraft } from '../../electron/scheduled/scheduled-contract';
import { cx } from '../onboarding/cx';
import { TaskDialog } from './TaskDialog';
import { TaskRuns } from './TaskRuns';
import { isRunning, useTasksStore } from './tasks-store';
import { TASK_TEMPLATES } from './templates';

function RowMenuButton({
  label,
  onClick,
  testid,
  tone = 'default',
}: {
  label: string;
  onClick: () => void;
  testid: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={cx(
        'pd-focusable rounded-lg px-2.5 py-1 text-footnote transition-colors hover:bg-bg-hover',
        tone === 'danger' ? 'text-status-danger-fg' : 'text-text-secondary hover:text-text-primary',
      )}
    >
      {label}
    </button>
  );
}

export function ScheduledView() {
  const { enabled, tasks, loaded, runs } = useTasksStore();
  const load = useTasksStore((s) => s.load);
  const setEnabled = useTasksStore((s) => s.setEnabled);
  const createTask = useTasksStore((s) => s.create);
  const updateTask = useTasksStore((s) => s.update);
  const removeTask = useTasksStore((s) => s.remove);
  const runNow = useTasksStore((s) => s.runNow);

  const [draft, setDraft] = useState<Partial<ScheduledTask> | null>(null);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [quick, setQuick] = useState('');
  const [viewingRuns, setViewingRuns] = useState<string | null>(null);
  /** Re-render once a minute so "in 4h" stays true without a per-row timer. */
  const [now, setNow] = useState(() => Date.now());

  const loadRuns = useTasksStore((s) => s.loadRuns);
  useEffect(() => {
    void load();
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [load]);
  // Once tasks are known, fetch each one's history so a row can show "Running…"
  // and so opening Past runs is instant. Cheap: a few small JSON reads.
  useEffect(() => {
    for (const t of tasks) void loadRuns(t.id);
  }, [tasks, loadRuns]);

  const rows = useMemo(
    () =>
      [...tasks]
        .map((t) => ({ task: t, next: nextRun(t, now, enabled) }))
        .sort(
          (a, b) => (a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY),
        ),
    [tasks, now, enabled],
  );

  const openQuick = () => {
    const text = quick.trim();
    if (text.length === 0) return;
    // Parsed, then SHOWN — the dialog is a draft to confirm, not an action taken.
    setDraft(parseTaskDraft(text));
    setEditingId(undefined);
    setQuick('');
  };

  const save = (d: TaskDraft) => {
    if (editingId === undefined) void createTask(d);
    else void updateTask(editingId, d);
    setDraft(null);
    setEditingId(undefined);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg-base" data-testid="scheduled-view">
      <div className="mx-auto w-full max-w-[900px] px-6 pt-6 pb-16">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-heading text-text-primary">Scheduled tasks</h1>
            <p className="mt-1 text-body text-text-secondary">
              Work Bobble does on its own — on a schedule, or whenever you run it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/*
             * THE FEATURE SWITCH. Deliberately here rather than buried in
             * settings: this is where you are when you decide you want it quiet,
             * and a switch you cannot find is one you do not trust.
             */}
            <button
              type="button"
              data-testid="tasks-enabled"
              role="switch"
              aria-checked={enabled}
              onClick={() => void setEnabled(!enabled)}
              className={cx(
                'pd-focusable flex items-center gap-2 rounded-full border px-3 py-1.5 text-footnote transition-colors',
                enabled
                  ? 'border-border-default bg-bg-raised text-text-primary'
                  : 'border-border-default bg-bg-inset text-text-muted',
              )}
            >
              <span
                className={cx(
                  'h-2 w-2 rounded-full',
                  enabled ? 'bg-status-success-fg' : 'bg-border-strong',
                )}
              />
              {enabled ? 'Scheduling on' : 'Scheduling off'}
            </button>
            <button
              type="button"
              data-testid="tasks-new"
              onClick={() => {
                setDraft({});
                setEditingId(undefined);
              }}
              className="pd-focusable rounded-lg bg-accent-primary px-3.5 py-1.5 text-footnote text-text-on-accent transition-opacity hover:opacity-90"
            >
              New task
            </button>
          </div>
        </header>

        {!enabled ? (
          <p
            className="mt-4 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-secondary"
            data-testid="tasks-off-note"
          >
            Scheduling is off — nothing will run on its own. Your tasks are kept, and you can still
            run any of them by hand.
          </p>
        ) : null}

        {/* 1. Type it. */}
        <div className="mt-5 flex gap-2" data-testid="tasks-quick">
          <input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openQuick();
            }}
            data-testid="tasks-quick-input"
            placeholder="every weekday at 9am, summarise what changed in my working folder"
            className="pd-focusable min-w-0 flex-1 rounded-xl border border-border-default bg-bg-inset px-3.5 py-2.5 text-body text-text-primary placeholder:text-text-muted"
          />
          <button
            type="button"
            data-testid="tasks-quick-go"
            onClick={openQuick}
            disabled={quick.trim().length === 0}
            className={cx(
              'pd-focusable shrink-0 rounded-xl px-4 text-footnote transition-opacity',
              quick.trim().length > 0
                ? 'bg-bg-active text-text-primary hover:opacity-90'
                : 'cursor-default bg-bg-inset text-text-muted',
            )}
          >
            Draft it
          </button>
        </div>

        {/* The list. */}
        {!loaded ? (
          <div className="mt-10 flex justify-center text-accent-primary">
            <Spinner size={18} />
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-8" data-testid="tasks-empty">
            <p className="text-footnote text-text-muted">
              Nothing scheduled yet. Start from one of these, or write your own above.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {TASK_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`tasks-template-${t.id}`}
                  onClick={() => {
                    setDraft({
                      name: t.name,
                      prompt: t.prompt,
                      frequency: t.frequency,
                      hour: t.hour,
                      minute: t.minute,
                      weekday: t.weekday,
                      enabled: true,
                    });
                    setEditingId(undefined);
                  }}
                  className="pd-focusable flex flex-col gap-1 rounded-xl border border-border-subtle bg-bg-raised p-3.5 text-left transition-colors hover:bg-bg-hover"
                >
                  <span className="flex items-center gap-2 text-body text-text-primary">
                    <span className="text-text-muted">{t.icon}</span>
                    {t.name}
                  </span>
                  <span className="text-footnote text-text-secondary">{t.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            className="mt-5 overflow-hidden rounded-2xl border border-border-subtle bg-bg-raised"
            data-testid="tasks-list"
          >
            {rows.map(({ task, next }) => (
              <div
                key={task.id}
                data-testid={`task-row-${task.id}`}
                className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0"
              >
                <button
                  type="button"
                  aria-label={task.enabled ? 'Pause this task' : 'Resume this task'}
                  aria-pressed={task.enabled}
                  data-testid={`task-toggle-${task.id}`}
                  onClick={() => void updateTask(task.id, { enabled: !task.enabled })}
                  className={cx(
                    'pd-focusable h-2.5 w-2.5 shrink-0 rounded-full transition-colors',
                    task.enabled && enabled ? 'bg-status-success-fg' : 'bg-border-strong',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cx(
                      'truncate text-body',
                      task.enabled ? 'text-text-primary' : 'text-text-muted',
                    )}
                  >
                    {task.name}
                  </p>
                  <p className="truncate text-footnote text-text-muted">
                    {describeSchedule(task)}
                    {task.lastRunAt !== undefined
                      ? ` · last ran ${new Date(task.lastRunAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
                <span
                  className="shrink-0 text-footnote text-text-muted tabular-nums"
                  data-testid={`task-next-${task.id}`}
                >
                  {task.enabled ? describeNextRun(next, now) : 'paused'}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  <RowMenuButton
                    label={isRunning(runs[task.id]) ? 'Running…' : 'Run now'}
                    testid={`task-run-${task.id}`}
                    onClick={() => void runNow(task.id)}
                  />
                  <RowMenuButton
                    label="Past runs"
                    testid={`task-runs-${task.id}`}
                    onClick={() => setViewingRuns(task.id)}
                  />
                  <RowMenuButton
                    label="Edit"
                    testid={`task-edit-${task.id}`}
                    onClick={() => {
                      setDraft(task);
                      setEditingId(task.id);
                    }}
                  />
                  <RowMenuButton
                    label="Delete"
                    tone="danger"
                    testid={`task-delete-${task.id}`}
                    onClick={() => void removeTask(task.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {viewingRuns !== null
        ? (() => {
            const t = tasks.find((x) => x.id === viewingRuns);
            return t === undefined ? null : (
              <TaskRuns task={t} onClose={() => setViewingRuns(null)} />
            );
          })()
        : null}

      {draft !== null ? (
        <TaskDialog
          initial={draft}
          editingId={editingId}
          onCancel={() => {
            setDraft(null);
            setEditingId(undefined);
          }}
          onSave={save}
        />
      ) : null}
    </div>
  );
}
