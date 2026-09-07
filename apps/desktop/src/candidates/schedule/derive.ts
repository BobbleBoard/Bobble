/**
 * What the candidates can HONESTLY say about a task, derived from the real
 * data model and nothing else.
 *
 * The scheduler decides "due" with previousRun/lastRunAt and a 6h grace
 * (schedule-logic.ts dueTasks). The same three facts give a task one of the
 * states below — the Up/Late/Down model Healthchecks.io uses for cron jobs,
 * which fits a local scheduler exactly: a slot that passed while Bobble was
 * closed is LATE until the grace runs out and MISSED after it. Nothing here is
 * inferred from text; a chip for "what it reaches" comes from the tool trail of
 * a real run, and "ran late" comes from `TaskRun.trigger` plus the slot the
 * run was catching up — never from a Run-now.
 */
import {
  describeSchedule,
  formatTime,
  nextRun,
  previousRun,
  type ScheduledTask,
  titleFrom,
} from '../../../electron/scheduled/schedule-logic';
import type { TaskRun } from '../../../electron/scheduled/scheduled-contract';

/** Mirrors dueTasks' default: a miss older than this is written off, not caught up. */
export const GRACE_MS = 6 * 3_600_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/**
 * The scheduler ticks every 30 s, so a run that starts this long after its
 * slot was not the tick — it was a catch-up after the Mac woke or Bobble
 * reopened. Below this the lag is the tick itself and not worth a word.
 */
export const LATE_MS = 2 * MIN;

/** The states a task has on its own — before the feature switch is considered. */
export type ScheduleState =
  | { readonly kind: 'running'; readonly run: TaskRun }
  | { readonly kind: 'paused' }
  | { readonly kind: 'manual' }
  /** Its slot passed, it has not run, and the scheduler will still catch it up. */
  | { readonly kind: 'due'; readonly slotAt: number }
  /** Its slot passed with nothing running, and the grace ran out. */
  | { readonly kind: 'missed'; readonly slotAt: number; readonly nextAt: number }
  | { readonly kind: 'scheduled'; readonly nextAt: number };

export type TaskState =
  | ScheduleState
  /**
   * Scheduling is off. The task keeps the state it would have — `inner` — so a
   * list grouped by day does not reshuffle into one "Paused" heap the moment
   * the switch is flipped, and flips back the moment it is flipped again.
   * Only a task the switch actually silences gets this: a by-hand task is
   * unaffected, a paused task was already not firing.
   */
  | { readonly kind: 'off'; readonly inner: ScheduleState };

export function taskState(
  task: ScheduledTask,
  runs: readonly TaskRun[] | undefined,
  now: number,
  globallyEnabled: boolean,
): TaskState {
  const own = scheduleState(task, runs, now);
  if (globallyEnabled) return own;
  if (own.kind === 'running' || own.kind === 'paused' || own.kind === 'manual') return own;
  return { kind: 'off', inner: own };
}

/** `state` with the feature switch peeled off: what the task is doing on its own terms. */
export function ownState(state: TaskState): ScheduleState {
  return state.kind === 'off' ? state.inner : state;
}

function scheduleState(
  task: ScheduledTask,
  runs: readonly TaskRun[] | undefined,
  now: number,
): ScheduleState {
  const newest = runs?.[0];
  if (newest?.status === 'running') return { kind: 'running', run: newest };
  if (!task.enabled) return { kind: 'paused' };
  if (task.frequency === 'manual') return { kind: 'manual' };
  const slot = previousRun(task, now);
  const next = nextRun(task, now, true);
  // "Last ran" is the later of the task's own stamp and its newest run record —
  // a run started by hand counts, and so does one whose stamp was lost.
  const lastRan = Math.max(task.lastRunAt ?? 0, newest?.startedAt ?? 0);
  if (slot !== undefined && lastRan < slot) {
    if (now - slot <= GRACE_MS) return { kind: 'due', slotAt: slot };
    // A task made AFTER the slot did not miss anything; it simply has not had one.
    if (task.createdAt < slot && next !== undefined)
      return { kind: 'missed', slotAt: slot, nextAt: next };
  }
  if (next !== undefined) return { kind: 'scheduled', nextAt: next };
  return { kind: 'manual' };
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayIndexOf(ms: number, now: number): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return Math.floor((ms - dayStart.getTime()) / DAY);
}

/** "7:30 AM" today, "Tomorrow 7:30 AM", "Fri 4:00 PM", "12 Sep 9:00 AM". */
export function describeMoment(ms: number, now: number): string {
  const d = new Date(ms);
  const time = formatTime(d.getHours(), d.getMinutes());
  const dayIndex = dayIndexOf(ms, now);
  if (dayIndex === 0) return `Today ${time}`;
  if (dayIndex === 1) return `Tomorrow ${time}`;
  if (dayIndex === -1) return `Yesterday ${time}`;
  if (dayIndex > 1 && dayIndex < 7) return `${WEEKDAY_SHORT[d.getDay()]} ${time}`;
  return `${d.getDate()} ${d.toLocaleString([], { month: 'short' })} ${time}`;
}

/**
 * "in 27m" / "in 2h 15m" / "in 9h" / "in 4 days" / "3h ago". Minutes only
 * while they are worth watching (under three hours); past that nobody is
 * holding a stopwatch, and "in 22h 57m" was noise on every row of round one.
 */
export function describeDelta(ms: number, now: number): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  const suffix = (s: string) => (delta >= 0 ? `in ${s}` : `${s} ago`);
  if (abs < MIN) return delta >= 0 ? 'now' : 'just now';
  if (abs < HOUR) return suffix(`${Math.round(abs / MIN)}m`);
  if (abs < 3 * HOUR && delta > 0) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs - h * HOUR) / MIN);
    return suffix(m === 0 ? `${h}h` : `${h}h ${m}m`);
  }
  if (abs < DAY) return suffix(`${Math.round(abs / HOUR)}h`);
  const days = Math.round(abs / DAY);
  return suffix(days === 1 ? '1 day' : `${days} days`);
}

/**
 * The word a list column wants for "when next": "in 27m", "in 9h",
 * "tomorrow", "Fri", "12 Sep". Coarse on purpose — a column is scanned, and
 * the day matters more than the minute once it is not today.
 */
export function describeSoon(ms: number, now: number): string {
  const delta = ms - now;
  if (delta < MIN) return 'now';
  if (delta < HOUR) return `in ${Math.round(delta / MIN)}m`;
  const dayIndex = dayIndexOf(ms, now);
  if (dayIndex === 0) return `in ${Math.round(delta / HOUR)}h`;
  if (dayIndex === 1) return 'tomorrow';
  const d = new Date(ms);
  if (dayIndex < 7) return WEEKDAY_SHORT[d.getDay()] ?? '';
  return `${d.getDate()} ${d.toLocaleString([], { month: 'short' })}`;
}

export function describeDuration(run: TaskRun, now: number): string {
  const end = run.finishedAt ?? now;
  const s = Math.max(1, Math.round((end - run.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
}

/** "1h 42m" / "35m" / "2 days" — a span, for how late a run was. */
export function describeSpan(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms - h * HOUR) / MIN);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const days = Math.round(ms / DAY);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * How late a SCHEDULED run started, or undefined when it was on time, was
 * started by hand, or predates `trigger` (then we cannot know, and say
 * nothing). The slot it was catching up is the last one before it started —
 * the same walk the scheduler does.
 */
export function lateBy(task: ScheduledTask, run: TaskRun): number | undefined {
  if (run.trigger !== 'schedule') return undefined;
  const slot = previousRun(task, run.startedAt);
  if (slot === undefined) return undefined;
  const late = run.startedAt - slot;
  return late > LATE_MS ? late : undefined;
}

/** Group heading a task belongs under in a time-ordered agenda. */
export type AgendaBucket = 'now' | 'today' | 'tomorrow' | 'week' | 'later' | 'manual' | 'paused';

export function agendaBucket(state: TaskState, now: number): AgendaBucket {
  switch (state.kind) {
    case 'off':
      // The day it WOULD fire. Flipping the switch must not rearrange the list.
      return agendaBucket(state.inner, now);
    case 'running':
    case 'due':
      return 'now';
    case 'paused':
      return 'paused';
    case 'manual':
      return 'manual';
    case 'missed':
    case 'scheduled': {
      const dayIndex = dayIndexOf(state.nextAt, now);
      if (dayIndex <= 0) return 'today';
      if (dayIndex === 1) return 'tomorrow';
      if (dayIndex < 7) return 'week';
      return 'later';
    }
  }
}

export const BUCKET_TITLE: Record<AgendaBucket, string> = {
  now: 'Now',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  later: 'Later',
  manual: 'By hand',
  paused: 'Paused',
};

/** Tool names from a run's trail → the surface a person recognises. */
export interface Reach {
  readonly id: string;
  readonly label: string;
}

const REACH_RULES: ReadonlyArray<readonly [RegExp, Reach]> = [
  [/^calendar_/, { id: 'calendar', label: 'Calendar' }],
  [/^mail_/, { id: 'mail', label: 'Mail' }],
  [/^reminders_/, { id: 'reminders', label: 'Reminders' }],
  [/^messages_/, { id: 'messages', label: 'Messages' }],
  [/^contacts_/, { id: 'contacts', label: 'Contacts' }],
  [/^(web_search|search_web|fetch|web_fetch|browse)/, { id: 'web', label: 'Web' }],
  [/^(bash|shell|terminal|run_command)/, { id: 'terminal', label: 'Terminal' }],
  [/^(read|write|edit|glob|grep|ls|list_files)/, { id: 'files', label: 'Files' }],
  [/^(generate_image|image_|imagine)/, { id: 'image', label: 'Images' }],
  [/^(generate_video|video_)/, { id: 'video', label: 'Video' }],
  [/^(tts|speak|generate_audio|audio_)/, { id: 'audio', label: 'Audio' }],
];

export function reachOf(tool: string): Reach | undefined {
  return REACH_RULES.find(([re]) => re.test(tool))?.[1];
}

/** What the task actually reached, from the tool trail of its runs. Real, not guessed. */
export function reachFromRuns(runs: readonly TaskRun[] | undefined): readonly Reach[] {
  const seen = new Map<string, Reach>();
  for (const run of runs ?? []) {
    for (const tool of run.toolCalls) {
      const hit = reachOf(tool);
      if (hit !== undefined && !seen.has(hit.id)) seen.set(hit.id, hit);
    }
  }
  return [...seen.values()];
}

/**
 * A run's trail in the words the chips use — "Calendar · Mail · Reminders" —
 * and a tool we have no word for stays as its own name rather than vanishing.
 * Raw ids belong in a tooltip, not on the page (round-one shots had them).
 */
export function describeTrail(tools: readonly string[]): string {
  const words: string[] = [];
  for (const tool of tools) {
    const word = reachOf(tool)?.label ?? tool;
    if (!words.includes(word)) words.push(word);
  }
  return words.join(' · ');
}

/** Basename for a folder path, for the chip. */
export function folderName(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined;
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Results across a task's history: how many worked, how many failed. */
export function tally(runs: readonly TaskRun[] | undefined): { ok: number; error: number } {
  let ok = 0;
  let error = 0;
  for (const r of runs ?? []) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'error') error++;
  }
  return { ok, error };
}

/** The first line of a run's report — the sentence you would read in a list. */
export function headline(run: TaskRun): string {
  if (run.error !== undefined) return run.error;
  const first = run.summary.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** The first image a run left behind, for a thumbnail on its row. */
export function firstImage(run: TaskRun): TaskRun['artifacts'][number] | undefined {
  return run.artifacts.find((a) => a.kind === 'image');
}

/* ---- naming ---------------------------------------------------------------- */

const NAME_MAX_WORDS = 9;
const NAME_MAX_CHARS = 56;
const NAME_CUT_WORDS = 7;
/** Words a name must not end on — a cut after one of these is a cut mid-thought. */
const DANGLING = new Set([
  'a',
  'an',
  'the',
  'my',
  'your',
  'our',
  'this',
  'that',
  'which',
  'what',
  'who',
  'i',
  'me',
  'it',
  'its',
  'of',
  'on',
  'in',
  'at',
  'to',
  'for',
  'from',
  'by',
  'with',
  'about',
  'into',
  'and',
  'or',
  'but',
  'then',
  'so',
  'is',
  'are',
  'be',
  'as',
]);
const CONJUNCTION = /\s+(?:and|but|then|so|or)\s+/i;
const LEAD_IN = /^(?:please|then|also|just)\s+/i;

/**
 * A name from an instruction, the way a person would shorten it.
 *
 * schedule-logic's `titleFrom` takes the first clause and keeps six words,
 * which names "write up what I worked on this week" as "Write up what I
 * worked on" — a phrase cut mid-thought, and the name the list shows forever
 * if the person presses ↵ twice. This keeps a short first clause WHOLE, cuts a
 * long one at a conjunction before anything else, and when it must cut by
 * count, backs off dangling words so the name ends on something that means
 * something. Deterministic and instant, like the parse it sits beside; a model
 * is not loaded at first run, so a guess a person can correct is the right
 * first answer. `nameWasCut` says when it guessed, so the editor can say so.
 */
export function nameFrom(prompt: string): string {
  const clause = firstClause(prompt);
  if (clause === '') return 'Scheduled task';
  const words = clause.split(/\s+/);
  if (words.length <= NAME_MAX_WORDS && clause.length <= NAME_MAX_CHARS) return capitalise(clause);
  const [beforeConjunction] = clause.split(CONJUNCTION);
  const head = beforeConjunction ?? clause;
  if (head !== clause && head.split(/\s+/).length >= 3 && head.length <= NAME_MAX_CHARS)
    return capitalise(head);
  const kept = words.slice(0, NAME_CUT_WORDS);
  while (kept.length > 2 && DANGLING.has((kept[kept.length - 1] ?? '').toLowerCase())) kept.pop();
  return capitalise(kept.join(' '));
}

/** True when `nameFrom` had to cut — the name is a guess worth a second look. */
export function nameWasCut(prompt: string): boolean {
  const clause = firstClause(prompt);
  return clause !== '' && nameFrom(prompt).toLowerCase() !== capitalise(clause).toLowerCase();
}

function firstClause(prompt: string): string {
  const first = prompt.split(/[.;:\n]/).find((l) => l.trim() !== '') ?? '';
  // A comma ends the clause only once the clause can stand on its own.
  const [beforeComma, ...rest] = first.split(',');
  const clause =
    rest.length > 0 && (beforeComma ?? '').trim().split(/\s+/).length >= 3
      ? (beforeComma ?? '')
      : first;
  return clause
    .trim()
    .replace(LEAD_IN, '')
    .replace(/[\s"“”'‘’]+$/, '');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { describeSchedule, formatTime, titleFrom };
