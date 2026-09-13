/*
 * ORPHANED MODEL SERVERS FROM A PREVIOUS LIFE.
 *
 * The ordered quit (quit-hold → shutdownInference → supervisor SIGKILLs
 * llama-server) is correct and works. It cannot run when the app dies WITHOUT a
 * quit — a crash, a force-quit, an automated harness closing the window — and a
 * SIGKILLed process gets no chance to clean up after itself. What is left behind
 * is a llama-server reparented to init, still holding the whole model resident.
 *
 * MEASURED, and it is not a small leak: SIX orphans accumulated in one working
 * session, three of them 6.5GB each. Free memory sat at 41%, and a benchmark run
 * launched into that never produced a single token in four minutes — the model
 * was there, the app was there, and nothing happened. Nothing in the UI could
 * have explained it; the app was competing with three ghosts of itself.
 *
 * Since the dying side cannot do the cleanup, the STARTING side does it: on
 * launch, any llama-server that came from our own cache directory and has been
 * reparented to init belongs to a previous run and is killed. A server owned by
 * a LIVE app — including a second window, or a concurrent harness run — always
 * has a live parent, so it is never touched.
 */

/** A candidate for reaping: our binary, and no living parent. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Parse `ps -axo pid=,ppid=,command=` output. Kept separate from the killing so
 * the selection rule can be tested without processes.
 */
export function parseProcessRows(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
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
 * Which rows are ours, orphaned, and not us.
 *
 * `roots` are the app's own binary directories: the llama.cpp build dir (a
 * `llama-server` there is ours) and the engines dir (`<cache>/engines/…`,
 * where every external engine — `rapid-mlx serve`, `dflash serve`,
 * `mlx-dspark serve`, `omlx serve`, `mlx_lm.server`, `vllm serve` — runs out
 * of a venv of ours). Matching on the root means a server a user launched by
 * hand from elsewhere is never in scope. `self` excludes the current process
 * defensively — reaping is a kill loop, and it should be impossible for it
 * to reach this process even by accident.
 *
 * MEASURED 2026-09-12: three `rapid-mlx serve` stubs reparented to init after
 * headless probes closed the app mid-launch — the llama-server-only rule
 * walked straight past them.
 */
export function orphanedServers(
  rows: readonly ProcessRow[],
  roots: string | readonly string[],
  self: number = process.pid,
): ProcessRow[] {
  const live = new Set(rows.map((r) => r.pid));
  const list = typeof roots === 'string' ? [roots] : roots;
  return rows.filter(
    (r) =>
      r.pid !== self &&
      list.some((root) => r.command.includes(root)) &&
      isServerCommand(r.command) &&
      // Reparented to init, or the parent is simply gone from the table.
      (r.ppid === 1 || !live.has(r.ppid)),
  );
}

/** A model server, as opposed to a pip install or a `--help` we ran from the same venv. */
function isServerCommand(command: string): boolean {
  if (command.includes('llama-server')) return true;
  if (/\bmlx_lm\.server\b/.test(command)) return true;
  // `<venv>/bin/rapid-mlx serve …`, `…/dflash serve …`, `…/vllm serve …`
  return /\/bin\/[\w.-]+\s+serve(\s|$)/.test(command);
}

/**
 * Kill every orphaned server from a previous run. Best-effort and non-fatal:
 * this runs on the launch path, and failing to tidy up must never stop the app
 * from starting. Returns the pids it stopped, for the log and for tests.
 */
export function reapOrphanedServers(
  ownRoot: string | readonly string[],
  deps: {
    ps: () => string;
    kill: (pid: number) => void;
    log?: (message: string, meta?: Record<string, unknown>) => void;
  },
): number[] {
  let rows: ProcessRow[];
  try {
    rows = parseProcessRows(deps.ps());
  } catch {
    return [];
  }
  const stopped: number[] = [];
  for (const row of orphanedServers(rows, ownRoot)) {
    try {
      deps.kill(row.pid);
      stopped.push(row.pid);
    } catch {
      // Already gone, or not ours to signal. Either way, nothing to do.
    }
  }
  if (stopped.length > 0) {
    deps.log?.('reaped orphaned model server(s) from a previous run', { pids: stopped });
  }
  return stopped;
}
