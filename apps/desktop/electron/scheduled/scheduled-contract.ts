/**
 * The scheduled-tasks IPC surface. Kept beside the feature rather than in the
 * big contract file, like the other self-contained ones (settings, datasets).
 */
import type { ScheduledTask, ScheduleState } from './schedule-logic';

export type { Frequency, ScheduledTask, ScheduleState } from './schedule-logic';

/** Everything a caller may set. `id`, `createdAt` and `lastRunAt` are ours. */
export type TaskDraft = Omit<ScheduledTask, 'id' | 'createdAt' | 'lastRunAt'>;

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
  /** Stamped by the renderer once a run has actually STARTED — see scheduled-main. */
  'tasks:mark-ran': { request: { id: string; whenMs?: number }; response: ScheduleState };
};

export const SCHEDULED_INVOKE_CHANNELS = [
  'tasks:get',
  'tasks:set-enabled',
  'tasks:create',
  'tasks:update',
  'tasks:delete',
  'tasks:mark-ran',
] as const satisfies readonly (keyof ScheduledInvokeMap)[];

export type ScheduledEventMap = {
  /** Main found tasks whose moment has passed; the renderer runs them. */
  'tasks:due': { tasks: ScheduledTask[]; nowMs: number };
  /** The schedule file changed underneath us — usually `create_scheduled_task`
   *  writing from a chat. Carries the reloaded state so the list updates live. */
  'tasks:changed': { state: ScheduleState };
};
