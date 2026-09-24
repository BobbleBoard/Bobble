/**
 * THE APP'S LONG-LIVED PROCESSES: WHO REAPS THEM AT QUIT, AND HOW A GHOST FROM
 * A PREVIOUS RUN IS RECOGNISED.
 *
 * The app already runs several processes that outlive a single request — the
 * inference supervisor and its model server, the pi-mac helper, the ComfyUI
 * server, terminal PTYs — and each was wired into quit by hand in main.ts
 * (`reapChildProcesses`), and into the launch-time orphan sweep by hand in
 * llm-main.ts (`reapOrphanedServers`). The push adds a handful more: the memory
 * service and its Postgres, the help pi, the training worker, the editing-tools
 * worker, the cluster node. Each of those registers HERE, from its own file,
 * instead of editing main.ts (deliverables/research/PLAN.md R10):
 *
 *   - {@link registerQuitReaper}: a teardown awaited in the pi quit-hold's held
 *     window, beside the built-in ones, so nothing survives quit.
 *   - {@link registerOrphanSignature}: how to recognise this process if a crash
 *     or a force-quit left it reparented to init, so the NEXT launch reaps it.
 *     That is the lesson of the orphaned llama-servers
 *     (memory `pi-desktop-orphan-servers`): the dying side cannot clean up, so
 *     the starting side does — but only for commands under one of OUR roots and
 *     with no living parent, so a live app's process is never touched.
 *
 * A long-lived process also registers with `guardRun` (gen/guardian-main.ts)
 * under the pausable kinds `'service'` or `'train'`, so the memory guard can
 * pause it in place.
 *
 * Electron-free and IO-injected: the rules are unit-tested without processes.
 */

/** A teardown run at app quit, inside the quit-hold's grace window. */
export interface QuitReaper {
  /** Stable, for the log and for replacing a registration: `memory-service`. */
  readonly id: string;
  readonly reap: () => Promise<void> | void;
}

/**
 * How to recognise one of our long-lived processes left behind by a previous
 * run. Both halves must hold: the command runs from one of `roots` (our own
 * binaries and venvs) AND `matches` says it is the long-lived process rather
 * than a one-shot install or a `--help` run from the same venv.
 */
export interface OrphanSignature {
  readonly id: string;
  /** Directories whose executables are ours, read at sweep time. */
  readonly roots: () => readonly string[];
  readonly matches: (command: string) => boolean;
}

/** One row of `ps -axo pid=,ppid=,command=`. */
export interface LifecycleProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

const reapers = new Map<string, QuitReaper>();
const signatures = new Map<string, OrphanSignature>();

/** Register a quit teardown; the returned function unregisters it. Same id replaces. */
export function registerQuitReaper(reaper: QuitReaper): () => void {
  reapers.set(reaper.id, reaper);
  return () => {
    if (reapers.get(reaper.id) === reaper) reapers.delete(reaper.id);
  };
}

/** Register an orphan signature; the returned function unregisters it. Same id replaces. */
export function registerOrphanSignature(signature: OrphanSignature): () => void {
  signatures.set(signature.id, signature);
  return () => {
    if (signatures.get(signature.id) === signature) signatures.delete(signature.id);
  };
}

export function quitReapers(): readonly QuitReaper[] {
  return [...reapers.values()];
}

export function orphanSignatures(): readonly OrphanSignature[] {
  return [...signatures.values()];
}

/**
 * Run every registered quit teardown. `allSettled`, like main.ts's own list: a
 * slow or failing one never blocks the rest, and the quit-hold's grace cap bounds
 * the whole wait. Resolves to the ids whose teardown threw, for the log.
 */
export async function reapRegisteredAtQuit(
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<string[]> {
  const list = quitReapers();
  if (list.length === 0) return [];
  const results = await Promise.allSettled(list.map(async (r) => r.reap()));
  const failed: string[] = [];
  results.forEach((res, i) => {
    const id = list[i]?.id ?? '?';
    if (res.status === 'rejected') {
      failed.push(id);
      log?.('quit reaper failed', { id, error: String(res.reason) });
    }
  });
  return failed;
}

/** Parse `ps -axo pid=,ppid=,command=`. */
export function parseProcessTable(psOutput: string): LifecycleProcessRow[] {
  const rows: LifecycleProcessRow[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const [, pid, ppid, command] = m;
    if (pid === undefined || ppid === undefined || command === undefined) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), command });
  }
  return rows;
}

/**
 * The rows that are ours (a signature's root AND its matcher), orphaned (parent
 * is init or gone from the table) and not this process. Each row is reported
 * once, under the first signature that claims it.
 */
export function findOrphans(
  rows: readonly LifecycleProcessRow[],
  sigs: readonly OrphanSignature[],
  self: number = process.pid,
): { row: LifecycleProcessRow; signature: string }[] {
  if (sigs.length === 0) return [];
  const live = new Set(rows.map((r) => r.pid));
  const resolved = sigs.map((s) => ({ id: s.id, roots: s.roots(), matches: s.matches }));
  const out: { row: LifecycleProcessRow; signature: string }[] = [];
  for (const row of rows) {
    if (row.pid === self) continue;
    if (row.ppid !== 1 && live.has(row.ppid)) continue;
    const sig = resolved.find(
      (s) =>
        s.roots.some((root) => root.length > 0 && row.command.includes(root)) &&
        s.matches(row.command),
    );
    if (sig !== undefined) out.push({ row, signature: sig.id });
  }
  return out;
}

/**
 * The launch-time sweep for every registered signature. Best-effort and
 * non-fatal, like `reapOrphanedServers`: failing to tidy up must never stop the
 * app from starting. With nothing registered it does nothing at all — not even
 * the `ps` read. Returns the pids it signalled.
 */
export function reapRegisteredOrphans(deps: {
  ps: () => string;
  kill: (pid: number) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): number[] {
  const sigs = orphanSignatures();
  if (sigs.length === 0) return [];
  let rows: LifecycleProcessRow[];
  try {
    rows = parseProcessTable(deps.ps());
  } catch {
    return [];
  }
  const stopped: number[] = [];
  const by: Record<string, number[]> = {};
  for (const { row, signature } of findOrphans(rows, sigs)) {
    try {
      deps.kill(row.pid);
      stopped.push(row.pid);
      by[signature] = [...(by[signature] ?? []), row.pid];
    } catch {
      // Already gone, or not ours to signal.
    }
  }
  if (stopped.length > 0) deps.log?.('reaped orphaned processes from a previous run', { by });
  return stopped;
}

/** Test seam: forget every registration. */
export function resetLifecycleForTests(): void {
  reapers.clear();
  signatures.clear();
}
