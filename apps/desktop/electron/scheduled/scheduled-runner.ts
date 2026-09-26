/**
 * RUNNING a scheduled task, headless.
 *
 * The run happens here in MAIN, in a throwaway pi bridge — not as a chat in the
 * renderer. the user: "a clean new temporary session that is started, conducts and
 * then is hidden/deleted/shown somewhere in a view past runs." So there is no
 * sidebar entry and no session file to find; the only trace is a run record,
 * which the past-runs view reads.
 *
 * Runs are SERIALISED. Two heavy runs (a news video, an image) loading models at
 * once on a 24GB machine is how a scheduled task becomes a swap storm — and the
 * user may be working in the app meanwhile. One at a time, queued.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PiBridgeEvent } from '@pi-desktop/engine';
import { createLogger } from '@pi-desktop/shared';
import { blockedPermission, blockedPermissionError } from './blocked-permission';
import type {
  RunArtifact,
  RunModel,
  RunStatus,
  ScheduledTask,
  TaskRun,
} from './scheduled-contract';

const log = createLogger('desktop:scheduled-runner');

const RUNS_DIR = path.join(os.homedir(), '.pi', 'desktop', 'scheduled-runs');
/** Keep a task's history readable, not unbounded. */
const KEEP_RUNS_PER_TASK = 20;
/** A run must not hang a queue forever; long enough for a real video job. */
const RUN_TIMEOUT_MS = 20 * 60_000;

/** The minimal bridge surface the runner drives — injected so this stays testable. */
export interface RunBridge {
  ready(): Promise<void>;
  readonly alive: boolean;
  prompt(text: string): Promise<unknown>;
  dispose(): void;
}

export interface ScheduledRunnerDeps {
  /** Build a headless top-level bridge (pi-main's createScheduledRunBridge). */
  createBridge: (opts: { cwd?: string }, onEvent: (e: PiBridgeEvent) => void) => RunBridge;
  /** Fired whenever a run's record changes, so the UI can follow it live. */
  onRunUpdated: (run: TaskRun) => void;
  /** Stamp the task as having run (updates lastRunAt), called at run START. */
  markRan: (taskId: string, whenMs: number) => void;
  now: () => number;
  /**
   * The model the inference server has loaded right now, or null. Read at a
   * run's start and again at its end, so the record can say what ran it
   * (`TaskRun.model`). Optional so the runner stays usable without a server.
   */
  currentModel?: () => RunModel | null;
}

function taskRunsDir(taskId: string): string {
  return path.join(RUNS_DIR, taskId);
}

function runRecordPath(taskId: string, runId: string): string {
  return path.join(taskRunsDir(taskId), `${runId}.json`);
}

function writeRun(run: TaskRun): void {
  try {
    fs.mkdirSync(taskRunsDir(run.taskId), { recursive: true });
    fs.writeFileSync(runRecordPath(run.taskId, run.id), `${JSON.stringify(run, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    log.warn('could not write run record', { error: String(error) });
  }
}

export function listRuns(taskId: string): TaskRun[] {
  const dir = taskRunsDir(taskId);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const runs: TaskRun[] = [];
  for (const f of files) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TaskRun);
    } catch {
      // A half-written record is skipped, not fatal.
    }
  }
  runs.sort((a, b) => b.startedAt - a.startedAt);
  return runs;
}

export function deleteRun(taskId: string, runId: string): boolean {
  try {
    fs.rmSync(runRecordPath(taskId, runId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Drop all records for a deleted task, so history does not outlive its task. */
export function deleteRunsForTask(taskId: string): void {
  try {
    fs.rmSync(taskRunsDir(taskId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function prune(taskId: string): void {
  const runs = listRuns(taskId);
  for (const stale of runs.slice(KEEP_RUNS_PER_TASK)) deleteRun(taskId, stale.id);
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.gif', '.m4v']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);
const TEXTY = new Set(['.md', '.txt', '.json', '.csv', '.html']);

function artifactKind(ext: string): RunArtifact['kind'] {
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (TEXTY.has(ext)) return 'text';
  return 'other';
}

/**
 * Files the run produced, so the past-runs view can SHOW the deliverable.
 *
 * Scans the run's directory for files touched at or after the run started —
 * deterministic, and it does not depend on parsing the model's tool stream. It
 * only scans a DEDICATED per-run dir (see runner: a task with no cwd of its own
 * runs in one), so this is the run's output and nothing incidental. A task that
 * names its own working folder is left unscanned — we will not trawl someone's
 * repo — and its past run shows the summary and tool trail instead.
 */
function scanArtifacts(dir: string, sinceMs: number, dedicated: boolean): RunArtifact[] {
  if (!dedicated) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RunArtifact[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs + 1000 < sinceMs) continue;
      out.push({
        path: full,
        name: e.name,
        bytes: st.size,
        kind: artifactKind(path.extname(e.name).toLowerCase()),
      });
    } catch {
      // skip unreadable entries
    }
  }
  // Media first — that is what someone opened the past run to see.
  const rank = { image: 0, video: 0, audio: 1, text: 2, other: 3 } as const;
  out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
  return out.slice(0, 24);
}

function newRunId(nowMs: number): string {
  return `run_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface ScheduledRunner {
  /** Queue a run; resolves with the runId once queued (not when it finishes).
   * `trigger` records whether the clock or a person started it — see TaskRun. */
  run(task: ScheduledTask, trigger?: 'schedule' | 'manual'): { runId: string };
  /**
   * STOP a task's run. The live run — if it is this task's — is ended: the
   * bridge is disposed (which frees the model slot it held) and the record is
   * finalised as `stopped`, with whatever it had said so far. A run of this
   * task still waiting in the queue is dropped before it starts and leaves no
   * record, because it never began. `false` when there was nothing to stop.
   */
  stop(taskId: string): boolean;
  listRuns: typeof listRuns;
  deleteRun: typeof deleteRun;
  deleteRunsForTask: typeof deleteRunsForTask;
  /** Reap any live bridge (quit hold). */
  dispose(): void;
}

/** A run in flight: enough to end it from outside its own closure. */
interface LiveRun {
  readonly taskId: string;
  readonly runId: string;
  readonly bridge: RunBridge;
  readonly end: (status: 'stopped') => void;
}

export function createScheduledRunner(deps: ScheduledRunnerDeps): ScheduledRunner {
  let queue: Promise<void> = Promise.resolve();
  let live: LiveRun | null = null;
  /** Runs queued behind the live one, in order. A stop removes from here. */
  const waiting: Array<{ taskId: string; runId: string }> = [];
  /** Queued runs that were stopped before they started; `execute` skips them. */
  const dropped = new Set<string>();

  function execute(
    task: ScheduledTask,
    runId: string,
    trigger: 'schedule' | 'manual',
  ): Promise<void> {
    const at = waiting.findIndex((w) => w.runId === runId);
    if (at !== -1) waiting.splice(at, 1);
    if (dropped.delete(runId)) return Promise.resolve();

    const startedAt = deps.now();
    // No cwd on the task → a dedicated per-run output dir, so the deliverables
    // are isolated and cleanly scannable. A named folder is used as-is.
    const dedicated = task.cwd === undefined || task.cwd.trim() === '';
    const cwd = dedicated ? path.join(taskRunsDir(task.id), runId) : task.cwd;
    if (dedicated) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch {
        // fall through; the bridge will land in $HOME if this dir is unusable
      }
    }

    const modelAtStart = deps.currentModel?.() ?? null;
    let run: TaskRun = {
      id: runId,
      taskId: task.id,
      startedAt,
      trigger,
      status: 'running',
      ...(modelAtStart !== null ? { model: modelAtStart } : {}),
      summary: '',
      toolCalls: [],
      cwd,
      artifacts: [],
    };
    writeRun(run);
    deps.markRan(task.id, startedAt);
    deps.onRunUpdated(run);

    return new Promise<void>((resolve) => {
      let summary = '';
      const toolCalls: string[] = [];
      let settled = false;

      const finish = (status: Exclude<RunStatus, 'running'>, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const artifacts = scanArtifacts(cwd, startedAt, dedicated);
        // A run that started before any model was loaded loaded one itself;
        // name it now, so the record does not stay blank for the whole first day.
        const model = run.model ?? deps.currentModel?.() ?? undefined;
        run = {
          ...run,
          status,
          finishedAt: deps.now(),
          ...(model !== undefined ? { model } : {}),
          summary: summary.trim(),
          toolCalls,
          artifacts,
          ...(error !== undefined ? { error } : {}),
        };
        writeRun(run);
        prune(task.id);
        deps.onRunUpdated(run);
        const bridge = live?.runId === runId ? live.bridge : null;
        if (live?.runId === runId) live = null;
        try {
          bridge?.dispose();
        } catch {
          // ignore
        }
        resolve();
      };

      const onEvent = (event: PiBridgeEvent): void => {
        const e = event as {
          type?: string;
          assistantMessageEvent?: { type?: string; delta?: string; name?: string };
          message?: { role?: string; content?: { type?: string; text?: string }[] };
          toolName?: string;
          isError?: boolean;
          result?: { content?: { type?: string; text?: string }[] };
        };
        /*
         * macOS SAID NO — that is a failed run, not a successful one.
         *
         * Without this a brief whose Calendar consent was never granted records
         * `ok` every morning with a summary that is an apology, and the user
         * sees a week of green. A failure that says which permission to grant is
         * worth more than seven successes that do not.
         */
        if (e.type === 'tool_execution_end' && e.isError === true) {
          const text = (e.result?.content ?? [])
            .map((c) => (c?.type === 'text' ? (c.text ?? '') : ''))
            .join(' ');
          const permission = blockedPermission(text);
          if (permission !== null) {
            finish('error', blockedPermissionError(e.toolName ?? 'a tool', permission));
            return;
          }
        }
        if (e.type === 'message_start') summary = '';
        else if (e.type === 'message_update') {
          const a = e.assistantMessageEvent;
          if (a?.type === 'text_delta' && typeof a.delta === 'string') summary += a.delta;
          else if (a?.type === 'toolcall_start' && typeof a.name === 'string')
            toolCalls.push(a.name);
        } else if (e.type === 'message_end' && e.message?.role === 'assistant') {
          // The finished message is the provider's last word on the text: a
          // stalled request it cancelled and sent again streamed text that is
          // not in it (provider-llamacpp/stall-watchdog.ts).
          summary = (e.message.content ?? [])
            .map((c) => (c?.type === 'text' ? (c.text ?? '') : ''))
            .join('');
        }
        if (event.type === 'agent_end') finish('ok');
        else if (event.type === '_bridge_exit') {
          // A clean end fires agent_end first; a bare exit means it died.
          finish(settled ? 'ok' : 'error', settled ? undefined : 'the run ended unexpectedly');
        }
      };

      let bridge: RunBridge;
      try {
        bridge = deps.createBridge({ cwd }, onEvent);
      } catch (error) {
        finish(
          'error',
          `could not start: ${String(error instanceof Error ? error.message : error)}`,
        );
        return;
      }
      live = { taskId: task.id, runId, bridge, end: (status) => finish(status) };

      const timeout = setTimeout(() => finish('error', 'the run timed out'), RUN_TIMEOUT_MS);

      void (async () => {
        try {
          await bridge.ready();
          if (!bridge.alive) {
            finish('error', 'the run failed to start');
            return;
          }
          await bridge.prompt(task.prompt);
        } catch (error) {
          finish('error', String(error instanceof Error ? error.message : error));
        }
      })();
    });
  }

  return {
    run(task, trigger = 'schedule') {
      const runId = newRunId(deps.now());
      waiting.push({ taskId: task.id, runId });
      // Chain onto the queue so runs never overlap.
      queue = queue
        .then(() => execute(task, runId, trigger))
        .catch((error) => {
          log.warn('scheduled run threw', { taskId: task.id, error: String(error) });
        });
      return { runId };
    },
    stop(taskId) {
      let stopped = false;
      if (live?.taskId === taskId) {
        log.info('scheduled run stopped by hand', { taskId, runId: live.runId });
        live.end('stopped');
        stopped = true;
      }
      for (const w of waiting) {
        if (w.taskId !== taskId) continue;
        dropped.add(w.runId);
        stopped = true;
      }
      return stopped;
    },
    listRuns,
    deleteRun,
    deleteRunsForTask,
    dispose() {
      const bridge = live?.bridge ?? null;
      live = null;
      try {
        bridge?.dispose();
      } catch {
        // ignore
      }
    },
  };
}
