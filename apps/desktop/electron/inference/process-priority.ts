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
 * macOS: `taskpolicy -b -p <pid>` moves a running process to the background QoS
 * tier (verified: exits 0 without sudo). Linux: `renice`. Windows has no
 * equivalent we can reach from here without a native module, so it is a no-op —
 * and saying so is better than pretending.
 *
 * Best-effort throughout: a missing tool or a refused call is not an error, it
 * is a machine where this particular lever does not exist.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Nice value for a backgrounded server on Linux. 10 is "yield readily". */
const LINUX_NICE = 10;

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
      // -b backgrounds, -B restores. Both take the pid of a RUNNING process.
      await deps.exec('taskpolicy', [background ? '-b' : '-B', '-p', String(pid)]);
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
