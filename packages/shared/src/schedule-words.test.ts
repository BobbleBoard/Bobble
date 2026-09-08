import { describe, expect, it } from 'vitest';
import { describeScheduleWords, formatClockTime, nameFrom, nameWasCut } from './schedule-words';

describe('describeScheduleWords', () => {
  it('reads every cadence back as a person would say it', () => {
    expect(describeScheduleWords({ frequency: 'weekly', hour: 16, minute: 0, weekday: 5 })).toBe(
      'Every Friday at 4:00 PM',
    );
    expect(describeScheduleWords({ frequency: 'weekdays', hour: 7, minute: 30, weekday: 1 })).toBe(
      'Weekdays at 7:30 AM',
    );
    expect(describeScheduleWords({ frequency: 'daily', hour: 0, minute: 5, weekday: 1 })).toBe(
      'Every day at 12:05 AM',
    );
    expect(describeScheduleWords({ frequency: 'hourly', hour: 9, minute: 20, weekday: 1 })).toBe(
      'Every hour at :20',
    );
    expect(describeScheduleWords({ frequency: 'manual', hour: 9, minute: 0, weekday: 1 })).toBe(
      'Only when you run it',
    );
  });

  it('speaks a 12-hour clock', () => {
    expect(formatClockTime(12, 0)).toBe('12:00 PM');
    expect(formatClockTime(0, 0)).toBe('12:00 AM');
    expect(formatClockTime(23, 59)).toBe('11:59 PM');
  });
});

describe('nameFrom', () => {
  it('keeps a short first clause whole', () => {
    expect(nameFrom('write up what I worked on this week')).toBe(
      'Write up what I worked on this week',
    );
    expect(nameWasCut('write up what I worked on this week')).toBe(false);
  });

  it('stops at the first sentence, colon, line or standalone comma clause', () => {
    expect(nameFrom('Run the test suite in my working folder. If anything fails, say so.')).toBe(
      'Run the test suite in my working folder',
    );
    expect(nameFrom('Summarise my week: what changed in my working folder')).toBe(
      'Summarise my week',
    );
    expect(nameFrom('Check disk space, then warn me')).toBe('Check disk space');
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
