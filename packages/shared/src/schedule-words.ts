/**
 * The WORDS of a scheduled task, shared by everything that names one or says
 * when it runs: the app's Scheduled screen, its scheduler, and the harness
 * tool a model calls from a chat. One implementation, so a task is called the
 * same thing and its schedule read back the same way wherever it was made —
 * the screen said "Every Friday at 4:00 PM" while the tool told the model
 * "every week (day 5) at 16:00", and the model quoted that to the person.
 *
 * Pure: no clock, no disk, no locale beyond the 12-hour clock the schedule is
 * spoken in.
 */

export type ScheduleFrequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly';

export interface ScheduleWordsInput {
  readonly frequency: ScheduleFrequency;
  /** Local hour 0-23 (ignored for 'hourly' and 'manual'). */
  readonly hour: number;
  /** Local minute 0-59. */
  readonly minute: number;
  /** 0=Sunday … 6=Saturday. Only meaningful for 'weekly'. */
  readonly weekday: number;
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** "8:00 AM" — 12-hour, because that is how the schedule is spoken. */
export function formatClockTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** The one-line schedule under a task's name: "Weekdays at 7:30 AM". */
export function describeScheduleWords(s: ScheduleWordsInput): string {
  switch (s.frequency) {
    case 'manual':
      return 'Only when you run it';
    case 'hourly':
      return `Every hour at :${String(s.minute).padStart(2, '0')}`;
    case 'daily':
      return `Every day at ${formatClockTime(s.hour, s.minute)}`;
    case 'weekdays':
      return `Weekdays at ${formatClockTime(s.hour, s.minute)}`;
    case 'weekly':
      return `Every ${WEEKDAY_NAMES[s.weekday] ?? 'week'} at ${formatClockTime(s.hour, s.minute)}`;
  }
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
 * An earlier namer took the first clause and kept six words, which named
 * "write up what I worked on this week" as "Write up what I worked on" — a
 * phrase cut mid-thought, and the name the list shows forever if the person
 * presses ↵ twice; another sliced at forty characters. This keeps a short
 * first clause WHOLE, cuts a long one at a conjunction before anything else,
 * and when it must cut by count, backs off dangling words so the name ends
 * on something that means something. Deterministic and instant; a guess a
 * person can correct is the right first answer. `nameWasCut` says when it
 * guessed, so an editor can say so.
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
