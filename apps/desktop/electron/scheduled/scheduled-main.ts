/**
 * SCHEDULED TASKS — storage and the clock.
 *
 * Owns `~/.pi/desktop/scheduled-tasks.json` and a 30-second tick. All of the
 * WHEN lives in schedule-logic.ts; this file is the part that has to touch disk
 * and the wall clock.
 *
 * WHY MAIN HOLDS THE CLOCK BUT NOT THE RUN. A task fires by starting a real
 * chat — a session with a working directory, a model, tools, a transcript you
 * can open afterwards and a notification when it finishes. All of that already
 * exists in the renderer's session machinery, and rebuilding a headless copy of
 * it in main would mean two agents with different capabilities and one of them
 * invisible. So main decides WHAT is due and emits `tasks:due`; the renderer
 * runs it exactly as if you had typed it.
 *
 * The single-window app means the renderer is always there to receive it. If it
 * ever is not, nothing is lost: `lastRunAt` is only stamped once a run actually
 * starts, so the task stays due and fires when the window comes back — within
 * the staleness grace, which is the whole point of that bound.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PiBridgeEvent } from '@pi-desktop/engine';
import {
  createIpcEventSender,
  createLogger,
  type IpcHandlers,
  registerIpcHandlers,
} from '@pi-desktop/shared';
import type { BrowserWindow, IpcMain } from 'electron';
import {
  dueTasks,
  EMPTY_SCHEDULE,
  normalizeTask,
  type ScheduledTask,
  type ScheduleState,
} from './schedule-logic';
import type { ScheduledEventMap, ScheduledInvokeMap, TaskRun } from './scheduled-contract';
import { createScheduledRunner, type RunBridge, type ScheduledRunner } from './scheduled-runner';

const log = createLogger('desktop:scheduled');

/*
 * Events travel as ENVELOPES on one wire channel — the renderer's hub fans them
 * out by name. A raw `webContents.send('tasks:due', …)` reaches the preload's
 * ipcRenderer, matches nothing, and is silently dropped: the schedule ticked,
 * main logged that tasks were due, and the renderer never heard a thing.
 */
const events = createIpcEventSender<ScheduledEventMap>();

const STORE_PATH = path.join(os.homedir(), '.pi', 'desktop', 'scheduled-tasks.json');

/** How often we look. Fine-grained enough that "at 9:00" means 9:00, cheap
 *  enough to be invisible — the check is arithmetic over a handful of tasks. */
const TICK_MS = 30_000;

let state: ScheduleState = EMPTY_SCHEDULE;
let loaded = false;
let timer: NodeJS.Timeout | undefined;

function load(): ScheduleState {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const doc = JSON.parse(raw) as Partial<ScheduleState>;
    state = {
      enabled: doc.enabled !== false,
      tasks: Array.isArray(doc.tasks)
        ? doc.tasks
            .filter((t): t is ScheduledTask => typeof (t as ScheduledTask)?.id === 'string')
            .map(normalizeTask)
        : [],
    };
  } catch {
    // No file yet is the normal first-run state, not an error worth logging.
    state = EMPTY_SCHEDULE;
  }
  return state;
}

/**
 * The exact bytes we last wrote, so our own save does not read back as an
 * external change.
 *
 * This was a TIME window first ("ignore changes for 500ms after we write"),
 * which quietly dropped any real external write that landed inside it — and the
 * probe caught exactly that: a tool-created task arriving just after a UI save
 * vanished. Comparing content has no window to fall into.
 */
let lastWritten = '';

function save(next: ScheduleState): void {
  state = next;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const body = `${JSON.stringify(next, null, 2)}\n`;
    lastWritten = body;
    fs.writeFileSync(STORE_PATH, body, { mode: 0o600 });
  } catch (error) {
    log.warn('could not persist scheduled tasks', { error: String(error) });
  }
}

function newId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Replace one task by id; unknown ids are a no-op rather than an append. */
function patchTask(id: string, patch: Partial<ScheduledTask>): ScheduleState {
  const tasks = load().tasks.map((t) => (t.id === id ? normalizeTask({ ...t, ...patch, id }) : t));
  return { ...state, tasks };
}

export function scheduledState(): ScheduleState {
  return load();
}

/**
 * WATCH THE FILE, because we are not its only writer.
 *
 * `create_scheduled_task` (packages/harness) appends straight to this file —
 * that is what lets ANY harness create tasks without a bridge of its own. Since
 * `load()` caches, a task made from a chat would otherwise sit invisible until
 * the next launch, and the tool would have told the user it was scheduled.
 *
 * Debounced, and ignoring the echo of our own writes, so saving from the UI does
 * not bounce back through here as a change.
 */
function watchStore(notify: () => void): void {
  let pending: NodeJS.Timeout | undefined;
  const onChange = () => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      let body = '';
      try {
        body = fs.readFileSync(STORE_PATH, 'utf8');
      } catch {
        return;
      }
      // Our own write, echoed back by the watcher — nothing to tell anyone.
      if (body === lastWritten) return;
      lastWritten = body;
      loaded = false;
      load();
      notify();
    }, 200);
  };
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    // Watch the DIRECTORY: watching a file that does not exist yet throws, and
    // the first task ever created is exactly that case.
    fs.watch(path.dirname(STORE_PATH), (_event, filename) => {
      if (filename === null || path.basename(STORE_PATH) === filename) onChange();
    });
  } catch (error) {
    log.warn('could not watch the schedule file', { error: String(error) });
  }
}

/** Stamp a task as run. The runner calls this at run START, not on finish, so a
 *  long run cannot re-fire on the next 30s tick while it is still going. */
export function markRan(id: string, whenMs: number): void {
  save(patchTask(id, { lastRunAt: whenMs }));
}

let runner: ScheduledRunner | null = null;

export function stopScheduler(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  runner?.dispose();
  runner = null;
}

export function registerScheduledHandlers(
  ipcMain: IpcMain,
  opts: {
    allowSender: (event: unknown) => boolean;
    /** The window to notify of run/schedule changes (it does not RUN anything). */
    getWindow: () => BrowserWindow | null;
    /** Build a headless top-level bridge — pi-main's createScheduledRunBridge. */
    createRunBridge: (opts: { cwd?: string }, onEvent: (e: PiBridgeEvent) => void) => RunBridge;
  },
): void {
  const emitRun = (run: TaskRun): void => {
    const win = opts.getWindow();
    if (win !== null && !win.isDestroyed())
      events.send(win.webContents, 'tasks:run-updated', { run });
  };

  runner = createScheduledRunner({
    createBridge: opts.createRunBridge,
    onRunUpdated: emitRun,
    markRan,
    now: () => Date.now(),
  });
  const activeRunner = runner;

  const handlers: IpcHandlers<ScheduledInvokeMap> = {
    'tasks:get': () => load(),
    'tasks:set-enabled': (req) => {
      save({ ...load(), enabled: req.enabled });
      return state;
    },
    'tasks:create': (req) => {
      const task = normalizeTask({
        ...req.task,
        id: newId(),
        createdAt: Date.now(),
      });
      save({ ...load(), tasks: [...state.tasks, task] });
      return { state, task };
    },
    'tasks:update': (req) => {
      save(patchTask(req.id, req.patch));
      return state;
    },
    'tasks:delete': (req) => {
      save({ ...load(), tasks: load().tasks.filter((t) => t.id !== req.id) });
      activeRunner.deleteRunsForTask(req.id);
      return state;
    },
    'tasks:run-now': (req) => {
      const task = load().tasks.find((t) => t.id === req.id);
      if (task === undefined) return { ok: false };
      const { runId } = activeRunner.run(task, 'manual');
      return { ok: true, runId };
    },
    'tasks:list-runs': (req) => ({ runs: activeRunner.listRuns(req.taskId) }),
    'tasks:delete-run': (req) => ({ ok: activeRunner.deleteRun(req.taskId, req.runId) }),
  };
  registerIpcHandlers<ScheduledInvokeMap>(ipcMain, handlers, {
    allowSender: opts.allowSender,
  });

  // --- the tick ------------------------------------------------------------
  const tick = () => {
    const now = Date.now();
    const current = load();
    const due = dueTasks(current.tasks, now, current.enabled);
    if (due.length === 0) return;
    log.info('scheduled tasks due', { ids: due.map((t) => t.id) });
    // Run headless, right here. markRan is stamped at run start (in the runner),
    // so a task cannot be picked up twice while its run is still going.
    for (const task of due) activeRunner.run(task);
  };
  /* A task created from a chat must appear in the list immediately, and be
     eligible for the very next tick. */
  watchStore(() => {
    const win = opts.getWindow();
    if (win !== null && !win.isDestroyed()) {
      events.send(win.webContents, 'tasks:changed', { state });
    }
  });

  timer = setInterval(tick, TICK_MS);
  // One early check so a task due while the app was closed runs at launch
  // rather than up to 30 seconds later.
  setTimeout(tick, 4_000);
}
