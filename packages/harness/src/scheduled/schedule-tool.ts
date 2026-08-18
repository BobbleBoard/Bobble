/**
 * `create_scheduled_task` — the model's way to set up recurring work from inside
 * a conversation, so "do this every morning" becomes a task instead of a promise
 * it cannot keep.
 *
 * WHY IT WRITES A FILE RATHER THAN CALLING THE APP.
 * The other app-backed tool (`spawn_subagent`) needs a live round trip: it hands
 * work over and waits for a result. This one only needs to record an intention,
 * and the app already owns `~/.pi/desktop/scheduled-tasks.json` as the single
 * source of truth for the schedule. Appending to that file is enough, and it
 * buys something a socket would not: ANY harness — pi, Codex, Hermes, a custom
 * config — can create tasks with no bridge of its own, which is the point of
 * making the harness swappable.
 *
 * The record written here is deliberately loose. The app normalises everything
 * it reads (clamping hours, defaulting a bad frequency, naming the unnamed), so
 * a model that gets a field slightly wrong produces a sane task rather than a
 * broken one or a rejected call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';

export const CREATE_SCHEDULED_TASK_TOOL_NAME = 'create_scheduled_task';

const STORE_PATH = path.join(os.homedir(), '.pi', 'desktop', 'scheduled-tasks.json');

const FREQUENCIES = ['manual', 'hourly', 'daily', 'weekdays', 'weekly'] as const;

const ScheduleParams = Type.Object({
  name: Type.String({
    description:
      'Short name for the task, as it will appear in the list (e.g. "Morning test run").',
  }),
  prompt: Type.String({
    description:
      'What to do when it runs, written as an instruction to yourself in a fresh chat. It must ' +
      'stand alone: the run cannot see this conversation.',
  }),
  frequency: Type.Union(
    FREQUENCIES.map((f) => Type.Literal(f)),
    {
      description:
        'How often. "manual" creates it without a schedule, for the user to run by hand.',
    },
  ),
  hour: Type.Optional(
    Type.Number({ minimum: 0, maximum: 23, description: 'Local hour, 0-23 (default 9).' }),
  ),
  minute: Type.Optional(
    Type.Number({ minimum: 0, maximum: 59, description: 'Local minute (default 0).' }),
  ),
  weekday: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 6,
      description: 'For "weekly": 0=Sunday … 6=Saturday (default Monday).',
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'Working folder for the run. Defaults to the app default.' }),
  ),
});

type ScheduleInput = Static<typeof ScheduleParams>;

/** One details shape for every return, so the tool's result type is stable. */
interface ScheduleDetails {
  readonly ok: boolean;
  readonly id: string;
  readonly frequency: string;
}

interface StoredDoc {
  enabled?: boolean;
  tasks?: unknown[];
}

function readDoc(): StoredDoc {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoredDoc;
  } catch {
    return {};
  }
}

/** Shared so every branch reports the same shape (TDetails is inferred once). */
const FAILED: ScheduleDetails = { ok: false, id: '', frequency: '' };

export function registerScheduledTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: CREATE_SCHEDULED_TASK_TOOL_NAME,
    label: 'Create Scheduled Task',
    description:
      'Save a recurring task that runs on its own in a fresh chat — daily, on weekdays, weekly, ' +
      'hourly, or only when the user runs it by hand. Use this when the user asks for something ' +
      'to happen regularly or later ("every morning…", "each Friday…"), rather than agreeing to ' +
      'do it and forgetting. The task appears in Scheduled tasks where they can edit, pause or ' +
      'delete it.',
    promptSnippet: 'create_scheduled_task: save recurring work that runs by itself on a schedule.',
    promptGuidelines: [
      'Use it when the user describes work that repeats or should happen later, not for anything you can just do now.',
      'The prompt must be self-contained — a scheduled run starts a fresh chat and cannot see this conversation.',
      'Tell the user what you scheduled and when, so they can correct it.',
    ],
    parameters: ScheduleParams,
    async execute(_toolCallId, params: ScheduleInput) {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
      if (prompt.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No task created: `prompt` was empty. Say what the task should DO when it runs.',
            },
          ],
          isError: true,
          details: FAILED,
        };
      }

      const task = {
        id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name:
          name.length > 0 ? name : (prompt.split(/[.,\n]/)[0]?.slice(0, 40) ?? 'Scheduled task'),
        prompt,
        frequency: params.frequency,
        hour: params.hour ?? 9,
        minute: params.minute ?? 0,
        weekday: params.weekday ?? 1,
        enabled: true,
        createdAt: Date.now(),
        ...(typeof params.cwd === 'string' && params.cwd.trim() !== ''
          ? { cwd: params.cwd.trim() }
          : {}),
      };

      const ok: ScheduleDetails = { ok: true, id: task.id, frequency: task.frequency };
      const doc = readDoc();
      const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
      const next = { enabled: doc.enabled !== false, tasks: [...tasks, task] };
      try {
        fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
        fs.writeFileSync(STORE_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not save the task: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
          details: FAILED,
        };
      }

      /* Say what was actually recorded, including the defaults that were filled
         in — the user is about to be told, and a summary that omits "at 9am"
         invites them to discover it at 9am. */
      const when =
        task.frequency === 'manual'
          ? 'only when they run it'
          : task.frequency === 'hourly'
            ? `every hour at :${String(task.minute).padStart(2, '0')}`
            : `${task.frequency === 'weekdays' ? 'weekdays' : task.frequency === 'weekly' ? `every week (day ${task.weekday})` : 'every day'} at ${String(task.hour).padStart(2, '0')}:${String(task.minute).padStart(2, '0')}`;
      const off = next.enabled
        ? ''
        : ' NOTE: scheduling is currently switched off in the app, so it will not fire until that is turned back on.';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Scheduled "${task.name}" — runs ${when}.${off} It is in Scheduled tasks, where it can be edited, paused or deleted.`,
          },
        ],
        isError: false,
        details: ok,
      };
    },
  });
}
