/**
 * The renderer's view of scheduled tasks and their run history.
 *
 * The RUN itself no longer happens here. It used to (a scheduled task started a
 * real chat), but the user: "a clean new temporary session that is started, conducts
 * and then is hidden/deleted" — so execution moved to MAIN, in a throwaway
 * bridge that never becomes a sidebar chat (scheduled-runner.ts). This store
 * only asks main to run (or stop), and reads back the run records for the page.
 */
import { create } from 'zustand';
import type {
  ScheduledTask,
  ScheduleState,
  TaskDraft,
  TaskRun,
} from '../../electron/scheduled/scheduled-contract';

interface TasksState {
  readonly enabled: boolean;
  readonly tasks: readonly ScheduledTask[];
  readonly loaded: boolean;
  /** Run records by task id, newest first. Loaded once per task, then followed live. */
  readonly runs: Readonly<Record<string, readonly TaskRun[]>>;
  load: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  create: (draft: TaskDraft) => Promise<ScheduledTask | null>;
  update: (id: string, patch: Partial<TaskDraft>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  /** End a task's live run (or drop its queued one). The record arrives as `stopped`. */
  stop: (id: string) => Promise<void>;
  loadRuns: (taskId: string) => Promise<void>;
  deleteRun: (taskId: string, runId: string) => Promise<void>;
}

function apply(set: (s: Partial<TasksState>) => void, state: ScheduleState): void {
  set({ enabled: state.enabled, tasks: state.tasks, loaded: true });
}

export const useTasksStore = create<TasksState>((set, get) => ({
  enabled: true,
  tasks: [],
  loaded: false,
  runs: {},

  load: async () => {
    const state = await window.piDesktop.invoke('tasks:get', undefined).catch(() => null);
    if (state !== null) apply(set, state);
  },

  setEnabled: async (enabled) => {
    set({ enabled }); // optimistic — the switch must never feel laggy
    const state = await window.piDesktop.invoke('tasks:set-enabled', { enabled }).catch(() => null);
    if (state !== null) apply(set, state);
  },

  create: async (draft) => {
    const res = await window.piDesktop.invoke('tasks:create', { task: draft }).catch(() => null);
    if (res === null) return null;
    apply(set, res.state);
    return res.task;
  },

  update: async (id, patch) => {
    const state = await window.piDesktop.invoke('tasks:update', { id, patch }).catch(() => null);
    if (state !== null) apply(set, state);
  },

  remove: async (id) => {
    const state = await window.piDesktop.invoke('tasks:delete', { id }).catch(() => null);
    if (state !== null) apply(set, state);
    // Drop its cached history too, so a re-created id can't inherit old runs.
    set({ runs: Object.fromEntries(Object.entries(get().runs).filter(([k]) => k !== id)) });
  },

  runNow: async (id) => {
    // Fire-and-forget: main queues it and streams progress via tasks:run-updated.
    await window.piDesktop.invoke('tasks:run-now', { id }).catch(() => undefined);
    await get().loadRuns(id);
  },

  stop: async (id) => {
    // The finalised record comes back through tasks:run-updated; the reload
    // is for the case where the event beat the invoke's return.
    await window.piDesktop.invoke('tasks:stop', { id }).catch(() => undefined);
    await get().loadRuns(id);
  },

  loadRuns: async (taskId) => {
    const res = await window.piDesktop.invoke('tasks:list-runs', { taskId }).catch(() => null);
    if (res !== null) set({ runs: { ...get().runs, [taskId]: res.runs } });
  },

  deleteRun: async (taskId, runId) => {
    await window.piDesktop.invoke('tasks:delete-run', { taskId, runId }).catch(() => undefined);
    await get().loadRuns(taskId);
  },
}));

/**
 * Wire the app-level listeners once. Main owns the clock and the runs; the store
 * only follows. A task created from a chat appears live (`tasks:changed`), and a
 * run's status updates in place (`tasks:run-updated`).
 */
export function startTaskRunner(): () => void {
  const offChanged = window.piDesktop.onEvent('tasks:changed', ({ state }) => {
    useTasksStore.setState({ enabled: state.enabled, tasks: state.tasks, loaded: true });
  });
  const offRun = window.piDesktop.onEvent('tasks:run-updated', ({ run }) => {
    const store = useTasksStore.getState();
    const existing = store.runs[run.taskId] ?? [];
    // Replace the record if we already have it, else prepend (newest first).
    const merged = existing.some((r) => r.id === run.id)
      ? existing.map((r) => (r.id === run.id ? run : r))
      : [run, ...existing];
    useTasksStore.setState({ runs: { ...store.runs, [run.taskId]: merged } });
  });
  return () => {
    offChanged();
    offRun();
  };
}
