/**
 * Starter tasks, offered when the list is empty.
 *
 * DELIBERATELY NOT THE REFERENCE'S SET. Claude's templates are calendar, inbox
 * and industry-news shaped, because that app is wired to a calendar and a
 * mailbox. Bobble is a local agent with a shell, a filesystem and a working
 * directory — offering "summarise my unread emails" here would advertise a
 * capability the app does not have, which is worse than offering nothing.
 *
 * So these are the things a local agent can actually do unattended, and each one
 * is written as an instruction that ends in something readable — the value of an
 * unattended run is what you find waiting for you.
 */
import type { Frequency } from '../../electron/scheduled/schedule-logic';

export interface TaskTemplate {
  readonly id: string;
  readonly icon: string;
  readonly name: string;
  readonly blurb: string;
  readonly prompt: string;
  readonly frequency: Frequency;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 'repo-digest',
    icon: '◷',
    name: 'What changed today',
    blurb: "Read the day's commits and diffs in your working folder and summarise them.",
    prompt:
      'Look at the git history in my working folder for the last 24 hours. Summarise what changed, ' +
      'grouped by area, and call out anything that looks risky or unfinished.',
    frequency: 'weekdays',
    hour: 18,
    minute: 0,
    weekday: 1,
  },
  {
    id: 'test-run',
    icon: '✓',
    name: 'Run the tests',
    blurb: 'Run the test suite and report only what failed, with the failing output.',
    prompt:
      'Run the test suite in my working folder. If everything passes, say so in one line. ' +
      'If anything fails, show the failing test names and the relevant output, and say what you think broke.',
    frequency: 'daily',
    hour: 7,
    minute: 30,
    weekday: 1,
  },
  {
    id: 'deps',
    icon: '↑',
    name: 'Dependency check',
    blurb: 'Look for outdated or vulnerable dependencies and say which are worth doing.',
    prompt:
      'Check my working folder for outdated dependencies and known advisories. ' +
      'List what is worth updating and what would be risky, with a one-line reason each. Do not change anything.',
    frequency: 'weekly',
    hour: 9,
    minute: 0,
    weekday: 1,
  },
  {
    id: 'inbox-folder',
    icon: '⇢',
    name: 'Sort a drop folder',
    blurb: 'Tidy a folder you dump things into — rename, group, and summarise what arrived.',
    prompt:
      'Look at ~/Downloads. Summarise what has arrived since yesterday, group it by kind, ' +
      'and suggest a tidy-up. List the moves you would make before making any of them.',
    frequency: 'daily',
    hour: 19,
    minute: 0,
    weekday: 1,
  },
  {
    id: 'watch-topic',
    icon: '◎',
    name: 'Watch a topic',
    blurb: 'Search the web for news on something you care about and summarise what is new.',
    prompt:
      'Search the web for anything new in the last day about <topic>. ' +
      'Summarise what actually changed, skip the reposts, and link the sources.',
    frequency: 'daily',
    hour: 9,
    minute: 0,
    weekday: 1,
  },
  {
    id: 'weekly-review',
    icon: '☰',
    name: 'Weekly review',
    blurb: 'A Friday summary of the week across your working folder and chats.',
    prompt:
      'Summarise my week: what changed in my working folder, what I was working on across my chats, ' +
      'and what is still open. Keep it short and specific.',
    frequency: 'weekly',
    hour: 16,
    minute: 0,
    weekday: 5,
  },
];
