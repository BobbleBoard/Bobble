/**
 * Starter tasks, offered when the list is empty.
 *
 * Each is written as an instruction that ends in something READABLE — the value
 * of an unattended run is what you find waiting for you.
 *
 * THE PERSONAL ONES USED TO BE ABSENT, and the reason written here was that
 * offering "summarise my unread emails" would advertise a capability the app did
 * not have. It has it: Calendar, Mail, Reminders, Contacts and Messages ship as
 * the `personal` capability. So the briefs are here now, and the note stays as a
 * reminder of the rule that produced it — never offer a template for something
 * the app cannot do.
 *
 * AND THE PRIVACY CLAIM IS THE PRODUCT, so it is said out loud in the blurbs.
 * A cloud assistant reading your mail at 07:30 means your mail leaves your
 * machine. This one does not: the model runs locally, the connectors are
 * AppleScript and sqlite against your own apps, and nothing is uploaded.
 *
 * NOTHING GOES OUT. A scheduled run cannot call `messages_send` — the harness
 * blocks it at `tool_call` for every unattended run (permissions/forbidden.ts),
 * not merely by asking nicely in the prompt. That is what makes "draft replies"
 * a safe thing to offer.
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
    id: 'morning-brief',
    icon: '☀',
    name: 'Morning brief',
    blurb:
      "Your day, before you start it: today's events, what arrived overnight, what is due. " +
      'Runs on your Mac. Nothing leaves it.',
    prompt:
      'Turn on the "personal" capability, then write me a short brief for today.\n\n' +
      'Cover, in this order: what is on my calendar today (times and titles); any mail that arrived ' +
      'since yesterday evening that looks like it needs me, with who it is from and one line on why; ' +
      'and reminders due today or overdue.\n\n' +
      'Be brief and specific. No preamble, no "here is your brief". If a section has nothing in it, ' +
      'say so in one line rather than padding. If you cannot reach Calendar, Mail or Reminders, say ' +
      'which one and stop; do not guess.',
    frequency: 'weekdays',
    hour: 7,
    minute: 30,
    weekday: 1,
  },
  {
    id: 'what-did-i-miss',
    icon: '⟲',
    name: 'What did I miss',
    blurb:
      'An end-of-day catch-up on mail and messages you did not get to. Reads locally; sends nothing.',
    prompt:
      'Turn on the "personal" capability, then tell me what I missed today.\n\n' +
      'Look at mail and messages from the last day. Group them into: needs a reply, worth knowing, ' +
      'and ignorable. For anything in the first group, say who it is from and what they want in one ' +
      'line. Do not reply to anything.\n\n' +
      'If a source is unreachable, name it and carry on with the rest.',
    frequency: 'weekdays',
    hour: 18,
    minute: 30,
    weekday: 1,
  },
  {
    id: 'draft-replies',
    icon: '✎',
    name: 'Draft replies, do not send',
    blurb: 'Reads what is waiting and writes the replies for you to review. It cannot send them.',
    prompt:
      'Turn on the "personal" capability. Find mail and messages from the last day that are waiting ' +
      'on a reply from me.\n\n' +
      'For each one, write the reply I would send: my voice, short, specific, no filler. Put each ' +
      'draft under a heading naming who it is to and what it is about.\n\n' +
      'DO NOT SEND ANYTHING. These are drafts for me to read and send myself.',
    frequency: 'weekdays',
    hour: 8,
    minute: 0,
    weekday: 1,
  },
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
    blurb: 'Tidy a folder you dump things into: rename, group, summarise.',
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
