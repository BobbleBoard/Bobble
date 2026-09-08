/**
 * SCHEDULED TASKS — the rules, with no clock, no disk and no Electron.
 *
 * Everything that decides WHEN a task runs lives here so it can be tested
 * against a fixed `now` instead of by waiting. The runner (scheduled-main.ts)
 * only ticks and calls these.
 *
 * Local time on purpose. "Weekdays at 8:00" means the user's 8am; computing it
 * in UTC would drift by an hour twice a year and look like a bug in the app
 * rather than in the maths.
 */

import { describeScheduleWords, formatClockTime, nameFrom, nameWasCut } from '@pi-desktop/shared';

export type Frequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly';

export const FREQUENCIES: readonly Frequency[] = [
  'manual',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
];

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  /** What the agent is asked to do, verbatim, when the task fires. */
  readonly prompt: string;
  readonly frequency: Frequency;
  /** Local hour 0-23 (ignored for 'hourly' and 'manual'). */
  readonly hour: number;
  /** Local minute 0-59. */
  readonly minute: number;
  /** 0=Sunday … 6=Saturday. Only meaningful for 'weekly'. */
  readonly weekday: number;
  /** Per-task switch — the user: "have some way to toggle this on and off". */
  readonly enabled: boolean;
  /** Working directory the run happens in; undefined = the app's default. */
  readonly cwd?: string;
  /** Epoch ms of the last completed run, for "last run" + catch-up. */
  readonly lastRunAt?: number;
  /** Epoch ms the task was created (ordering, and a stable tiebreak). */
  readonly createdAt: number;
}

/** The whole feature can be switched off without deleting anyone's tasks. */
export interface ScheduleState {
  readonly enabled: boolean;
  readonly tasks: readonly ScheduledTask[];
}

export const EMPTY_SCHEDULE: ScheduleState = { enabled: true, tasks: [] };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : Number.NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Coerce anything read off disk into a task we can reason about. */
export function normalizeTask(raw: Partial<ScheduledTask> & { id: string }): ScheduledTask {
  const frequency = FREQUENCIES.includes(raw.frequency as Frequency)
    ? (raw.frequency as Frequency)
    : 'daily';
  return {
    id: raw.id,
    name: (raw.name ?? '').trim() || 'Untitled task',
    prompt: (raw.prompt ?? '').trim(),
    frequency,
    hour: clampInt(raw.hour, 0, 23, 9),
    minute: clampInt(raw.minute, 0, 59, 0),
    weekday: clampInt(raw.weekday, 0, 6, 1),
    enabled: raw.enabled !== false,
    ...(raw.cwd !== undefined && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
    // A `modelId` used to be kept here and read by nothing: a run uses whatever
    // model the app has loaded, and the run record says which (TaskRun.model).
    ...(typeof raw.lastRunAt === 'number' ? { lastRunAt: raw.lastRunAt } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  };
}

function atTime(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

/**
 * The next moment this task should fire, or undefined if it never will.
 *
 * `manual` returns undefined — it is a task you keep around to run by hand, not
 * a disabled one. A DISABLED task also returns undefined, which is what makes
 * the per-task switch and the global switch the same mechanism downstream.
 */
export function nextRun(
  task: ScheduledTask,
  nowMs: number,
  globallyEnabled = true,
): number | undefined {
  if (!globallyEnabled || !task.enabled || task.frequency === 'manual') return undefined;
  const now = new Date(nowMs);

  if (task.frequency === 'hourly') {
    // On the task's MINUTE, every hour — so "hourly at :20" is stable rather
    // than drifting with whenever it was created.
    const candidate = new Date(now);
    candidate.setMinutes(task.minute, 0, 0);
    if (candidate.getTime() <= nowMs) candidate.setTime(candidate.getTime() + HOUR_MS);
    return candidate.getTime();
  }

  if (task.frequency === 'weekly') {
    for (let i = 0; i < 8; i++) {
      const day = new Date(nowMs + i * DAY_MS);
      if (day.getDay() !== task.weekday) continue;
      const at = atTime(day, task.hour, task.minute);
      if (at.getTime() > nowMs) return at.getTime();
    }
    return undefined;
  }

  // daily / weekdays: walk forward until a day qualifies and its time is future.
  for (let i = 0; i < 10; i++) {
    const day = new Date(nowMs + i * DAY_MS);
    if (task.frequency === 'weekdays' && !isWeekday(day)) continue;
    const at = atTime(day, task.hour, task.minute);
    if (at.getTime() > nowMs) return at.getTime();
  }
  return undefined;
}

/**
 * Which tasks are DUE right now.
 *
 * A task is due when its scheduled moment has passed and it has not already run
 * since then. The `lastRunAt` comparison is what stops a machine that was asleep
 * at 8am from firing the 8am task five times as the tick catches up — and what
 * stops it firing again on every 30-second tick for the rest of the day.
 *
 * `graceMs` bounds how stale a miss may be before it is written off: waking a
 * laptop on Friday should not run Monday's task.
 */
export function dueTasks(
  tasks: readonly ScheduledTask[],
  nowMs: number,
  globallyEnabled = true,
  graceMs = 6 * HOUR_MS,
): ScheduledTask[] {
  if (!globallyEnabled) return [];
  return tasks.filter((task) => {
    if (!task.enabled || task.frequency === 'manual') return false;
    // The most recent moment this task was supposed to fire, at or before now.
    const previous = previousRun(task, nowMs);
    if (previous === undefined) return false;
    if (nowMs - previous > graceMs) return false;
    return (task.lastRunAt ?? 0) < previous;
  });
}

/** The most recent scheduled moment at or before `nowMs`. */
export function previousRun(task: ScheduledTask, nowMs: number): number | undefined {
  if (task.frequency === 'manual') return undefined;

  if (task.frequency === 'hourly') {
    const candidate = new Date(nowMs);
    candidate.setMinutes(task.minute, 0, 0);
    if (candidate.getTime() > nowMs) candidate.setTime(candidate.getTime() - HOUR_MS);
    return candidate.getTime();
  }

  for (let i = 0; i < 10; i++) {
    const day = new Date(nowMs - i * DAY_MS);
    if (task.frequency === 'weekdays' && !isWeekday(day)) continue;
    if (task.frequency === 'weekly' && day.getDay() !== task.weekday) continue;
    const at = atTime(day, task.hour, task.minute);
    if (at.getTime() <= nowMs) return at.getTime();
  }
  return undefined;
}

/** "8:00 AM" — 12-hour, because that is how the schedule is spoken. */
export function formatTime(hour: number, minute: number): string {
  return formatClockTime(hour, minute);
}

/** The one-line schedule under a task's name — the shared words, so the
 *  harness tool reads a schedule back exactly as the screen prints it. */
export function describeSchedule(task: ScheduledTask): string {
  return describeScheduleWords(task);
}

/** "in 4h", "in 2 days", "now" — relative, for the next-run column. */
export function describeNextRun(nextMs: number | undefined, nowMs: number): string {
  if (nextMs === undefined) return '—';
  const delta = nextMs - nowMs;
  if (delta <= 0) return 'now';
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(delta / HOUR_MS);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(delta / DAY_MS);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

// ---------------------------------------------------------------------------
// Describe-it-in-words → a task
// ---------------------------------------------------------------------------

/**
 * Turn "every weekday at 9am, summarise what changed in the repo" into a task.
 *
 * the user asked for "somewhere here that just lets you prompt directly for a
 * scheduled task". This is the DETERMINISTIC half of that: it reads the timing
 * words, strips them, and leaves the rest as the prompt. It never guesses at
 * meaning — anything it cannot parse simply keeps the default (daily, 9am) and
 * the whole sentence stays as the prompt, so the dialog it prefills is a draft
 * the user confirms rather than an action taken behind their back.
 *
 * Doing it here rather than by asking the model matters: this runs as you type,
 * offline, in microseconds, and gives the same answer twice.
 */
export interface ParsedTaskDraft {
  readonly name: string;
  readonly prompt: string;
  readonly frequency: Frequency;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
  /**
   * WHAT WAS ACTUALLY READ, so a surface can tell a reading from a default.
   *
   * The parser always returns a full schedule — daily, 9:00 — because the
   * draft it feeds must be complete. But "eve" typed into the sentence box is
   * not "Every day at 9:00 AM", and a chip that presents the fallback with the
   * confidence of a reading spends the trust the live parse earns. `cadence`
   * is true once a frequency word was found; `time` once a clock time was
   * (or the cadence has no time of its own — hourly).
   */
  readonly read: { readonly cadence: boolean; readonly time: boolean };
}

const DAY_WORDS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

export function parseTaskDraft(input: string): ParsedTaskDraft {
  const text = input.trim();
  const lower = text.toLowerCase();

  let frequency: Frequency = 'daily';
  let weekday = 1;
  let hour = 9;
  let minute = 0;
  let readCadence = false;
  let readTime = false;
  const consumed: string[] = [];

  // --- day / cadence -------------------------------------------------------
  const weekdayMatch =
    /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(lower);
  if (/\bevery\s+hour\b|\bhourly\b/.test(lower)) {
    frequency = 'hourly';
    readCadence = true;
    consumed.push('every hour', 'hourly');
  } else if (/\bevery\s+weekday\b|\bweekdays?\b|\bevery\s+work(ing)?\s+day\b/.test(lower)) {
    frequency = 'weekdays';
    readCadence = true;
    consumed.push(
      'every weekday',
      'every weekdays',
      'weekdays',
      'weekday',
      'every working day',
      'every work day',
    );
  } else if (weekdayMatch !== null) {
    frequency = 'weekly';
    readCadence = true;
    weekday = DAY_WORDS[weekdayMatch[1] ?? ''] ?? 1;
    consumed.push(weekdayMatch[0]);
  } else if (/\bevery\s+week\b|\bweekly\b/.test(lower)) {
    frequency = 'weekly';
    readCadence = true;
    consumed.push('every week', 'weekly');
  } else if (/\bevery\s+day\b|\bdaily\b|\beach\s+day\b/.test(lower)) {
    frequency = 'daily';
    readCadence = true;
    consumed.push('every day', 'daily', 'each day');
  }

  // --- time of day ---------------------------------------------------------
  // "at 9", "at 9am", "at 9:30", "at 09:30", "at 5 pm"
  const timeMatch = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(lower);
  if (timeMatch !== null) {
    const raw = Number(timeMatch[1]);
    const mins = timeMatch[2] === undefined ? 0 : Number(timeMatch[2]);
    const meridiem = timeMatch[3];
    if (raw >= 0 && raw <= 23 && mins >= 0 && mins <= 59) {
      hour = meridiem === 'pm' ? (raw % 12) + 12 : meridiem === 'am' ? raw % 12 : raw;
      minute = mins;
      readTime = true;
      consumed.push(timeMatch[0]);
    }
  } else if (/\bnoon\b/.test(lower)) {
    hour = 12;
    minute = 0;
    readTime = true;
    consumed.push('noon');
  } else if (/\bmidnight\b/.test(lower)) {
    hour = 0;
    minute = 0;
    readTime = true;
    consumed.push('midnight');
  }
  // An hourly task has no time of day to be missing.
  if (frequency === 'hourly') readTime = true;

  // --- what is left is the instruction -------------------------------------
  let prompt = text;
  for (const phrase of consumed) {
    prompt = prompt.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'ig'), ' ');
  }
  prompt = prompt
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.\-—]+|[\s,;:.\-—]+$/g, '')
    .trim();
  if (prompt.length === 0) prompt = text;

  return {
    name: nameFrom(prompt),
    prompt,
    frequency,
    hour,
    minute,
    weekday,
    read: { cadence: readCadence, time: readTime },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Naming — one implementation for the screen, the scheduler and the harness
// tool (packages/shared/src/schedule-words.ts), re-exported here so the
// renderer keeps one import path for everything a task is called.
// ---------------------------------------------------------------------------

export { nameFrom, nameWasCut };

/** The earlier name for `nameFrom`, kept so nothing that imported it moves. */
export const titleFrom = nameFrom;
