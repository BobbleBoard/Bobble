/**
 * EVERYTHING HEAVY THE APP HAS RUNNING, AS THINGS THAT CAN BE STOPPED IN PLACE.
 *
 * the user (2026-09-16), after his Mac restarted under a 3D job: "these memory
 * safeguards should just not let ooms happen for sure … have safeguards in
 * place to stop generations/runs of any sort ideally pausing them rather than
 * terminating where possible, and it should in practically all places be
 * possible even mid diffusion generation … kernel level hangs are 100%
 * unacceptable, runs should be paused and even totally terminated if pausing
 * fails for some reason quickly."
 *
 * The guardian (packages/inference/src/guardian.ts) reads the machine and says
 * `pause` or `shed`; this is what those words reach. Every heavy run
 * registers itself here for as long as it runs — a uv generation worker, the
 * ComfyUI server while a job is in it, the 3D sidecar while a stage runs, a pi
 * child while a turn is in flight — with the process at the root of its tree.
 *
 * PAUSE is SIGSTOP on the whole tree (the root and every descendant, read from
 * `ps` at that moment: a worker's own children — a remesher, a bake — must
 * stop with it, or the pause is decoration). A stopped process submits no GPU
 * work, allocates nothing, holds what it has; the kernel gets the seconds it
 * needs to reclaim cache and the pointer keeps moving. A Metal command buffer
 * in flight completes on its own (the pacer in gen-service relies on the same
 * fact). RESUME is SIGCONT on the same set. TERMINATE is the entry's own
 * cancel where it has one (a cancelled job says why in its own words), then
 * SIGKILL on the tree if the process is still there a beat later — because a
 * stop that does not land is exactly the case the user named.
 *
 * Nothing in here decides. It signals what it is told, and reports what it did.
 */
import { execFileSync } from 'node:child_process';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:pausables');

export interface Pausable {
  /** Stable per run, e.g. `gen:<jobId>`, `gen3d:<jobId>`, `pi:<pid>`. */
  readonly id: string;
  /** What the person will read: "the picture", "the 3D texture", "the chat". */
  readonly label: string;
  /** Which kind of work, for the order of termination and the log. */
  readonly kind: 'gen' | 'gen3d' | 'agent';
  /** The root of the process tree to signal, when there is one right now. */
  readonly pid: () => number | undefined;
  /**
   * The entry's own way of ending the run with a reason (a queue cancel, a
   * sidecar `/cancel`) — preferred over the signal because the run's own
   * bookkeeping then ends cleanly and the person reads why. Optional: a tree
   * with no cancel of its own is simply killed.
   */
  readonly cancel?: (reason: string) => Promise<void> | void;
  /**
   * Agents are never killed by the guard — pausing them is enough (their
   * memory is the model server's, and that is parked separately).
   */
  readonly neverTerminate?: boolean;
  /** Not heavy on its own: does not put the guard on its fast cadence. */
  readonly light?: boolean;
  /**
   * Terminate spares the root and this many levels below it. For a run that
   * lives under a long-lived server the server is not the run: its own
   * `cancel` ends the worker, and the signal that follows must not take the
   * server with it. The 3D sidecar is `uv run` (the root) → the python server
   * (one level down) → the stage's worker (two down): `spareDepth: 1`.
   * MEASURED: the first cut killed the sidecar along with a CubePart stage —
   * twice, the second time sparing only the uv wrapper — and every stage
   * after it paid a restart.
   */
  readonly spareDepth?: number;
}

/** Every pid under `root` with its depth (root = 0), root first — from one `ps` read. */
export function processTreeWithDepth(
  root: number,
  psOutput?: string,
): { pid: number; depth: number }[] {
  let out = psOutput;
  if (out === undefined) {
    try {
      out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
    } catch {
      return [{ pid: root, depth: 0 }];
    }
  }
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]);
    else list.push(pid);
  }
  const seen: { pid: number; depth: number }[] = [];
  const stack = [{ pid: root, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop() as { pid: number; depth: number };
    if (seen.some((s) => s.pid === next.pid)) continue;
    seen.push(next);
    for (const c of children.get(next.pid) ?? []) stack.push({ pid: c, depth: next.depth + 1 });
  }
  return seen;
}

/** Every pid under `root`, root first — from one `ps` read. */
export function processTree(root: number, psOutput?: string): number[] {
  return processTreeWithDepth(root, psOutput).map((s) => s.pid);
}

function signalTree(root: number, signal: NodeJS.Signals, spareDepth = -1): number[] {
  const pids = processTreeWithDepth(root)
    .filter((s) => s.depth > spareDepth)
    .map((s) => s.pid);
  // Children first for a stop (so a parent cannot spawn a fresh, unstopped
  // child in the gap); the order is immaterial for a kill.
  const ordered = signal === 'SIGSTOP' ? [...pids].reverse() : pids;
  const hit: number[] = [];
  for (const pid of ordered) {
    try {
      process.kill(pid, signal);
      hit.push(pid);
    } catch {
      // Gone already, or not ours.
    }
  }
  return hit;
}

export interface PausablesRegistry {
  readonly register: (entry: Pausable) => () => void;
  /** Anything registered right now — the guard samples fast while this is true. */
  readonly active: () => boolean;
  readonly list: () => readonly Pausable[];
  /** Stop every registered tree in place. Returns the labels that were stopped. */
  readonly pauseAll: (reason: string) => string[];
  /** Let every stopped tree run again. */
  readonly resumeAll: () => string[];
  /** End every registered run that may be ended (agents are only paused). */
  readonly terminateAll: (reason: string) => Promise<string[]>;
  /** Whether a pause is in force. */
  readonly paused: () => boolean;
}

export function createPausables(): PausablesRegistry {
  const entries = new Map<string, Pausable>();
  /** pids stopped by the last pause, per entry — resumed exactly, never guessed. */
  const stopped = new Map<string, number[]>();
  let paused = false;

  const pauseEntry = (e: Pausable): boolean => {
    const root = e.pid();
    if (root === undefined) return false;
    const hit = signalTree(root, 'SIGSTOP');
    if (hit.length === 0) return false;
    stopped.set(e.id, hit);
    return true;
  };

  const resumeEntry = (id: string): boolean => {
    const pids = stopped.get(id);
    stopped.delete(id);
    if (pids === undefined) return false;
    // Parents first, then children — the reverse of the stop.
    for (const pid of [...pids].reverse()) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        // gone
      }
    }
    return true;
  };

  return {
    register(entry) {
      entries.set(entry.id, entry);
      // Registered into a pause: it stops with the rest, at once.
      if (paused) pauseEntry(entry);
      return () => {
        // A run that ends while stopped must not leave stopped children behind.
        if (stopped.has(entry.id)) resumeEntry(entry.id);
        entries.delete(entry.id);
      };
    },
    active: () => [...entries.values()].some((e) => e.light !== true),
    list: () => [...entries.values()],
    paused: () => paused,
    pauseAll(reason) {
      paused = true;
      const labels: string[] = [];
      for (const e of entries.values()) {
        if (stopped.has(e.id)) continue;
        if (pauseEntry(e)) labels.push(e.label);
      }
      if (labels.length > 0) log.info('paused', { labels, reason });
      return labels;
    },
    resumeAll() {
      paused = false;
      const labels: string[] = [];
      for (const id of [...stopped.keys()]) {
        const e = entries.get(id);
        if (resumeEntry(id)) labels.push(e?.label ?? id);
      }
      if (labels.length > 0) log.info('resumed', { labels });
      return labels;
    },
    async terminateAll(reason) {
      const labels: string[] = [];
      for (const e of [...entries.values()]) {
        if (e.neverTerminate === true) continue;
        const root = e.pid();
        // The run's own cancel first — it ends cleanly and says why. A stopped
        // process cannot act on a cancel, so it is continued for the purpose.
        if (stopped.has(e.id)) resumeEntry(e.id);
        try {
          await e.cancel?.(reason);
        } catch (err) {
          log.warn('cancel failed', { id: e.id, error: String(err) });
        }
        // …and the signal a beat later for anything still there. SIGKILL is
        // uncatchable; a run that does not end here has already ended.
        if (root !== undefined) {
          await new Promise((r) => setTimeout(r, 400));
          const hit = signalTree(root, 'SIGKILL', e.spareDepth ?? -1);
          if (hit.length > 0) log.info('killed', { id: e.id, pids: hit, reason });
        }
        labels.push(e.label);
        entries.delete(e.id);
      }
      return labels;
    },
  };
}
