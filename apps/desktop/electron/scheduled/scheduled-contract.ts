/**
 * The scheduled-tasks IPC surface. Kept beside the feature rather than in the
 * big contract file, like the other self-contained ones (settings, datasets).
 */
import type { ScheduledTask, ScheduleState } from './schedule-logic';

export type { Frequency, ScheduledTask, ScheduleState } from './schedule-logic';

/** Everything a caller may set. `id`, `createdAt` and `lastRunAt` are ours. */
export type TaskDraft = Omit<ScheduledTask, 'id' | 'createdAt' | 'lastRunAt'>;

/**
 * `stopped` is a run a person ended with Stop. It is neither a success nor a
 * failure — the task did not misbehave, someone wanted the model back — so it
 * counts in neither tally and draws in neither colour.
 */
export type RunStatus = 'running' | 'ok' | 'error' | 'stopped';

/** The model a run used, as the inference supervisor named it when the run started. */
export interface RunModel {
  readonly id: string;
  readonly displayName: string;
}

/** One file a run produced, for the past-runs view. */
export interface RunArtifact {
  /** Absolute path on disk. */
  readonly path: string;
  /** Basename, for display. */
  readonly name: string;
  readonly bytes: number;
  /** Coarse kind so the view knows whether to render it inline. */
  readonly kind: 'image' | 'video' | 'audio' | 'text' | 'other';
}

/**
 * A single execution of a scheduled task. This is the whole point of running in
 * a throwaway session: the run leaves no chat behind, so its record IS the only
 * trace, and the past-runs view reads these.
 */
export interface TaskRun {
  readonly id: string;
  readonly taskId: string;
  readonly startedAt: number;
  /**
   * What started it: the clock, or a person pressing Run now.
   *
   * Without this the history cannot say "ran an hour late, caught up after the
   * Mac woke" without also mislabelling every deliberate Run-now on a morning
   * task as late. Optional so runs recorded before it stay readable.
   */
  readonly trigger?: 'schedule' | 'manual';
  readonly finishedAt?: number;
  readonly status: RunStatus;
  /**
   * What ran it. Stamped from the loaded model when the run starts, and again
   * when it finishes if none was loaded at the start (the first run of the day
   * loads one). Absent on records from before this field, and on a run that
   * ended before any model came up — the surface says nothing rather than guess.
   */
  readonly model?: RunModel;
  /** The run's final assistant text — what it reports it did. */
  readonly summary: string;
  /** Tool names the run used, in order, for a compact "what it did" trail. */
  readonly toolCalls: readonly string[];
  readonly error?: string;
  /** Where the run happened; the folder to open to see everything it produced. */
  readonly cwd: string;
  readonly artifacts: readonly RunArtifact[];
}

export type ScheduledInvokeMap = {
  'tasks:get': { request: undefined; response: ScheduleState };
  /** The feature-wide switch. Tasks are kept, simply not fired. */
  'tasks:set-enabled': { request: { enabled: boolean }; response: ScheduleState };
  'tasks:create': {
    request: { task: TaskDraft };
    response: { state: ScheduleState; task: ScheduledTask };
  };
  'tasks:update': { request: { id: string; patch: Partial<TaskDraft> }; response: ScheduleState };
  'tasks:delete': { request: { id: string }; response: ScheduleState };
  /** Run a task now, headless, in main. Resolves when the run has been QUEUED,
   *  not when it finishes — progress arrives via `tasks:run-updated`. */
  'tasks:run-now': { request: { id: string }; response: { ok: boolean; runId?: string } };
  /**
   * Stop a task's run. The live run is ended and its record finalised as
   * `stopped` (the update arrives via `tasks:run-updated`); a run still waiting
   * in the queue is dropped before it starts. `ok: false` means nothing of that
   * task's was running or queued.
   */
  'tasks:stop': { request: { id: string }; response: { ok: boolean } };
  /** Past runs for one task, newest first. */
  'tasks:list-runs': { request: { taskId: string }; response: { runs: TaskRun[] } };
  'tasks:delete-run': { request: { taskId: string; runId: string }; response: { ok: boolean } };
};

export const SCHEDULED_INVOKE_CHANNELS = [
  'tasks:get',
  'tasks:set-enabled',
  'tasks:create',
  'tasks:update',
  'tasks:delete',
  'tasks:run-now',
  'tasks:stop',
  'tasks:list-runs',
  'tasks:delete-run',
] as const satisfies readonly (keyof ScheduledInvokeMap)[];

export type ScheduledEventMap = {
  /** The schedule file changed underneath us — usually `create_scheduled_task`
   *  writing from a chat. Carries the reloaded state so the list updates live. */
  'tasks:changed': { state: ScheduleState };
  /** A run started, progressed or finished. Carries the fresh record so the
   *  past-runs view (and the row's "running" state) update live. */
  'tasks:run-updated': { run: TaskRun };
};
