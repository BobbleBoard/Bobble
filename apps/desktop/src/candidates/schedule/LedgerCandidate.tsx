/**
 * CANDIDATE 1 — THE LEDGER, and CANDIDATE 4 — LEDGER+ (`plus`).
 *
 * The argument: a scheduled task is judged by what it left behind. A run
 * happens in a throwaway session with nobody watching, so its record is the
 * only trace — and the shipping screen hides that record behind a "Past runs"
 * button on every row. Here the run history IS the page: a list of tasks on
 * the left, and on the right the selected task's contract, where it works,
 * what it has actually reached, and its runs as a timeline you read top-down.
 *
 * Mail-client anatomy on purpose — the thing people already know for "a list
 * of sources, and what each one delivered" — and the Model hub's anatomy too,
 * which is the sibling screen this sits beside. Under ~720px the panes stack
 * and a row pushes its detail in.
 *
 * LEDGER+ is the round-one verdict actually built: the same page with the
 * sentence box across the top (parse shown live, ↵ opens the prefilled editor
 * in the pane) and the list grouped by WHEN — Now / Today / Tomorrow / This
 * week / Later / By hand / Paused — so the trailing column can be a clock time
 * instead of a countdown. That grouping is the Agenda's; the pane is the
 * Ledger's; the time-honesty (due, missed, "runs as soon as you save") is
 * derive.ts, which both already used.
 *
 * Round three (JUDGEMENT-R3.md) found the page above the references at the
 * ledger and below them at the front door, and this file is where most of
 * that list landed: the composer is the chat composer's shape with a send
 * circle and a fixed lane for its parse; the list's search is a magnifier;
 * the first-run screen shares the composer's left edge; a running task hides
 * the dead "Run now" (there is no tasks:stop yet — NOTES); "off" is said by
 * the switch, the banner and the subtitle, not by a fourth pill; the reach
 * facts sit under the prompt as Connectors' label/value rows; and the pane
 * ends the way Connectors' does — a hairline, what deleting takes, Delete.
 */
import {
  Button,
  CollapsibleSearch,
  IconChevronLeft,
  IconPencil,
  IconPlus,
  ScrollArea,
  Switch,
} from '@pi-desktop/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { parseTaskDraft, type ScheduledTask } from '../../../electron/scheduled/schedule-logic';
import type { TaskDraft, TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { cx } from '../../onboarding/cx';
import type { TaskTemplate } from '../../scheduled/templates';
import { COMPOSER_SAMPLE, Composer } from './Composer';
import {
  type AgendaBucket,
  agendaBucket,
  BUCKET_TITLE,
  describeDuration,
  describeSchedule,
  describeSoon,
  lateBy,
  nameFrom,
  nameWasCut,
  type TaskState,
  tally,
  taskState,
} from './derive';
import { registerCandidateStates } from './hook';
import { IconPlay, IconRepeat } from './icons';
import { RunLedger } from './RunLedger';
import {
  DeleteFooter,
  describeTemplateSchedule,
  OffNotice,
  ReachBlock,
  SchedulingSwitch,
  SectionTitle,
  StatePill,
  StatusGlyph,
  stateLine,
  TASK_TEMPLATES,
  TaskGlyph,
  TemplateIcon,
  taskActions,
  templateDraft,
  useContainerWidth,
  useNow,
  useSchedule,
} from './shared';
import { TaskEditor } from './TaskEditor';

type Mode =
  | { kind: 'view' }
  /**
   * `sentence` is set when the editor was opened by ↵ in the composer;
   * `template` when a card was picked. `seq` is the draft's identity: the
   * editor is keyed by it, so a new draft — blank after a sentence, a template
   * after blank — is a fresh form, never the previous values under a new
   * heading (round-4 item 4 photographed exactly that).
   */
  | {
      kind: 'new';
      seq: number;
      initial?: Partial<ScheduledTask>;
      sentence?: string;
      template?: string;
    }
  | { kind: 'edit' };

const BUCKET_ORDER: readonly AgendaBucket[] = [
  'now',
  'today',
  'tomorrow',
  'week',
  'later',
  'manual',
  'paused',
];

/** The probe's named states; the empty list drops the two it cannot be in. */
const PLUS_STATES = ['default', 'typing', 'review', 'running', 'late', 'new', 'off'] as const;
const PLUS_EMPTY_STATES = ['default', 'typing', 'review', 'new', 'off'] as const;
const LEDGER_STATES = ['default', 'running', 'new'] as const;
const LEDGER_EMPTY_STATES = ['default', 'new'] as const;

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
      return 5;
    case 'off':
      // Where it would be — flipping the switch must not reshuffle the list.
      return rank(state.inner);
  }
}

/** The moment a row sorts by within its group. */
function sortKey(state: TaskState): number {
  switch (state.kind) {
    case 'scheduled':
    case 'missed':
      return state.nextAt;
    case 'off':
      return sortKey(state.inner);
    default:
      return 0;
  }
}

/**
 * The trailing word of a row. Plain Ledger: a coarse countdown ("in 27m",
 * "tomorrow", "Fri"). Ledger+: the list is grouped by day, so only a state
 * that is not "on schedule" has anything to add — running, due, missed,
 * paused, off.
 */
function trailing(state: TaskState, now: number, grouped: boolean): string {
  switch (state.kind) {
    case 'running':
      return describeDuration(state.run, now);
    case 'due':
      return 'due';
    case 'missed':
      return 'missed';
    case 'manual':
      return grouped ? '' : 'by hand';
    case 'paused':
      return 'paused';
    case 'off':
      return 'off';
    case 'scheduled':
      // Grouped: the group is the day and the schedule line is the time, so a
      // trailing "7:30 AM" said what the row already says. Nothing there.
      return grouped ? '' : describeSoon(state.nextAt, now);
  }
}

/** Does the pane get a state pill? Only where the word is the information. */
function hasPill(state: TaskState): boolean {
  return state.kind !== 'scheduled' && state.kind !== 'off';
}

/** ↵ in the composer: the parse, named by nameFrom, as the editor's draft to be checked. */
function draftFromSentence(sentence: string, seq: number): Mode {
  const parsed = parseTaskDraft(sentence);
  return { kind: 'new', seq, initial: { ...parsed, name: nameFrom(parsed.prompt) }, sentence };
}

function TaskRow({
  task,
  runs,
  state,
  now,
  grouped,
  selected,
  onSelect,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  grouped: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const muted = state.kind === 'paused' || state.kind === 'off';
  const word = trailing(state, now, grouped);
  return (
    <button
      type="button"
      className="sc-row pd-focusable"
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
      {word !== '' ? (
        <span
          className={cx(
            'sc-time shrink-0 text-caption',
            state.kind === 'missed' ? 'sc-warn' : 'text-text-muted',
          )}
        >
          {word}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The template cards. Blurbs are whole sentences — the shipping baseline
 * prints them whole and round two clamped them to two lines, which cut every
 * one that mattered ("Runs on…", "Reads locally;…"). Columns follow the
 * container, not the viewport: one under 720px, three past 1000px.
 *
 * The heading depends on where the cards sit, not on how many tasks exist:
 * on the landing screen they ARE the screen ("Nothing scheduled yet … or
 * write your own above" — the composer is above); under an open editor they
 * are the alternative ("Or start from one of these"). Round 4 caught the
 * empty screen saying "above" under a form, with the composer folded.
 */
function TemplatesPane({
  onPick,
  underEditor,
  columns,
}: {
  onPick: (t: TaskTemplate) => void;
  underEditor: boolean;
  columns: 1 | 2 | 3;
}) {
  return (
    <div data-testid="sc-ledger-templates">
      <h2 className="text-heading font-medium text-text-primary">
        {underEditor ? 'Or start from one of these' : 'Nothing scheduled yet'}
      </h2>
      <p className="mt-1 text-footnote text-text-muted">
        {underEditor
          ? 'Every one runs on this Mac; it can read what is here and cannot send anything.'
          : 'Start from one of these, or write your own above. Every one runs on this Mac; it can read what is here and cannot send anything.'}
      </p>
      <div className="sc-template-grid mt-4" data-columns={columns}>
        {TASK_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="sc-card sc-card--clickable pd-focusable flex items-start gap-3 p-3.5 text-left"
            onClick={() => onPick(t)}
            data-testid={`sc-template-${t.id}`}
          >
            {/* Under the pointer the tile becomes a "+": the click adds this. */}
            <span className="sc-tile sc-tile--swap">
              <span className="sc-tile-face sc-tile-face--icon">
                <TemplateIcon id={t.id} />
              </span>
              <span className="sc-tile-face sc-tile-face--plus" aria-hidden="true">
                <IconPlus size={16} />
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-text-primary">{t.name}</span>
              <span className="mt-0.5 block text-footnote text-text-secondary">{t.blurb}</span>
              <span className="mt-1.5 block text-caption text-text-muted">
                {describeTemplateSchedule(t)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What the composer becomes while an editor is on the page: one line, in the
 * composer's own footprint, that says where the draft came from and offers the
 * way back to the composer at its right end. Two type-here boxes on one
 * screen — the composer emptied to its placeholder above an editor whose
 * first field is "What should it do?" — was round three's item 7; the
 * composer HIDING for "New task" and Edit, so the list jumped 80px, was round
 * four's item 2. The strip holds the slot in all three cases:
 *
 *   ↵           From “every friday at 4pm, …”            Edit sentence
 *   New task    New task — a blank form, or a sentence   Write a sentence
 *   template    New task, from the “Morning brief” card  Write a sentence
 *   Edit        Editing “Morning brief”                  Cancel
 */
function Strip({
  icon,
  action,
  onAction,
  testId,
  children,
}: {
  icon: ReactNode;
  action: string;
  onAction: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="sc-strip" data-testid={testId}>
      {icon}
      <span className="sc-strip-text">{children}</span>
      <button
        type="button"
        className="pd-btn pd-btn--ghost pd-btn--sm pd-focusable"
        onClick={onAction}
        data-testid={`${testId}-action`}
      >
        {action}
      </button>
    </div>
  );
}

function Detail({
  task,
  runs,
  state,
  now,
  schedulingOn,
  onEdit,
  onDeleted,
}: {
  task: ScheduledTask;
  runs: readonly TaskRun[] | undefined;
  state: TaskState;
  now: number;
  schedulingOn: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { detail } = stateLine(state, now);
  const counts = tally(runs);
  const running = state.kind === 'running';
  const total = runs?.length ?? 0;
  // One schedule, one fact — and not the same fact twice. A by-hand task's
  // schedule line already IS its state ("Only when you run it"), so the state's
  // detail is dropped there: round 4's one-run shot read "Only when you run it ·
  // only when you run it". Running drops it too: the pill under it is the fact.
  const aside = running || state.kind === 'manual' ? '' : ` · ${detail}`;
  return (
    <div data-testid="sc-ledger-detail">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="sc-tile sc-tile--lg">
            <TaskGlyph task={task} runs={runs} size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="sc-detail-title truncate text-text-primary">{task.name}</h2>
            {/* Round one said "next Tomorrow 7:30 AM · in 22h 57m"; see `aside`. */}
            <p className="text-footnote text-text-muted">
              {describeSchedule(task)}
              {aside}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/*
           * While a run is going the button would be "Stop" — and there is no
           * `tasks:stop` IPC to make it one (NOTES proposes it). A greyed
           * "Running…" was the state said a third time by a dead control;
           * the pill below is the state, so the button goes away instead.
           */}
          {!running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void taskActions().runNow(task.id)}
              data-testid="sc-run-now"
            >
              <IconPlay size={12} /> Run now
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onEdit} data-testid="sc-edit">
            <IconPencil size={12} /> Edit
          </Button>
          {/* Dimmed, not disabled, while scheduling is off: on, but not firing. */}
          <span
            className={cx('ml-1 flex items-center', !schedulingOn && 'sc-dim')}
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
              data-testid="sc-task-switch"
            />
          </span>
        </div>
      </div>

      {hasPill(state) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatePill state={state} now={now} />
        </div>
      ) : null}

      <pre className="sc-prompt mt-4">{task.prompt}</pre>

      <SectionTitle className="mt-6">Reach</SectionTitle>
      <ReachBlock task={task} runs={runs} />

      <SectionTitle
        className="mt-6"
        count={total > 0 ? total : undefined}
        aside={
          counts.ok + counts.error > 0
            ? `${counts.ok} ok${counts.error > 0 ? ` · ${counts.error} failed` : ''}`
            : undefined
        }
      >
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

export function LedgerCandidate({ plus = false }: { plus?: boolean }) {
  const { enabled, tasks, runs, loaded } = useSchedule();
  const now = useNow();
  const [rootRef, width] = useContainerWidth<HTMLDivElement>();
  const stacked = width > 0 && width < 720;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [text, setText] = useState('');
  const [composerFocus, setComposerFocus] = useState(0);
  const [detailShown, setDetailShown] = useState(false);
  const candidateId = plus ? 'ledger-plus' : 'ledger';
  /** Each new draft gets its own identity, so the editor remounts fresh for it. */
  const draftSeq = useRef(0);
  const nextSeq = () => ++draftSeq.current;
  const blankDraft = (): Mode => ({ kind: 'new', seq: nextSeq() });
  const templateMode = (t: TaskTemplate): Mode => ({
    kind: 'new',
    seq: nextSeq(),
    initial: templateDraft(t),
    template: t.name,
  });

  const rows = useMemo(
    () =>
      tasks
        .map((task) => ({ task, state: taskState(task, runs[task.id], now, enabled) }))
        .filter(({ task }) => task.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => {
          const r = rank(a.state) - rank(b.state);
          if (r !== 0) return r;
          const an = sortKey(a.state) || Number.POSITIVE_INFINITY;
          const bn = sortKey(b.state) || Number.POSITIVE_INFINITY;
          return an - bn || a.task.name.localeCompare(b.task.name);
        }),
    [tasks, runs, now, enabled, query],
  );

  /** Ledger+: the same rows, under the day they happen. */
  const groups = useMemo(() => {
    if (!plus) return [{ bucket: undefined, items: rows }];
    const by = new Map<AgendaBucket, typeof rows>();
    for (const row of rows) {
      const b = agendaBucket(row.state, now);
      by.set(b, [...(by.get(b) ?? []), row]);
    }
    return BUCKET_ORDER.filter((b) => by.has(b)).map((b) => ({
      bucket: b,
      items: (by.get(b) ?? []).sort(
        (x, y) => sortKey(x.state) - sortKey(y.state) || x.task.name.localeCompare(y.task.name),
      ),
    }));
  }, [plus, rows, now]);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const shown = mode.kind === 'view' && selected === null ? (rows[0]?.task ?? null) : selected;
  const shownState = shown === null ? null : taskState(shown, runs[shown.id], now, enabled);

  // The probe's named states. Ledger: default (the task with the most history —
  // the one that shows the ledger), running, new. Ledger+ adds typing (the
  // sentence with its live parse), review (↵ pressed: the prefilled editor),
  // late and off. Announced as a function of the data, because an empty list
  // has nothing running and nothing late.
  const latest = useRef({ tasks, runs });
  latest.current = { tasks, runs };
  useEffect(
    () =>
      registerCandidateStates(
        candidateId,
        () => {
          const empty = latest.current.tasks.length === 0;
          if (plus) return empty ? PLUS_EMPTY_STATES : PLUS_STATES;
          return empty ? LEDGER_EMPTY_STATES : LEDGER_STATES;
        },
        (s) => {
          const { tasks: ts, runs: rs } = latest.current;
          setText(s === 'typing' ? COMPOSER_SAMPLE : '');
          setQuery('');
          setSearchOpen(false);
          // The one notice that stays: scheduling off. Real IPC, throwaway home.
          void taskActions().setEnabled(s !== 'off');
          // A fresh draft each time (`seq`): the "new" state after "review" is
          // a blank form, as the button would give, not the sentence's values
          // with their provenance stripped — the state hook took a short cut
          // the button does not have, and round four photographed the result.
          if (s === 'new') {
            setMode({ kind: 'new', seq: ++draftSeq.current });
            setDetailShown(true);
            return;
          }
          if (s === 'review') {
            setMode(draftFromSentence(COMPOSER_SAMPLE, ++draftSeq.current));
            setDetailShown(true);
            return;
          }
          setMode({ kind: 'view' });
          if (s === 'running') {
            const live = ts.find((t) => rs[t.id]?.[0]?.status === 'running');
            setSelectedId(live?.id ?? null);
            setDetailShown(true);
          } else if (s === 'late') {
            // The task whose newest run was a catch-up — the sentence `trigger` exists for.
            const late = ts.find((t) => {
              const r = rs[t.id]?.[0];
              return r !== undefined && lateBy(t, r) !== undefined;
            });
            setSelectedId(late?.id ?? null);
            setDetailShown(true);
          } else {
            const richest = [...ts].sort(
              (a, b) => (rs[b.id]?.length ?? 0) - (rs[a.id]?.length ?? 0),
            )[0];
            setSelectedId(richest?.id ?? null);
            // Narrow + default is the list, the screen you land on.
            setDetailShown(false);
            // On an empty list "default" is the screen as you land on it,
            // caret in the composer — which the candidate shell's own tab
            // strip (no counterpart in the app) steals when the probe clicks it.
            if (ts.length === 0) setComposerFocus((n) => n + 1);
          }
        },
      ),
    [candidateId, plus],
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
    // The sentence became a task; the composer comes back empty.
    setText('');
  };

  const check = () => {
    const t = text.trim();
    if (t.length === 0) return;
    // The selection is kept (the row just stops reading as selected while the
    // editor is up), so "Edit sentence" and Cancel land back on the same task.
    // The sentence STAYS in the composer while it fades under the strip: the
    // first cut cleared it here, and the film caught the placeholder showing
    // through the fold. Cancel brings the sentence back; only saving clears it.
    setMode(draftFromSentence(t, nextSeq()));
    setDetailShown(true);
  };

  /** Back from the editor to the sentence it was read from, caret and all. */
  const editSentence = () => {
    if (mode.kind !== 'new' || mode.sentence === undefined) return;
    setText(mode.sentence);
    setMode({ kind: 'view' });
    setComposerFocus((n) => n + 1);
  };

  /** Back from a blank or template editor to the composer, caret in it. */
  const writeSentence = () => {
    setMode({ kind: 'view' });
    setComposerFocus((n) => n + 1);
  };

  // The strip fading OUT keeps its words: the last editor mode is remembered
  // after the commit, so the render that returns to `view` still has it.
  const lastStrip = useRef<Exclude<Mode, { kind: 'view' }> | null>(null);
  useEffect(() => {
    if (mode.kind !== 'view') lastStrip.current = mode;
  }, [mode]);
  const stripMode = mode.kind !== 'view' ? mode : lastStrip.current;

  const empty = loaded && tasks.length === 0;
  // With nothing to list, the list column is a blank strip beside a pane that
  // already says "Nothing scheduled yet"; the templates take the width instead.
  const showList = !empty && (!stacked || !detailShown);
  const showDetail = empty || !stacked || detailShown;
  // Columns follow the PANE the cards are in: the whole page on the first-run
  // screen, the page minus the list column once there is a list.
  const paneWidth = showList && !stacked ? width - 280 : width;
  const templateColumns: 1 | 2 | 3 = stacked ? 1 : paneWidth >= 1000 ? 3 : 2;
  const fromSentence = mode.kind === 'new' && mode.sentence !== undefined;
  const cut = fromSentence && mode.initial?.prompt !== undefined && nameWasCut(mode.initial.prompt);

  return (
    <div
      ref={rootRef}
      className={cx('sc-page', stacked && 'sc-narrow')}
      data-testid={`sc-${candidateId}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-4 pb-3">
        <div>
          <h1 className="sc-title">Scheduled tasks</h1>
          <p className="sc-subtitle">
            Work Bobble does on its own while it is open — what ran, and what runs next.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SchedulingSwitch enabled={enabled} />
          {/* Reads as pressed while a New-task editor is the pane; a second click does nothing. */}
          <Button
            variant={mode.kind === 'new' ? 'secondary' : 'primary'}
            size="sm"
            aria-pressed={mode.kind === 'new'}
            onClick={() => {
              if (mode.kind === 'new') return;
              setMode(blankDraft());
              setDetailShown(true);
            }}
            data-testid="sc-new"
          >
            <IconPlus size={14} /> New task
          </Button>
        </div>
      </header>
      {plus ? (
        /*
         * THE SLOT. One height in every state, and a real crossfade between
         * its two faces: the composer (box + lane), or a strip in the box's
         * footprint with the lane empty under it. Both faces stay mounted in
         * one grid cell — the hidden one at opacity 0, `visibility: hidden`
         * and inert, so it takes no Tab stop and no click — and only opacity
         * moves between them, so nothing below this can move when an editor
         * opens or closes. The first cut unmounted the composer and faded the
         * strip in from nothing; the film (shots/motion) caught an empty slot
         * for a frame between them.
         */
        <div className="px-6" data-testid="sc-slot">
          <div className="sc-slot-stack">
            <div
              className="sc-slot-layer"
              data-shown={mode.kind === 'view'}
              inert={mode.kind !== 'view'}
            >
              <Composer
                value={text}
                onChange={setText}
                onSubmit={check}
                now={now}
                autoFocus={empty}
                focusToken={composerFocus}
              />
            </div>
            <div
              className="sc-slot-layer"
              data-shown={mode.kind !== 'view'}
              inert={mode.kind === 'view'}
              data-testid="sc-slot-strip"
            >
              {stripMode === null ? null : stripMode.kind === 'new' &&
                stripMode.sentence !== undefined ? (
                <Strip
                  icon={<IconRepeat size={14} />}
                  action="Edit sentence"
                  onAction={editSentence}
                  testId="sc-sentence-strip"
                >
                  From <strong>“{stripMode.sentence}”</strong>
                </Strip>
              ) : stripMode.kind === 'new' ? (
                <Strip
                  icon={<IconPlus size={14} />}
                  action="Write a sentence"
                  onAction={writeSentence}
                  testId="sc-new-strip"
                >
                  {stripMode.template !== undefined ? (
                    <>
                      New task, from the <strong>“{stripMode.template}”</strong> card
                    </>
                  ) : (
                    <>
                      <strong>New task</strong> — a blank form, or a sentence with a time in it
                    </>
                  )}
                </Strip>
              ) : (
                <Strip
                  icon={<IconPencil size={14} />}
                  action="Cancel"
                  onAction={() => setMode({ kind: 'view' })}
                  testId="sc-edit-strip"
                >
                  Editing <strong>“{shown?.name}”</strong>
                </Strip>
              )}
              <div className="sc-lane" aria-hidden="true" />
            </div>
          </div>
        </div>
      ) : null}
      {!enabled ? (
        <div className="px-6 pb-3">
          <OffNotice enabled={enabled} />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 border-t border-border-subtle" data-testid="sc-panes">
        {showList ? (
          <aside
            className={cx(
              'flex shrink-0 flex-col border-border-subtle',
              stacked ? 'w-full' : 'w-[280px] border-r',
            )}
          >
            {/*
             * A magnifier, not a field: nine tasks do not need a search box,
             * and a second type-here pill 60px under the composer was the
             * thing that made the composer read as a search field.
             */}
            <div className="sc-list-head" data-testid="sc-ledger-search">
              <CollapsibleSearch
                placeholder="Search tasks"
                value={query}
                onChange={setQuery}
                expanded={searchOpen}
                onExpandedChange={setSearchOpen}
                iconSize={14}
              />
            </div>
            <ScrollArea className="min-h-0 flex-1 px-2 pb-4">
              {loaded && rows.length === 0 ? (
                <p className="px-3 py-6 text-footnote text-text-muted">
                  {query !== '' ? 'No task matches.' : 'Nothing scheduled yet.'}
                </p>
              ) : (
                groups.map(({ bucket, items }) => (
                  <div
                    key={bucket ?? 'all'}
                    data-testid={bucket ? `sc-bucket-${bucket}` : undefined}
                  >
                    {bucket !== undefined ? (
                      <p className="sc-list-group">{BUCKET_TITLE[bucket]}</p>
                    ) : null}
                    {items.map(({ task, state }) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        runs={runs[task.id]}
                        state={state}
                        now={now}
                        grouped={plus}
                        selected={shown?.id === task.id && mode.kind !== 'new'}
                        onSelect={() => {
                          setSelectedId(task.id);
                          setMode({ kind: 'view' });
                          setDetailShown(true);
                        }}
                      />
                    ))}
                  </div>
                ))
              )}
              {loaded && tasks.length > 0 && !plus ? (
                <button
                  type="button"
                  className="sc-row pd-focusable mt-2"
                  onClick={() => {
                    setSelectedId(null);
                    setMode(blankDraft());
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
              {/*
               * The first-run screen shares the composer's left edge instead of
               * centring a second column beside it — one axis, so the eye
               * lands. A selected task's pane is a reading column, so it is
               * centred and capped like the Model hub's.
               */}
              <div
                className={cx(
                  'w-full',
                  empty ? 'max-w-[1160px] px-6 py-5' : 'mx-auto max-w-[780px] px-7 py-5',
                )}
              >
                {stacked && !empty ? (
                  <button
                    type="button"
                    className="mb-3 inline-flex items-center gap-1 text-footnote text-text-secondary pd-focusable"
                    onClick={() => setDetailShown(false)}
                    data-testid="sc-back"
                  >
                    <IconChevronLeft size={14} /> All tasks
                  </button>
                ) : null}
                {mode.kind === 'new' ? (
                  // Keyed by the draft: a template picked over a blank form, or
                  // a blank form after a sentence, is a fresh editor.
                  <div key={`new-${mode.seq}`} className="sc-pane-in">
                    <h2 className="mb-4 text-heading font-medium text-text-primary">New task</h2>
                    <TaskEditor
                      initial={mode.initial}
                      onCancel={() => setMode({ kind: 'view' })}
                      onSave={save}
                      layout="pane"
                      autoFocus={fromSentence ? 'name' : 'prompt'}
                      lead={
                        !fromSentence
                          ? undefined
                          : cut
                            ? 'Read from your sentence. The name is its first words — change it if you like, then check the schedule.'
                            : 'Read from your sentence. Check the name and the schedule, then put it on the calendar.'
                      }
                    />
                    {tasks.length === 0 || mode.initial === undefined ? (
                      <div className="mt-8">
                        <TemplatesPane
                          underEditor
                          columns={templateColumns}
                          onPick={(t) => setMode(templateMode(t))}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : mode.kind === 'edit' && shown !== null ? (
                  <div key={`edit-${shown.id}`} className="sc-pane-in">
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
                  // Keyed by task, so switching tasks crossfades the pane in
                  // rather than swapping it — the app's own overlays all move.
                  <div key={shown.id} className="sc-pane-in">
                    <Detail
                      task={shown}
                      runs={runs[shown.id]}
                      state={shownState}
                      now={now}
                      schedulingOn={enabled}
                      onEdit={() => setMode({ kind: 'edit' })}
                      onDeleted={() => {
                        setSelectedId(null);
                        setDetailShown(false);
                      }}
                    />
                  </div>
                ) : (
                  <TemplatesPane
                    underEditor={false}
                    columns={templateColumns}
                    onPick={(t) => setMode(templateMode(t))}
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
