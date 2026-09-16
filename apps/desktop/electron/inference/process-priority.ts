/**
 * ASK THE OS TO SCHEDULE THE USER FIRST.
 *
 * the user wants the machine usable while it generates. Most of that is memory —
 * see power-policy.ts — but there is one lever that costs nothing and helps on
 * every platform: telling the scheduler that the inference server is background
 * work. The user's window server, editor and browser then win contention instead
 * of queueing behind a process that will happily take every cycle.
 *
 * It is a HINT, not a cap. Under no contention the server still runs flat out;
 * it only loses when something the user is looking at wants the same core. That
 * is exactly the shape wanted here — no throughput given away for nothing.
 *
 * macOS: `taskpolicy -t 5 -l 5 -p <pid>` drops a running process to the lowest
 * throughput and latency QoS TIERS (the `-p` form's documented knobs; exits 0
 * without sudo) — NOT `-b`, the DARWIN_BG tier. MEASURED (2026-09-16, an idle
 * M5 Pro, torch 2048² float32 matmuls): unclamped 1826 GFLOP/s, tiers 5/5
 * 1789, `-b` 155. The background tier is confined to the efficiency cores and
 * throttled whether or not anyone else wants the cores — twelve times slower,
 * on the DEFAULT ('low') settings, for every CPU-bound stage (CubePart's part
 * split went from five minutes standalone to over forty through the app) and
 * for the chat server's own token loop. "A hint that costs nothing when idle"
 * was the intent; the tiers are what actually meet it. Linux: `renice`.
 * Windows has no equivalent we can reach from here without a native module,
 * so it is a no-op — and saying so is better than pretending.
 *
 * Best-effort throughout: a missing tool or a refused call is not an error, it
 * is a machine where this particular lever does not exist.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Nice value for a backgrounded server on Linux. 10 is "yield readily". */
const LINUX_NICE = 10;
/** …and for a heavy worker that should merely lose ties to the user. */
const LINUX_NICE_UTILITY = 5;

/**
 * THE TIER A HEAVY GENERATION WORKER RUNS AT, ALWAYS.
 *
 * the user, after a generation froze his Mac: "trackpad unresponsive to clicks and
 * movement, screen totally frozen". Memory was most of that (see guardian.ts),
 * but the other half is the CPU: a diffusion worker on a 12-core machine will
 * happily run twelve threads flat out, and the window server then queues
 * behind it for every pointer move. This is a hint that makes the pointer win
 * those ties. It costs the worker nothing while the user is idle.
 *
 *   'utility'    macOS `taskpolicy -c utility` — lower CPU priority, NOT the
 *                disk-throttled background tier. The tier for heavy work in
 *                every mode: a video render still loads its 15 GB of weights
 *                at full speed, and MEASURED it keeps ~97% of the CPU's
 *                matmul throughput on an idle machine.
 *   'background' macOS `taskpolicy -b` — CPU and I/O both yield. MEASURED at
 *                155 GFLOP/s against 1826 unthrottled (efficiency cores only,
 *                idle machine or not): twelve times slower. No longer used
 *                for generation workers — kept for callers that mean it.
 */
export type WorkerTier = 'utility' | 'background';

export async function setWorkerTier(
  pid: number,
  tier: WorkerTier,
  deps: PriorityDeps = { platform: process.platform, exec: (c, a) => run(c, [...a]) },
): Promise<'applied' | 'unsupported' | 'failed'> {
  if (!Number.isFinite(pid) || pid <= 0) return 'failed';
  try {
    if (deps.platform === 'darwin') {
      // The `-p` form documents -b/-B and the -t/-l tiers; `-c utility -p`
      // exits 0 but is not documented for a running process, so utility is
      // the tiers. 'background' keeps the real DARWIN_BG tier for a caller
      // that means it (twelve times slower on CPU — see the header).
      await deps.exec(
        'taskpolicy',
        tier === 'background'
          ? ['-b', '-p', String(pid)]
          : ['-t', '5', '-l', '5', '-p', String(pid)],
      );
      return 'applied';
    }
    if (deps.platform === 'linux') {
      const nice = tier === 'background' ? LINUX_NICE : LINUX_NICE_UTILITY;
      await deps.exec('renice', ['-n', String(nice), '-p', String(pid)]);
      return 'applied';
    }
    return 'unsupported';
  } catch {
    return 'failed';
  }
}

export interface PriorityDeps {
  readonly platform: NodeJS.Platform;
  readonly exec: (cmd: string, args: readonly string[]) => Promise<unknown>;
}

/**
 * Move `pid` to background priority (or back to normal).
 *
 * Returns what it actually did, so a caller can log the truth rather than the
 * intention — "asked for background scheduling" and "this platform has no way
 * to ask" are different facts and the log should not blur them.
 */
export async function setBackgroundPriority(
  pid: number,
  background: boolean,
  deps: PriorityDeps = { platform: process.platform, exec: (c, a) => run(c, [...a]) },
): Promise<'applied' | 'unsupported' | 'failed'> {
  if (!Number.isFinite(pid) || pid <= 0) return 'failed';
  try {
    if (deps.platform === 'darwin') {
      // Tiers 5/5 yield, 0/0 is the default; both take the pid of a RUNNING
      // process. Never -b: see the header for what that costs.
      const tier = background ? '5' : '0';
      await deps.exec('taskpolicy', ['-t', tier, '-l', tier, '-p', String(pid)]);
      return 'applied';
    }
    if (deps.platform === 'linux') {
      await deps.exec('renice', ['-n', String(background ? LINUX_NICE : 0), '-p', String(pid)]);
      return 'applied';
    }
    return 'unsupported';
  } catch {
    return 'failed';
  }
}
