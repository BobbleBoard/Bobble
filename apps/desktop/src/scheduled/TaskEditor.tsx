/**
 * The task dialog — a new task or an edit, in a modal, the way the reference
 * screens make one (Claude's "Create scheduled task"). Used once per task,
 * so it lives behind "New task" rather than on the page at rest.
 *
 * What it does that the reference dialogs do not:
 *
 *   - The frequency select is followed by exactly the controls that frequency
 *     needs, and no others.
 *   - It says what will happen when you save. "Every day at 7:30 AM" is the
 *     schedule; "Today 7:30 AM already passed, so it runs as soon as you save"
 *     is the consequence — and it IS what the scheduler does (dueTasks catches
 *     up a slot missed within six hours), so a person should hear it before
 *     the run starts, not after. If no model is loaded, that is said here too,
 *     because it is the slow part of the first run.
 *   - A NEW task's instruction is read as you type. "every friday at 4:30pm run
 *     the full test suite" sets When to Friday 4:30 and a line under the field
 *     says so — and says what the instruction becomes without the timing
 *     words, because a model that is handed "every friday at 4:30pm…" as its
 *     brief has a scheduling tool and will use it. The parse is deterministic,
 *     offline, and never presents a default as a reading: "eve" shows nothing.
 *     It drives When only until you touch a When control yourself.
 *
 * No permissions row: an unattended run has nobody to ask, so the rule is
 * fixed and stated instead — it reads, it cannot send. No Active switch:
 * nobody creates a task paused; pausing lives on the task once it exists.
 *
 * Escape cancels and ⌘↩ saves from any field.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TextArea,
} from '@pi-desktop/ui';
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  describeSchedule,
  type Frequency,
  formatTime,
  nameFrom,
  nextRun,
  normalizeTask,
  parseTaskDraft,
  previousRun,
  type ScheduledTask,
} from '../../electron/scheduled/schedule-logic';
import type { TaskDraft } from '../../electron/scheduled/scheduled-contract';
import { useProjectStore } from '../state/project-store';
import { describeCadence, describeDelta, describeMomentIn, GRACE_MS } from './derive';
import { IconRepeat, IconTimer } from './icons';
import { useLoadedModel, useModelNote } from './shared';

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

export interface TaskDialogProps {
  readonly open: boolean;
  /** A prefilled draft (a template, or the task being edited). Absent = blank. */
  readonly initial?: Partial<ScheduledTask>;
  readonly editingId?: string;
  readonly onClose: () => void;
  readonly onSave: (draft: TaskDraft) => void;
}

export function TaskDialog({ open, initial, editingId, onClose, onSave }: TaskDialogProps) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="sd-dialog"
        aria-describedby={undefined}
        // The caret goes to the instruction — AFTER the key that opened the
        // dialog has finished. Chrome delivers an Enter's keypress to whatever
        // is focused by then, and a textarea would take it as a newline.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          setTimeout(() => promptRef.current?.focus(), 0);
        }}
      >
        <DialogHeader>
          <DialogTitle>{editingId === undefined ? 'New task' : 'Edit task'}</DialogTitle>
        </DialogHeader>
        <TaskForm
          initial={initial}
          editingId={editingId}
          onCancel={onClose}
          onSave={onSave}
          promptRef={promptRef}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the parse read from the instruction, under the field. Rendered only
 * once something WAS read — nothing is presented as a reading until it is.
 */
function ParseNote({
  parsed,
  instruction,
  now,
}: {
  parsed: ReturnType<typeof parseTaskDraft>;
  /** The instruction as it will be saved — empty when the sentence was only timing words. */
  instruction: string;
  now: number;
}) {
  const { cadence, time } = parsed.read;
  if (!cadence && !time) return null;
  const task = normalizeTask({ id: 'p', ...parsed, enabled: true, createdAt: now });
  const becomes = cadence ? (
    instruction === '' ? (
      ' — now say what it should do.'
    ) : (
      <>
        {' — the instruction becomes '}
        <strong>“{instruction}”</strong>
      </>
    )
  ) : null;
  return (
    <p className="sd-parse" data-testid="sd-parse" data-read={cadence && time ? 'all' : 'some'}>
      Read as{' '}
      <span className="sd-chip" data-testid="sd-parse-schedule">
        {cadence ? <IconRepeat size={12} /> : <IconTimer size={12} />}
        {cadence && time
          ? describeSchedule(task)
          : cadence
            ? describeCadence(parsed.frequency, parsed.weekday)
            : `at ${formatTime(parsed.hour, parsed.minute)}`}
      </span>
      <span data-testid="sd-parse-hint">
        {cadence && time ? (
          becomes
        ) : cadence ? (
          <>; add a time, or pick one below{becomes}</>
        ) : (
          ' — pick how often below.'
        )}
      </span>
    </p>
  );
}

function TaskForm({
  initial,
  editingId,
  onCancel,
  onSave,
  promptRef,
}: {
  initial?: Partial<ScheduledTask>;
  editingId?: string;
  onCancel: () => void;
  onSave: (draft: TaskDraft) => void;
  promptRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const base = useMemo(() => normalizeTask({ id: 'draft', ...initial }), [initial]);
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(base.prompt);
  const [frequency, setFrequency] = useState<Frequency>(base.frequency);
  const [hour, setHour] = useState(base.hour);
  const [minute, setMinute] = useState(base.minute);
  const [weekday, setWeekday] = useState(base.weekday);
  const [cwd, setCwd] = useState(base.cwd ?? '');
  /** Once a When control is touched the sentence stops driving it. */
  const [whenTouched, setWhenTouched] = useState(false);
  const enabled = initial?.enabled ?? true;
  const projects = useProjectStore((s) => s.projects);
  const modelNote = useModelNote();
  const loadedModel = useLoadedModel();
  const nameId = useId();
  const promptId = useId();
  const now = Date.now();

  // The sentence is read only for a NEW, BLANK task: a template's prompt and
  // an existing task's prompt are already instructions, not schedule sentences.
  const parsing = initial === undefined;
  const parsed = useMemo(() => parseTaskDraft(prompt), [prompt]);
  const read = parsing ? parsed.read : { cadence: false, time: false };
  useEffect(() => {
    if (!parsing || whenTouched) return;
    if (parsed.read.cadence) {
      setFrequency(parsed.frequency);
      setWeekday(parsed.weekday);
    }
    if (parsed.read.time) {
      setHour(parsed.hour);
      setMinute(parsed.minute);
    }
  }, [parsing, whenTouched, parsed]);
  /**
   * The instruction as it will be saved: without the timing words, once a
   * cadence was read. A sentence that was ONLY timing words leaves nothing —
   * the parser hands the whole sentence back in that case, and "every friday"
   * is not an instruction.
   */
  const instruction = read.cadence
    ? parsed.prompt.trim() === prompt.trim()
      ? ''
      : parsed.prompt
    : prompt.trim();

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

  const canSave = instruction.length > 0;
  const save = () => {
    if (!canSave) return;
    onSave({
      name: name.trim() || nameFrom(instruction),
      prompt: instruction,
      frequency,
      hour,
      minute,
      weekday,
      enabled,
      ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
    });
  };
  /** ⌘↩ saves from any field; Escape is the dialog's own. */
  const onFieldKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  };
  const touchWhen =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setWhenTouched(true);
      set(v);
    };
  const minuteOptions = MINUTES.includes(minute)
    ? MINUTES
    : [...MINUTES, minute].sort((a, b) => a - b);
  const folderLabel =
    cwd === '' ? 'Its own folder' : (projects.find((p) => p.path === cwd)?.name ?? cwd);

  return (
    <>
      <DialogBody className="sd-dialog-body" data-testid="sd-editor">
        <div className="flex flex-col gap-1">
          <label htmlFor={promptId} className="sd-field-label">
            What should it do?
          </label>
          <TextArea
            ref={promptRef}
            id={promptId}
            data-testid="sd-editor-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onFieldKey}
            autoGrow
            rows={4}
            placeholder={
              parsing
                ? 'Every weekday at 9am, summarise what changed in my working folder'
                : 'Run the test suite and tell me only what failed.'
            }
            style={{ minHeight: 108 }}
          />
          {parsing ? <ParseNote parsed={parsed} instruction={instruction} now={now} /> : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="sd-field-label">
            Name
          </label>
          <Input
            id={nameId}
            data-testid="sd-editor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onFieldKey}
            placeholder={
              instruction === ''
                ? 'Named from the first line if you leave this blank'
                : nameFrom(instruction)
            }
          />
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1">
            <span className="sd-field-label">When</span>
            <div className="flex flex-wrap items-center gap-2" data-testid="sd-editor-when">
              <Select
                value={frequency}
                onValueChange={touchWhen((v) => setFrequency(v as Frequency))}
              >
                <SelectTrigger className="pd-btn--sm" data-testid="sd-editor-frequency">
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
                <Select
                  value={String(weekday)}
                  onValueChange={touchWhen((v) => setWeekday(Number(v)))}
                >
                  <SelectTrigger className="pd-btn--sm" data-testid="sd-editor-weekday">
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
                <Select value={String(hour)} onValueChange={touchWhen((v) => setHour(Number(v)))}>
                  <SelectTrigger className="pd-btn--sm" data-testid="sd-editor-hour">
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
                <Select
                  value={String(minute)}
                  onValueChange={touchWhen((v) => setMinute(Number(v)))}
                >
                  <SelectTrigger className="pd-btn--sm" data-testid="sd-editor-minute">
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
            <span className="sd-field-label">Where it works</span>
            <Select
              value={cwd === '' ? OWN_FOLDER : cwd}
              onValueChange={(v) => setCwd(v === OWN_FOLDER ? '' : v)}
            >
              <SelectTrigger className="pd-btn--sm" data-testid="sd-editor-folder">
                {folderLabel}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={OWN_FOLDER} description="A new one per run, kept with the run">
                  Its own folder
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

        {/*
         * The consequence, in words, before the button — two lines by design.
         * The schedule and the first run are the thing; the two caveats are a
         * quieter line under it, not a fourth and fifth clause of dots.
         */}
        <div className="sd-preview" data-testid="sd-editor-preview">
          <p className="sd-preview-main">
            <strong>{schedule}</strong>
            {!enabled ? (
              <span> · saved paused</span>
            ) : catchesUp && slot !== undefined ? (
              <span>
                {' '}
                · {describeMomentIn(slot, now)} already passed, so it runs{' '}
                <strong>as soon as you save</strong>
              </span>
            ) : next !== undefined ? (
              <span>
                {' '}
                · {editingId === undefined ? 'first' : 'next'} run{' '}
                <strong>{describeMomentIn(next, now)}</strong> ({describeDelta(next, now)})
              </span>
            ) : frequency === 'manual' ? (
              <span> · nothing fires on its own</span>
            ) : null}
          </p>
          <p className="sd-preview-note">
            {modelNote !== null && enabled
              ? `${modelNote.charAt(0).toUpperCase()}${modelNote.slice(1)} · `
              : loadedModel !== null && enabled
                ? `Runs on ${loadedModel} · `
                : ''}
            reads your Mac, never sends
          </p>
        </div>
      </DialogBody>
      <DialogFooter className="sd-dialog-footer">
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="sd-editor-cancel">
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canSave}
          onClick={save}
          data-testid="sd-editor-save"
        >
          {editingId === undefined ? 'Schedule it' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  );
}
