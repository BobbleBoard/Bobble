/**
 * The scheduling rules, against a fixed clock. These are the tests worth having:
 * every one of them is a case where a plausible implementation fires a task at
 * the wrong time, twice, or never.
 */
import { describe, expect, it } from 'vitest';
import {
  describeNextRun,
  describeSchedule,
  dueTasks,
  formatTime,
  nameFrom,
  nameWasCut,
  nextRun,
  normalizeTask,
  parseTaskDraft,
  previousRun,
  type ScheduledTask,
} from './schedule-logic';

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  normalizeTask({
    id: 't1',
    name: 'Task',
    prompt: 'do the thing',
    frequency: 'daily',
    hour: 9,
    minute: 0,
    weekday: 1,
    enabled: true,
    createdAt: 0,
    ...over,
  });

/** 2026-08-18 is a Tuesday. Local time, like the scheduler. */
const tue = (h: number, m = 0) => new Date(2026, 7, 18, h, m, 0, 0).getTime();
const sat = (h: number, m = 0) => new Date(2026, 7, 22, h, m, 0, 0).getTime();

describe('nextRun', () => {
  it('is later today when the time has not passed', () => {
    expect(nextRun(task({ hour: 17 }), tue(9))).toBe(tue(17));
  });

  it('rolls to tomorrow once today has passed', () => {
    const next = nextRun(task({ hour: 9 }), tue(10));
    expect(new Date(next ?? 0).getDate()).toBe(19);
  });

  it('skips the weekend for a weekdays task', () => {
    // Saturday 10:00 -> Monday, not Sunday.
    const next = nextRun(task({ frequency: 'weekdays', hour: 8 }), sat(10));
    expect(new Date(next ?? 0).getDay()).toBe(1);
  });

  it('lands on the chosen day for a weekly task', () => {
    const next = nextRun(task({ frequency: 'weekly', weekday: 5, hour: 16 }), tue(9));
    expect(new Date(next ?? 0).getDay()).toBe(5);
  });

  it('keeps hourly on its minute rather than drifting from creation', () => {
    const next = nextRun(task({ frequency: 'hourly', minute: 20 }), tue(9, 35));
    expect(new Date(next ?? 0).getHours()).toBe(10);
    expect(new Date(next ?? 0).getMinutes()).toBe(20);
  });

  it('has no next run when it is manual, disabled, or the feature is off', () => {
    expect(nextRun(task({ frequency: 'manual' }), tue(9))).toBeUndefined();
    expect(nextRun(task({ enabled: false }), tue(9))).toBeUndefined();
    expect(nextRun(task(), tue(9), false)).toBeUndefined();
  });
});

describe('dueTasks', () => {
  it('fires a task whose moment has passed', () => {
    const t = task({ hour: 8 });
    expect(dueTasks([t], tue(8, 5)).map((x) => x.id)).toEqual(['t1']);
  });

  it('does NOT fire again once it has run — the tick is every 30 seconds', () => {
    // Without the lastRunAt comparison this fires ~120 times an hour.
    const t = task({ hour: 8, lastRunAt: tue(8, 1) });
    expect(dueTasks([t], tue(8, 5))).toEqual([]);
  });

  it('does not fire five times for one missed morning', () => {
    // A machine asleep at 08:00 wakes at 09:00: one run, then quiet.
    const t = task({ hour: 8 });
    const first = dueTasks([t], tue(9));
    expect(first).toHaveLength(1);
    const after = { ...t, lastRunAt: tue(9) };
    expect(dueTasks([after], tue(9, 1))).toEqual([]);
  });

  it('writes off a miss that is too stale to be worth running', () => {
    // Waking on Friday should not run Monday's task.
    const t = task({ hour: 8 });
    expect(dueTasks([t], tue(20))).toEqual([]);
  });

  it('the global switch stops everything without touching the tasks', () => {
    const t = task({ hour: 8 });
    expect(dueTasks([t], tue(8, 5), false)).toEqual([]);
    expect(dueTasks([t], tue(8, 5), true)).toHaveLength(1);
  });

  it('a weekdays task is not due on a Saturday', () => {
    const t = task({ frequency: 'weekdays', hour: 8 });
    expect(dueTasks([t], sat(8, 5))).toEqual([]);
  });
});

describe('previousRun', () => {
  it('looks back past the weekend for a weekdays task', () => {
    // Saturday 10:00 -> Friday's slot, not "yesterday".
    const prev = previousRun(task({ frequency: 'weekdays', hour: 8 }), sat(10));
    expect(new Date(prev ?? 0).getDay()).toBe(5);
  });
});

describe('the wording', () => {
  it('renders the schedule the way it is spoken', () => {
    expect(describeSchedule(task({ frequency: 'weekdays', hour: 8 }))).toBe('Weekdays at 8:00 AM');
    expect(describeSchedule(task({ frequency: 'weekly', weekday: 5, hour: 16 }))).toBe(
      'Every Friday at 4:00 PM',
    );
    expect(describeSchedule(task({ frequency: 'manual' }))).toBe('Only when you run it');
    expect(describeSchedule(task({ frequency: 'hourly', minute: 5 }))).toBe('Every hour at :05');
  });

  it('formats noon and midnight without saying 0:00', () => {
    expect(formatTime(12, 0)).toBe('12:00 PM');
    expect(formatTime(0, 0)).toBe('12:00 AM');
    expect(formatTime(13, 30)).toBe('1:30 PM');
  });

  it('describes the wait, not a timestamp', () => {
    expect(describeNextRun(undefined, tue(9))).toBe('—');
    expect(describeNextRun(tue(9, 30), tue(9))).toBe('in 30m');
    expect(describeNextRun(tue(13), tue(9))).toBe('in 4h');
    expect(describeNextRun(tue(9) + 86_400_000, tue(9))).toBe('tomorrow');
  });
});

describe('parseTaskDraft', () => {
  it('reads the cadence and the time, and keeps the rest as the instruction', () => {
    const d = parseTaskDraft('every weekday at 9am summarise what changed in the repo');
    expect(d.frequency).toBe('weekdays');
    expect(d.hour).toBe(9);
    expect(d.prompt).toBe('summarise what changed in the repo');
  });

  it('handles pm, minutes, and a named day', () => {
    const d = parseTaskDraft('every friday at 4:30pm run the full test suite');
    expect(d.frequency).toBe('weekly');
    expect(d.weekday).toBe(5);
    expect(d.hour).toBe(16);
    expect(d.minute).toBe(30);
    expect(d.prompt).toBe('run the full test suite');
  });

  it('understands noon and midnight', () => {
    expect(parseTaskDraft('every day at noon check disk space').hour).toBe(12);
    expect(parseTaskDraft('daily at midnight rotate the logs').hour).toBe(0);
  });

  it('keeps the whole sentence when there is no timing to find', () => {
    // A draft the user confirms — never a guess acted on silently.
    const d = parseTaskDraft('check for dependency updates');
    expect(d.prompt).toBe('check for dependency updates');
    expect(d.frequency).toBe('daily');
    expect(d.hour).toBe(9);
  });

  it('never leaves an empty prompt, even if the input was only timing', () => {
    const d = parseTaskDraft('every weekday at 9am');
    expect(d.prompt.length).toBeGreaterThan(0);
  });

  it('titles the task from its first clause, not the whole paragraph', () => {
    const d = parseTaskDraft('run the test suite, then post the failures somewhere useful');
    expect(d.name).toBe('Run the test suite');
  });

  it('12am is midnight and 12pm is noon', () => {
    expect(parseTaskDraft('daily at 12am do a thing').hour).toBe(0);
    expect(parseTaskDraft('daily at 12pm do a thing').hour).toBe(12);
  });

  it('says what it read, so a default is never shown as a reading', () => {
    // "eve" is not "Every day at 9:00 AM"; the surface must be able to tell.
    expect(parseTaskDraft('eve').read).toEqual({ cadence: false, time: false });
    expect(parseTaskDraft('every friday write it up').read).toEqual({
      cadence: true,
      time: false,
    });
    expect(parseTaskDraft('at 4pm write it up').read).toEqual({ cadence: false, time: true });
    expect(parseTaskDraft('every friday at 4pm write it up').read).toEqual({
      cadence: true,
      time: true,
    });
    // An hourly task has no time of day to be missing.
    expect(parseTaskDraft('every hour check the queue').read).toEqual({
      cadence: true,
      time: true,
    });
    expect(parseTaskDraft('at noon stretch').read.time).toBe(true);
  });
});

describe('nameFrom', () => {
  it('keeps a short first clause whole', () => {
    expect(nameFrom('write up what I worked on this week')).toBe(
      'Write up what I worked on this week',
    );
    expect(nameFrom('summarise what changed in my working folder')).toBe(
      'Summarise what changed in my working folder',
    );
    expect(nameWasCut('write up what I worked on this week')).toBe(false);
  });

  it('stops at the first sentence, colon or line', () => {
    expect(nameFrom('Run the test suite in my working folder. If anything fails, say so.')).toBe(
      'Run the test suite in my working folder',
    );
    expect(nameFrom('Summarise my week: what changed in my working folder')).toBe(
      'Summarise my week',
    );
  });

  it('cuts a long clause at a conjunction before anything else', () => {
    expect(
      nameFrom('Check my working folder for outdated dependencies and known advisories.'),
    ).toBe('Check my working folder for outdated dependencies');
  });

  it('never ends on a dangling word when it must cut by count', () => {
    expect(nameFrom('Look at the git history in my working folder for the last 24 hours.')).toBe(
      'Look at the git history',
    );
    expect(nameWasCut('Look at the git history in my working folder for the last 24 hours.')).toBe(
      true,
    );
  });

  it('drops a lead-in and never returns nothing', () => {
    expect(nameFrom('please remind me to stretch')).toBe('Remind me to stretch');
    expect(nameFrom('   ')).toBe('Scheduled task');
  });
});

describe('normalizeTask', () => {
  it('repairs anything unreasonable read off disk', () => {
    const t = normalizeTask({
      id: 'x',
      hour: 99,
      minute: -4,
      weekday: 12,
      frequency: 'yearly' as never,
    });
    expect(t.hour).toBe(23);
    expect(t.minute).toBe(0);
    expect(t.weekday).toBe(6);
    expect(t.frequency).toBe('daily');
    expect(t.name).toBe('Untitled task');
  });

  it('treats a missing enabled flag as ON, not OFF', () => {
    // A task read from an older file must not silently stop running.
    expect(normalizeTask({ id: 'x' }).enabled).toBe(true);
    expect(normalizeTask({ id: 'x', enabled: false }).enabled).toBe(false);
  });
});
