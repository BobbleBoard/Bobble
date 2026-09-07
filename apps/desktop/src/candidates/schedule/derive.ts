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
 * a real run.
 */
import {
  describeSchedule,
  formatTime,
  nextRun,
  previousRun,
  type ScheduledTask,
} from '../../../electron/scheduled/schedule-logic';
import type { TaskRun } from '../../../electron/scheduled/scheduled-contract';

/** Mirrors dueTasks' default: a miss older than this is written off, not caught up. */
export const GRACE_MS = 6 * 3_600_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type TaskState =
  | { readonly kind: 'running'; readonly run: TaskRun }
  | { readonly kind: 'off' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'manual' }
  /** Its slot passed, it has not run, and the scheduler will still catch it up. */
  | { readonly kind: 'due'; readonly slotAt: number }
  /** Its slot passed while Bobble was not running, and the grace ran out. */
  | { readonly kind: 'missed'; readonly slotAt: number; readonly nextAt: number }
  | { readonly kind: 'scheduled'; readonly nextAt: number };

export function taskState(
  task: ScheduledTask,
  runs: readonly TaskRun[] | undefined,
  now: number,
  globallyEnabled: boolean,
): TaskState {
  const newest = runs?.[0];
  if (newest?.status === 'running') return { kind: 'running', run: newest };
  if (!globallyEnabled) return { kind: 'off' };
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

/** "7:30 AM" today, "Tomorrow 7:30 AM", "Fri 4:00 PM", "12 Sep 9:00 AM". */
export function describeMoment(ms: number, now: number): string {
  const d = new Date(ms);
  const time = formatTime(d.getHours(), d.getMinutes());
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayIndex = Math.floor((ms - dayStart.getTime()) / DAY);
  if (dayIndex === 0) return `Today ${time}`;
  if (dayIndex === 1) return `Tomorrow ${time}`;
  if (dayIndex === -1) return `Yesterday ${time}`;
  if (dayIndex > 1 && dayIndex < 7) return `${WEEKDAY_SHORT[d.getDay()]} ${time}`;
  return `${d.getDate()} ${d.toLocaleString([], { month: 'short' })} ${time}`;
}

/**
 * "in 4h 12m" / "in 2 days" / "3h ago". A countdown keeps its minutes because
 * people wait for it; the past is coarse because nobody needs "17h 28m ago".
 */
export function describeDelta(ms: number, now: number): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  const suffix = (s: string) => (delta >= 0 ? `in ${s}` : `${s} ago`);
  if (abs < MIN) return delta >= 0 ? 'now' : 'just now';
  if (abs < HOUR) return suffix(`${Math.round(abs / MIN)}m`);
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs - h * HOUR) / MIN);
    return suffix(delta < 0 || m === 0 ? `${Math.round(abs / HOUR)}h` : `${h}h ${m}m`);
  }
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

/** Group heading a task belongs under in a time-ordered agenda. */
export type AgendaBucket = 'now' | 'today' | 'tomorrow' | 'week' | 'later' | 'manual' | 'paused';

export function agendaBucket(state: TaskState, now: number): AgendaBucket {
  switch (state.kind) {
    case 'running':
    case 'due':
      return 'now';
    case 'paused':
    case 'off':
      return 'paused';
    case 'manual':
      return 'manual';
    case 'missed':
    case 'scheduled': {
      const at = state.kind === 'missed' ? state.nextAt : state.nextAt;
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const dayIndex = Math.floor((at - dayStart.getTime()) / DAY);
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
  manual: 'Only when you run them',
  paused: 'Paused',
};

/** The seven-day dot strip: does this task fire on each of the next 7 days? */
export function weekPattern(task: ScheduledTask, now: number): readonly boolean[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start.getTime() + i * DAY).getDay();
    switch (task.frequency) {
      case 'manual':
        return false;
      case 'hourly':
      case 'daily':
        return true;
      case 'weekdays':
        return day >= 1 && day <= 5;
      case 'weekly':
        return day === task.weekday;
      default:
        return false;
    }
  });
}

export function weekLabels(now: number): readonly string[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getTime() + i * DAY);
    return WEEKDAY_SHORT[d.getDay()]?.charAt(0) ?? '';
  });
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

/** What the task actually reached, from the tool trail of its runs. Real, not guessed. */
export function reachFromRuns(runs: readonly TaskRun[] | undefined): readonly Reach[] {
  const seen = new Map<string, Reach>();
  for (const run of runs ?? []) {
    for (const tool of run.toolCalls) {
      const hit = REACH_RULES.find(([re]) => re.test(tool));
      if (hit !== undefined && !seen.has(hit[1].id)) seen.set(hit[1].id, hit[1]);
    }
  }
  return [...seen.values()];
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

export { describeSchedule, formatTime };
