/**
 * The one editor all candidates share, placed differently by each.
 *
 * Two things the reference dialogs get wrong and this does not:
 *
 *   - The frequency select is followed by exactly the controls that frequency
 *     needs (the shipping TaskDialog already does this; kept).
 *   - It says what will happen when you save. "Every day at 7:30 AM" is the
 *     schedule; "Today's 7:30 already passed, so it runs as soon as you save"
 *     is the consequence — and it IS what the scheduler does (dueTasks catches
 *     up a slot missed within six hours), so a person should hear it before
 *     the run starts, not after. If no model is loaded, that is said here too,
 *     because it is the slow part of the first run.
 *
 * No permissions row: an unattended run has nobody to ask, so the rule is
 * fixed and stated instead — it reads, it cannot send. No Active switch
 * either: round one kept the shipping dialog's, and nobody creates a task
 * paused; pausing lives on the task once it exists.
 */
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TextArea,
} from '@pi-desktop/ui';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  describeSchedule,
  type Frequency,
  formatTime,
  nextRun,
  normalizeTask,
  previousRun,
  type ScheduledTask,
} from '../../../electron/scheduled/schedule-logic';
import type { TaskDraft } from '../../../electron/scheduled/scheduled-contract';
import { useLlmStore } from '../../state/llm-store';
import { useProjectStore } from '../../state/project-store';
import { describeDelta, describeMoment, GRACE_MS, nameFrom } from './derive';
import { useModelNote } from './shared';

const FREQUENCY_LABEL: Record<Frequency, string> = {
  manual: 'Only when I run it',
  hourly: 'Every hour',
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
};
const FREQUENCIES: readonly Frequency[] = ['manual', 'hourly', 'daily', 'weekdays', 'weekly'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MINUTES = [0, 5, 10, 15, 20, 30, 40, 45, 50];
const OWN_FOLDER = '__own__';

export interface TaskEditorProps {
  readonly initial?: Partial<ScheduledTask>;
  readonly editingId?: string;
  readonly onCancel: () => void;
  readonly onSave: (draft: TaskDraft) => void;
  /** `pane`: fills a detail pane. `card`: sits inside a card in a grid/list. */
  readonly layout?: 'pane' | 'card';
  readonly autoFocus?: 'name' | 'prompt';
  /** A line above the fields, for when the editor is a confirmation of a parse. */
  readonly lead?: string;
}

export function TaskEditor({
  initial,
  editingId,
  onCancel,
  onSave,
  layout = 'pane',
  autoFocus = 'prompt',
  lead,
}: TaskEditorProps) {
  const base = useMemo(() => normalizeTask({ id: 'draft', ...initial }), [initial]);
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(base.prompt);
  const [frequency, setFrequency] = useState<Frequency>(base.frequency);
  const [hour, setHour] = useState(base.hour);
  const [minute, setMinute] = useState(base.minute);
  const [weekday, setWeekday] = useState(base.weekday);
  const [cwd, setCwd] = useState(base.cwd ?? '');
  const enabled = initial?.enabled ?? true;
  const projects = useProjectStore((s) => s.projects);
  const modelNote = useModelNote();
  const loadedModel = useLlmStore((s) =>
    s.status.phase === 'ready' ? (s.status.model?.displayName ?? null) : null,
  );
  const nameId = useId();
  const promptId = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Focus by effect rather than the attribute: an inline editor that opens
  // where you clicked should take the caret, and this is the one place it does.
  useEffect(() => {
    (autoFocus === 'name' ? nameRef.current : promptRef.current)?.focus();
  }, [autoFocus]);

  const now = Date.now();
  const draftTask = normalizeTask({
    id: 'preview',
    frequency,
    hour,
    minute,
    weekday,
    enabled: true,
    lastRunAt: initial?.lastRunAt,
    createdAt: initial?.createdAt ?? now,
  });
  const schedule = describeSchedule(draftTask);
  const next = enabled ? nextRun(draftTask, now, true) : undefined;
  const slot = frequency === 'manual' ? undefined : previousRun(draftTask, now);
  const catchesUp =
    enabled &&
    slot !== undefined &&
    now - slot <= GRACE_MS &&
    (draftTask.lastRunAt ?? 0) < slot &&
    frequency !== 'hourly';

  const canSave = prompt.trim().length > 0;
  const save = () => {
    if (!canSave) return;
    onSave({
      // derive's nameFrom: a short first clause kept whole, a long one cut at a
      // conjunction or backed off a dangling word. Round one sliced at 40
      // characters ("Summarise what changed in my working"); round two took
      // schedule-logic's six words ("Write up what I worked on").
      name: name.trim() || nameFrom(prompt.trim()),
      prompt: prompt.trim(),
      frequency,
      hour,
      minute,
      weekday,
      enabled,
      ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
    });
  };
  /** Escape cancels, ⌘↩ saves — on the fields, where the keys are pressed. */
  const onFieldKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  };
  const minuteOptions = MINUTES.includes(minute)
    ? MINUTES
    : [...MINUTES, minute].sort((a, b) => a - b);
  const folderLabel =
    cwd === '' ? 'A folder of its own' : (projects.find((p) => p.path === cwd)?.name ?? cwd);

  return (
    <div
      className={layout === 'pane' ? 'flex flex-col gap-4' : 'flex flex-col gap-3'}
      data-testid="sc-editor"
    >
      {lead !== undefined ? <p className="text-footnote text-text-muted">{lead}</p> : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={promptId} className="sc-field-label">
          What should it do?
        </label>
        <TextArea
          ref={promptRef}
          id={promptId}
          data-testid="sc-editor-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onFieldKey}
          autoGrow
          rows={4}
          placeholder="Run the test suite and tell me only what failed."
          style={{ minHeight: layout === 'pane' ? 120 : 88 }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="sc-field-label">
          Name
        </label>
        <Input
          ref={nameRef}
          id={nameId}
          data-testid="sc-editor-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onFieldKey}
          placeholder={
            prompt.trim() === ''
              ? 'Named from the first line if you leave this blank'
              : nameFrom(prompt)
          }
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <span className="sc-field-label">When</span>
          <div className="flex flex-wrap items-center gap-2" data-testid="sc-editor-when">
            <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
              <SelectTrigger className="pd-btn--sm" data-testid="sc-editor-frequency">
                {FREQUENCY_LABEL[frequency]}
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {frequency === 'weekly' ? (
              <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                <SelectTrigger className="pd-btn--sm" data-testid="sc-editor-weekday">
                  {DAYS[weekday]}
                </SelectTrigger>
                <SelectContent>
                  {DAYS.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {frequency !== 'manual' && frequency !== 'hourly' ? (
              <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                <SelectTrigger className="pd-btn--sm" data-testid="sc-editor-hour">
                  {formatTime(hour, 0).replace(':00', '')}
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={`h${h}`} value={String(h)}>
                      {formatTime(h, 0).replace(':00', '')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {frequency !== 'manual' ? (
              <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
                <SelectTrigger className="pd-btn--sm" data-testid="sc-editor-minute">
                  {frequency === 'hourly' ? 'at ' : ''}:{String(minute).padStart(2, '0')}
                </SelectTrigger>
                <SelectContent>
                  {minuteOptions.map((m) => (
                    <SelectItem key={`m${m}`} value={String(m)}>
                      {frequency === 'hourly' ? 'at ' : ''}:{String(m).padStart(2, '0')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="sc-field-label">Where it works</span>
          <Select
            value={cwd === '' ? OWN_FOLDER : cwd}
            onValueChange={(v) => setCwd(v === OWN_FOLDER ? '' : v)}
          >
            <SelectTrigger className="pd-btn--sm" data-testid="sc-editor-folder">
              {folderLabel}
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value={OWN_FOLDER}
                description="Whatever it writes lands in a folder kept per run"
              >
                A folder of its own
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.path} description={p.path}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* The consequence, in words, before the button. */}
      <div className="sc-preview" data-testid="sc-editor-preview">
        <span>
          <strong>{schedule}</strong>
        </span>
        {!enabled ? (
          <span>· saved paused</span>
        ) : catchesUp && slot !== undefined ? (
          <span>
            · {describeMoment(slot, now)} already passed, so it runs{' '}
            <strong>as soon as you save</strong>
          </span>
        ) : next !== undefined ? (
          <span>
            · first run <strong>{describeMoment(next, now)}</strong> ({describeDelta(next, now)})
          </span>
        ) : frequency === 'manual' ? (
          <span>· nothing fires on its own</span>
        ) : null}
        {modelNote !== null && enabled ? (
          <span>· {modelNote}</span>
        ) : loadedModel !== null && enabled ? (
          <span>· runs on {loadedModel}</span>
        ) : null}
        <span>· reads your Mac, never sends</span>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="sc-editor-cancel">
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canSave}
          onClick={save}
          data-testid="sc-editor-save"
        >
          {editingId === undefined ? 'Schedule it' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
