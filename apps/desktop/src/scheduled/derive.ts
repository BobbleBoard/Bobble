/**
 * What the screen can HONESTLY say about a task, derived from the real data
 * model and nothing else.
 *
 * The scheduler decides "due" with previousRun/lastRunAt and a 6h grace
 * (schedule-logic.ts dueTasks). The same three facts give a task one of the
 * states below — the Up/Late/Down model Healthchecks.io uses for cron jobs,
 * which fits a local scheduler exactly: a slot that passed while Bobble was
 * closed is LATE until the grace runs out and MISSED after it. Nothing here is
 * inferred from text; "what it reaches" comes from the tool trail of a real
 * run, and "ran late" comes from `TaskRun.trigger` plus the slot the run was
 * catching up — never from a Run-now.
 */
import { sayIfRaw } from '@pi-desktop/shared';
import {
  describeSchedule,
  type Frequency,
  formatTime,
  nameFrom,
  nameWasCut,
  nextRun,
  previousRun,
  type ScheduledTask,
} from '../../electron/scheduled/schedule-logic';
import type { TaskRun } from '../../electron/scheduled/scheduled-contract';

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
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayIndexOf(ms: number, now: number): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return Math.floor((ms - dayStart.getTime()) / DAY);
}

/** "Today 7:30 AM", "Tomorrow 7:30 AM", "Fri 4:00 PM", "12 Sep 9:00 AM". */
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
 * `describeMoment` for the middle of a sentence — "next tomorrow 7:30 AM", not
 * "next Tomorrow 7:30 AM". A weekday or a date keeps its capital; it is a name.
 */
export function describeMomentIn(ms: number, now: number): string {
  const s = describeMoment(ms, now);
  return /^(Today|Tomorrow|Yesterday)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * "in 27m" / "in 2h 15m" / "in 9h" / "in 4 days" / "3h ago". Minutes only
 * while they are worth watching (under three hours); past that nobody is
 * holding a stopwatch.
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
 * The cadence alone — "Every Friday", "Weekdays", "Every hour" — for the
 * sentence box, which must not print a time it did not read.
 */
export function describeCadence(frequency: Frequency, weekday: number): string {
  switch (frequency) {
    case 'manual':
      return 'Only when you run it';
    case 'hourly':
      return 'Every hour';
    case 'daily':
      return 'Every day';
    case 'weekdays':
      return 'Weekdays';
    case 'weekly':
      return `Every ${WEEKDAY_LONG[weekday] ?? 'week'}`;
  }
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

/**
 * WHEN NEXT, as the day alone — "in 2h 15m", "tomorrow", "Friday", "12 Sep".
 * The line it follows already says the time ("Weekdays at 7:30 AM"), so the
 * clause adds only what the schedule sentence cannot: which day that is. Today
 * (and an hourly task) gets the countdown instead, because "today" is not an
 * answer to "when".
 */
export function describeNextDay(ms: number, now: number): string {
  const dayIndex = dayIndexOf(ms, now);
  if (dayIndex <= 0) return describeDelta(ms, now);
  if (dayIndex === 1) return 'tomorrow';
  const d = new Date(ms);
  if (dayIndex < 7) return WEEKDAY_LONG[d.getDay()] ?? 'this week';
  return `${d.getDate()} ${d.toLocaleString([], { month: 'short' })}`;
}

/**
 * The clause after a task's schedule, in the list and on its page: the one
 * thing its state adds to "Weekdays at 7:30 AM". A by-hand task's schedule
 * already IS its state; a paused task says so with its trailing word.
 */
export function stateClause(state: TaskState, now: number): string {
  switch (state.kind) {
    case 'running':
      return `Running · ${describeDuration(state.run, now)}`;
    case 'due':
      return `Due · ${describeMomentIn(state.slotAt, now)} passed, starts within 30s`;
    case 'missed':
      return `Missed ${describeMomentIn(state.slotAt, now)} · next ${describeNextDay(state.nextAt, now)}`;
    case 'scheduled':
      return `next ${describeNextDay(state.nextAt, now)}`;
    case 'off':
      return 'scheduling is off';
    case 'paused':
    case 'manual':
      return '';
  }
}

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
 * A run's trail in the words the facts use — "Calendar · Mail · Reminders" —
 * and a tool we have no word for stays as its own name rather than vanishing.
 * Raw ids belong in a tooltip, not on the page.
 */
export function describeTrail(tools: readonly string[]): string {
  const words: string[] = [];
  for (const tool of tools) {
    const word = reachOf(tool)?.label ?? tool;
    if (!words.includes(word)) words.push(word);
  }
  return words.join(' · ');
}

/** Basename for a folder path. */
export function folderName(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined;
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Results across a task's history: how many worked, failed, were stopped. */
export function tally(runs: readonly TaskRun[] | undefined): {
  ok: number;
  error: number;
  stopped: number;
} {
  let ok = 0;
  let error = 0;
  let stopped = 0;
  for (const r of runs ?? []) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'error') error++;
    else if (r.status === 'stopped') stopped++;
  }
  return { ok, error, stopped };
}

/** The first line of a run's report — the sentence you would read in a list. */
export function headline(run: TaskRun): string {
  // In words — a run's raw error ("could not start: spawn ENOENT") is not a headline.
  if (run.error !== undefined) return sayIfRaw(run.error, 'run');
  if (run.status === 'stopped') {
    const first = firstLine(run.summary);
    return first === '' ? 'Stopped by hand' : `Stopped by hand — had said: ${first}`;
  }
  const first = firstLine(run.summary);
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '') ?? '';
}

/** The first image a run left behind, for a thumbnail on its row. */
export function firstImage(run: TaskRun): TaskRun['artifacts'][number] | undefined {
  return run.artifacts.find((a) => a.kind === 'image');
}

/** The model the newest finished run used, if any record carries one. */
export function lastRunModel(runs: readonly TaskRun[] | undefined): string | undefined {
  return runs?.find((r) => r.model !== undefined)?.model?.displayName;
}

export { describeSchedule, formatTime, nameFrom, nameWasCut };
