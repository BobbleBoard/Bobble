/**
 * A `timeout` command, because macOS does not ship one.
 *
 * FOUR runs have been wedged by a single shell call that never returned: two
 * Godot editors (`-e`, and a bare `--path`), and `godot --headless --path .`
 * without `--quit`, which runs the game loop forever. Each held its run hostage
 * until the ten-minute per-call watchdog fired.
 *
 * The instruction to wrap commands in `timeout 60` was right and I had to
 * withdraw it, because the command does not exist here (nor `gtimeout`). Naming
 * a mechanism that is not there is its own failure — so instead of removing the
 * advice, provide the mechanism. A dozen lines of POSIX sh on PATH makes every
 * command self-terminating, with no per-command pattern matching and nothing to
 * keep up to date as new ways to hang are discovered.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHIM = `#!/bin/sh
# timeout SECONDS COMMAND... — kill COMMAND if it outlives SECONDS.
# Provided by Bobble because macOS ships no timeout(1).
secs=$1
shift
"$@" &
cmd=$!
( sleep "$secs" 2>/dev/null; kill -TERM $cmd 2>/dev/null; sleep 2; kill -KILL $cmd 2>/dev/null ) >/dev/null 2>&1 &
killer=$!
wait $cmd
rc=$?
kill $killer >/dev/null 2>&1
exit $rc
`;

/** Where the shim lives — beside the app's other state, not in the user's tree. */
export function shimBinDir(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'bin');
}

/**
 * Ensure a working `timeout` is on PATH for everything this process spawns.
 * Idempotent, and a no-op when the platform already has one. Returns the bin
 * directory, or null when it could not be created (the caller carries on — a
 * missing shim costs a hang, not a crash).
 */
export function ensureTimeoutShim(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = shimBinDir();
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'timeout');
    if (!existsSync(file)) {
      writeFileSync(file, SHIM, 'utf8');
      chmodSync(file, 0o755);
    }
    const current = env.PATH ?? '';
    if (!current.split(':').includes(dir)) env.PATH = `${dir}:${current}`;
    return dir;
  } catch {
    return null;
  }
}
