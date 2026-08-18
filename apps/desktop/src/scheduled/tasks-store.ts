/**
 * The renderer's view of the scheduled-task list, plus the RUNNER.
 *
 * Main owns the clock and tells us what is due (`tasks:due`); running it happens
 * here because a run is a real chat — new session, working directory, model,
 * tools, a transcript you can open afterwards. See scheduled-main.ts for why
 * that is not done in main.
 */
import { create } from 'zustand';
import type {
  ScheduledTask,
  ScheduleState,
  TaskDraft,
} from '../../electron/scheduled/scheduled-contract';

interface TasksState {
  readonly enabled: boolean;
  readonly tasks: readonly ScheduledTask[];
  readonly loaded: boolean;
  /** Task ids currently being dispatched, so a double-click cannot double-run. */
  readonly running: readonly string[];
  load: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  create: (draft: TaskDraft) => Promise<ScheduledTask | null>;
  update: (id: string, patch: Partial<TaskDraft>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
}

function apply(set: (s: Partial<TasksState>) => void, state: ScheduleState): void {
  set({ enabled: state.enabled, tasks: state.tasks, loaded: true });
}

/**
 * Start a task as a chat.
 *
 * The same four steps a person takes: pick the folder, open a new chat, name it,
 * type the thing. Going through the app's own helpers rather than raw IPC is
 * what makes a scheduled run indistinguishable from a manual one — same
 * workspace resolution, same session capture, same canvas reset, same unread
 * dot when it finishes.
 */
async function dispatch(task: ScheduledTask): Promise<boolean> {
  try {
    const { applyWorkspace, newSession, sendPrompt, setSessionName } = await import(
      '../state/pi-connect'
    );
    const started = await newSession();
    if (!started.ok || started.cancelled === true) return false;
    if (task.cwd !== undefined && task.cwd.trim() !== '') await applyWorkspace(task.cwd);
    await setSessionName(task.name);
    await sendPrompt(task.prompt);
    return true;
  } catch {
    return false;
  }
}

export const useTasksStore = create<TasksState>((set, get) => ({
  enabled: true,
  tasks: [],
  loaded: false,
  running: [],

  load: async () => {
    const state = await window.piDesktop.invoke('tasks:get', undefined).catch(() => null);
    if (state !== null) apply(set, state);
  },

  setEnabled: async (enabled) => {
    // Optimistic: the switch is the one control that must never feel laggy.
    set({ enabled });
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
  },

  runNow: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (task === undefined || get().running.includes(id)) return;
    set({ running: [...get().running, id] });
    try {
      const ok = await dispatch(task);
      /* Stamp only on a run that actually STARTED. Marking it on dispatch would
         let a failed launch count as "done" and silence the task until its next
         slot — the opposite of what you want from a task that just broke. */
      if (ok) {
        const state = await window.piDesktop
          .invoke('tasks:mark-ran', { id, whenMs: Date.now() })
          .catch(() => null);
        if (state !== null) apply(set, state);
      }
    } finally {
      set({ running: get().running.filter((x) => x !== id) });
    }
  },
}));

/**
 * Wire the due-task event once, at app start. Runs are serialised: two models
 * loading at once on a 24GB machine is how you turn a scheduled task into a
 * swap storm.
 */
export function startTaskRunner(): () => void {
  let chain: Promise<void> = Promise.resolve();
  const offDue = window.piDesktop.onEvent('tasks:due', ({ tasks }) => {
    for (const task of tasks) {
      chain = chain.then(() => useTasksStore.getState().runNow(task.id));
    }
  });
  /* A task the model just created should appear in the list while the user is
     still reading the message that says it did. */
  const offChanged = window.piDesktop.onEvent('tasks:changed', ({ state }) => {
    useTasksStore.setState({ enabled: state.enabled, tasks: state.tasks, loaded: true });
  });
  return () => {
    offDue();
    offChanged();
  };
}
