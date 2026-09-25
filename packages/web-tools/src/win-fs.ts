/**
 * FILE MOVES THAT SURVIVE WINDOWS' SCANNERS.
 *
 * On Windows a file that was just written — above all a new `.exe` — is opened
 * by the virus scanner (and the search indexer) as soon as it is closed. While
 * that lasts, renaming it or its folder, or deleting it, fails with EPERM,
 * EACCES or EBUSY. npm met this long ago: graceful-fs retries such renames on
 * Windows for up to a minute, and only while the destination is free.
 *
 * {@link renameRetrying} does the same with a backoff of 9.5 s in all, on
 * Windows only (elsewhere those codes mean a real permission problem and are
 * reported at once), and never waits on a destination folder that already
 * exists: Windows will not rename onto one, however long it is given.
 * {@link removeRetrying} asks Node's `rm` for its own retries on the same codes;
 * they apply only in recursive mode, so every call here is recursive (for a
 * plain file that is simply an unlink).
 *
 * Plain Node only. The operations are injectable ({@link RetryFs}), so the
 * Windows rules are unit-tested on any machine.
 */
import { rename as nodeRename, rm as nodeRm, stat } from 'node:fs/promises';

/** Error codes a scanner (or indexer) holding a file produces on Windows. */
export const RETRYABLE_ON_WINDOWS: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Waits between rename attempts on Windows: 9.5 s in all, then the error stands. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600, 3200, 3200];

/** What {@link renameRetrying} needs, and the OS whose rules apply. */
export interface RetryFs {
  /** `process.platform` of the machine the files are on: only `win32` retries. */
  readonly platform: string;
  readonly rename: (from: string, to: string) => Promise<void>;
  /** Whether `p` is an existing folder (false when it is missing or unreadable). */
  readonly isDirectory: (p: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export const defaultRetryFs: RetryFs = {
  platform: process.platform,
  rename: nodeRename,
  isDirectory,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** `rename`, retried on Windows while a scanner holds the file or folder. */
export async function renameRetrying(
  from: string,
  to: string,
  fs: RetryFs = defaultRetryFs,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const wait = RENAME_RETRY_DELAYS_MS[attempt];
      if (fs.platform !== 'win32' || !RETRYABLE_ON_WINDOWS.has(code) || wait === undefined) {
        throw err;
      }
      if (await fs.isDirectory(to)) throw err; // taken, not held: waiting cannot help
      await fs.sleep(wait);
    }
  }
}

/** Options for `rm` as {@link removeRetrying} calls it. */
export interface RemoveOptions {
  readonly recursive: true;
  readonly force: true;
  readonly maxRetries: number;
  readonly retryDelay: number;
}

/**
 * Node's retries for a held file: a linear backoff, 200 ms longer each time
 * (200 + 400 + … + 1000 = 3 s). Node applies them only when `recursive` is set.
 */
export const REMOVE_OPTIONS: RemoveOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

/**
 * Remove a file or folder (a missing one is fine), riding out a scanner's hold.
 * Recursive, so pass only temporaries this code named itself.
 */
export function removeRetrying(
  path: string,
  rm: (path: string, opts: RemoveOptions) => Promise<void> = nodeRm,
): Promise<void> {
  return rm(path, REMOVE_OPTIONS);
}
