/**
 * A copy of every file a turn is about to change, so it can be put back.
 *
 * The model writes and edits freely, which is the point of it — and until now
 * the only way to undo a turn was git, if the work happened to be in a repo and
 * happened to be committed. "Restore that file" is the smallest useful safety
 * net and it did not exist.
 *
 * ## Where it hooks
 *
 * BEFORE the write, on `tool_call` — not on the result. The `edit` tool's
 * result hook fires only on `isError`, so a successful edit would never be
 * captured, and by the time any result exists the previous content is gone.
 *
 * ## What it copies
 *
 * `copyFileSync`, not a read-and-write. The sandbox fence's own
 * snapshot-and-restore reads utf8, which silently corrupts anything that is not
 * text — an image the model is editing comes back mangled. A checkpoint that
 * damages what it was protecting is worse than none.
 *
 * ## What it does not do
 *
 * A file the turn CREATED has no previous content, and is recorded as such:
 * restoring it means deleting it, and pretending it had empty content would
 * leave an empty file behind instead.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** One file, as it was before a turn touched it. */
export interface Checkpoint {
  /** The file the turn is about to change. */
  readonly target: string;
  /** The copy, or null when the file did not exist (the turn creates it). */
  readonly backup: string | null;
  readonly bytes: number;
}

export interface TurnCheckpoints {
  readonly turnIndex: number;
  readonly files: Checkpoint[];
}

/**
 * How many turns of checkpoints to keep.
 *
 * Enough to undo something noticed a few turns later, bounded so a long session
 * editing large files cannot fill a disk. Without a limit this grows forever,
 * which is the kind of thing nobody notices until it is gigabytes.
 */
export const KEEP_TURNS = 20;

/** Skip anything above this: a checkpoint should never be the expensive part. */
export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

function safeName(target: string): string {
  return target.replace(/[^a-zA-Z0-9]+/g, '_').slice(-120);
}

/**
 * Capture a file's current state into `root`, returning what was recorded.
 *
 * Never throws: a checkpoint that fails must not fail the write it was
 * shadowing. It returns what it managed, and the caller records that.
 */
export function capture(root: string, turnIndex: number, target: string): Checkpoint | null {
  try {
    if (!existsSync(target)) {
      // Created by this turn — restoring means deleting.
      return { target, backup: null, bytes: 0 };
    }
    const stat = statSync(target);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_CHECKPOINT_BYTES) return null;
    const dir = path.join(root, String(turnIndex));
    mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, safeName(target));
    // copyFileSync, not readFile/writeFile: a utf8 round trip corrupts binaries.
    copyFileSync(target, backup);
    return { target, backup, bytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * Put a file back the way the checkpoint found it.
 *
 * A checkpoint with no backup means the turn CREATED the file, so restoring is
 * a delete — which is why `backup: null` is a real state rather than a failure.
 */
export function restore(cp: Checkpoint): { ok: boolean; error?: string } {
  try {
    if (cp.backup === null) {
      rmSync(cp.target, { force: true });
      return { ok: true };
    }
    if (!existsSync(cp.backup)) return { ok: false, error: 'that checkpoint is gone' };
    mkdirSync(path.dirname(cp.target), { recursive: true });
    copyFileSync(cp.backup, cp.target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Drop everything older than the newest {@link KEEP_TURNS} turns.
 *
 * Directory names are turn indices, so "oldest" is numeric — sorting them as
 * strings would delete turn 10 before turn 9.
 */
export function prune(root: string, keep = KEEP_TURNS): void {
  try {
    const turns = readdirSync(root)
      .map((name) => ({ name, n: Number(name) }))
      .filter((t) => Number.isFinite(t.n))
      .sort((a, b) => b.n - a.n);
    for (const stale of turns.slice(keep)) {
      rmSync(path.join(root, stale.name), { recursive: true, force: true });
    }
  } catch {
    // Housekeeping never breaks a turn.
  }
}
