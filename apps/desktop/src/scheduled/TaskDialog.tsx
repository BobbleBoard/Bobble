/**
 * Create / edit a scheduled task.
 *
 * Adapted from the reference modal, with three deliberate differences:
 *
 *   - The frequency dropdown is followed by the CONTROLS THAT FREQUENCY NEEDS
 *     and no others: a time for daily/weekdays/weekly, a day for weekly, only a
 *     minute for hourly, nothing for manual. The reference shows a frequency
 *     select and leaves you to discover the rest; a schedule you cannot fully
 *     state in the dialog is a schedule you will get wrong.
 *   - "Work in a project or folder" becomes our real working-folder picker,
 *     because in this app that choice decides what the agent can see and write.
 *   - An explicit ENABLED switch, so a task can be parked without deleting it.
 */
import { IconCheck, IconChevronDown } from '@pi-desktop/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  describeSchedule,
  formatTime,
  normalizeTask,
} from '../../electron/scheduled/schedule-logic';
import type {
  Frequency,
  ScheduledTask,
  TaskDraft,
} from '../../electron/scheduled/scheduled-contract';
import { useOutsideClose } from '../models/use-outside-close';
import { cx } from '../onboarding/cx';
import { useProjectStore } from '../state/project-store';

const FREQUENCY_LABEL: Record<Frequency, string> = {
  manual: 'Only when I run it',
  hourly: 'Every hour',
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A small shared-surface dropdown, so it matches every other menu in the app. */
function Picker<T extends string | number>({
  value,
  options,
  onChange,
  testid,
  width = 'min-w-[150px]',
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  testid: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(open, ref, () => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid={testid}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'pd-focusable flex items-center justify-between gap-2 rounded-lg border border-border-default bg-bg-inset px-3 py-1.5 text-footnote text-text-primary transition-colors hover:bg-bg-hover',
          width,
        )}
      >
        <span className="truncate">{current?.label ?? String(value)}</span>
        <IconChevronDown size={13} className="shrink-0 text-text-muted" />
      </button>
      {open ? (
        <div
          data-testid={`${testid}-menu`}
          className="pd-menu absolute top-full left-0 z-30 mt-1 max-h-[260px] min-w-full"
        >
          {options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              data-testid={`${testid}-opt-${o.value}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cx('pd-menu-item', o.value === value && 'bg-bg-hover font-medium')}
            >
              <span className="flex-1">{o.label}</span>
              {o.value === value ? <IconCheck size={13} className="text-text-muted" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TaskDialogProps {
  /** An existing task to edit, or a partial draft to prefill a new one. */
  readonly initial?: Partial<ScheduledTask>;
  readonly editingId?: string;
  readonly onCancel: () => void;
  readonly onSave: (draft: TaskDraft) => void;
}

export function TaskDialog({ initial, editingId, onCancel, onSave }: TaskDialogProps) {
  const base = useMemo(() => normalizeTask({ id: 'draft', ...initial }), [initial]);
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(base.prompt);
  const [frequency, setFrequency] = useState<Frequency>(base.frequency);
  const [hour, setHour] = useState(base.hour);
  const [minute, setMinute] = useState(base.minute);
  const [weekday, setWeekday] = useState(base.weekday);
  const [enabled, setEnabled] = useState(base.enabled);
  const [cwd, setCwd] = useState(base.cwd ?? '');
  const projects = useProjectStore((s) => s.projects);
  const nameId = useId();
  const promptId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const preview = describeSchedule(
    normalizeTask({ id: 'p', frequency, hour, minute, weekday, enabled: true }),
  );
  const canSave = prompt.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    onSave({
      name:
        name.trim() ||
        prompt
          .trim()
          .split(/[.,\n]/)[0]
          ?.slice(0, 40) ||
        'Scheduled task',
      prompt: prompt.trim(),
      frequency,
      hour,
      minute,
      weekday,
      enabled,
      ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      data-testid="task-dialog"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-[var(--pd-bg-backdrop)]"
        onClick={onCancel}
      />
      <div className="relative flex w-[min(620px,100%)] flex-col gap-4 rounded-2xl border border-border-subtle bg-bg-raised p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between">
          <h2 className="text-title text-text-primary">
            {editingId === undefined ? 'New scheduled task' : 'Edit task'}
          </h2>
          <button
            type="button"
            aria-label="Close"
            data-testid="task-dialog-close"
            onClick={onCancel}
            className="pd-focusable rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-footnote text-text-secondary">
            Name
          </label>
          <input
            id={nameId}
            data-testid="task-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Named from the instruction if you leave this blank"
            className="pd-focusable rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-body text-text-primary placeholder:text-text-muted"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={promptId} className="text-footnote text-text-secondary">
            What should it do?
          </label>
          <textarea
            id={promptId}
            data-testid="task-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Run the test suite and tell me only what failed."
            className="pd-focusable resize-none rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-body text-text-primary placeholder:text-text-muted"
          />
          <p className="text-caption text-text-muted">
            This runs as a normal chat, with your tools and your working folder — so it can read,
            write and run things.
          </p>
        </div>

        {/* WHEN. Only the controls this frequency actually needs. */}
        <div className="flex flex-wrap items-center gap-2" data-testid="task-when">
          <Picker
            testid="task-frequency"
            value={frequency}
            onChange={setFrequency}
            options={(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => ({
              value: f,
              label: FREQUENCY_LABEL[f],
            }))}
            width="min-w-[170px]"
          />
          {frequency === 'weekly' ? (
            <Picker
              testid="task-weekday"
              value={weekday}
              onChange={setWeekday}
              options={DAYS.map((d, i) => ({ value: i, label: d }))}
            />
          ) : null}
          {frequency !== 'manual' && frequency !== 'hourly' ? (
            <Picker
              testid="task-hour"
              value={hour}
              onChange={setHour}
              options={Array.from({ length: 24 }, (_, h) => ({
                value: h,
                label: formatTime(h, 0).replace(':00', ''),
              }))}
              width="min-w-[110px]"
            />
          ) : null}
          {frequency !== 'manual' ? (
            <Picker
              testid="task-minute"
              value={minute}
              onChange={setMinute}
              options={[0, 5, 10, 15, 20, 30, 40, 45, 50].map((m) => ({
                value: m,
                label: `:${String(m).padStart(2, '0')}`,
              }))}
              width="min-w-[86px]"
            />
          ) : null}
          <span className="ml-auto text-footnote text-text-muted" data-testid="task-when-preview">
            {preview}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Picker
            testid="task-folder"
            value={cwd}
            onChange={setCwd}
            options={[
              { value: '', label: 'Default folder' },
              ...projects.map((p) => ({ value: p.path, label: p.name })),
            ]}
            width="min-w-[200px]"
          />
          <button
            type="button"
            data-testid="task-enabled"
            aria-pressed={enabled}
            onClick={() => setEnabled(!enabled)}
            className={cx(
              'pd-focusable flex items-center gap-2 rounded-lg border px-3 py-1.5 text-footnote transition-colors',
              enabled
                ? 'border-accent-primary/40 bg-accent-primary/10 text-text-primary'
                : 'border-border-default bg-bg-inset text-text-muted hover:bg-bg-hover',
            )}
          >
            <span
              className={cx(
                'h-2 w-2 rounded-full',
                enabled ? 'bg-status-success-fg' : 'bg-border-strong',
              )}
            />
            {enabled ? 'Active' : 'Paused'}
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            data-testid="task-cancel"
            onClick={onCancel}
            className="pd-focusable rounded-lg px-3 py-1.5 text-footnote text-text-secondary hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="task-save"
            disabled={!canSave}
            onClick={save}
            className={cx(
              'pd-focusable rounded-lg px-4 py-1.5 text-footnote transition-opacity',
              canSave
                ? 'bg-accent-primary text-text-on-accent hover:opacity-90'
                : 'cursor-default bg-bg-active text-text-muted',
            )}
          >
            {editingId === undefined ? 'Create task' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
