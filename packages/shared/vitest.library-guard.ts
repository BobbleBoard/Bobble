/**
 * NO TEST TOUCHES THE REAL LIBRARY.
 *
 * `~/Bobble/Models` is where a person's weights live now. A unit test that
 * resolves a model path without pinning the library root would read — or
 * write a manifest into — that folder (it happened: five test manifests
 * landed in it on 2026-09-12). So every test process starts with the library
 * root pointed at a scratch folder of its own, and the cache root too.
 *
 * AND NOTHING IS LEFT BEHIND. This file is a vitest `setupFiles` entry, which
 * is evaluated once PER TEST FILE, so an eager `mkdtempSync` here minted one
 * `pd-test-library-*` folder per file and nothing ever removed them: the
 * desktop suite alone left 206 (one per test file, every one of them empty)
 * in $TMPDIR per `vitest run`, and 3,038 had piled up by 2026-09-17. Two
 * things make the cleanup deterministic rather than best-effort:
 *
 *   - The folder is RESERVED here, not created. Whoever writes under the root
 *     creates it (every writer uses a recursive mkdir), so a test file that
 *     never touches the library leaves no folder at all — including a file
 *     whose tests are all skipped, for which vitest runs NO hooks.
 *   - The `afterAll` below removes it once the file is done. Hooks run in
 *     `stack` order (the default): this one is registered before the test
 *     file's own hooks, so it runs after them and their teardown still sees
 *     the library.
 *
 * A process-exit handler would NOT do instead: vitest stops its fork workers
 * with SIGTERM, which ends a Node process without emitting `exit`.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const scratch = join(tmpdir(), `pd-test-library-${randomUUID()}`);
process.env.PI_DESKTOP_MODELS_DIR = join(scratch, 'Models');
if (process.env.PI_DESKTOP_CACHE_DIR === undefined || process.env.PI_DESKTOP_CACHE_DIR === '') {
  process.env.PI_DESKTOP_CACHE_DIR = join(scratch, 'cache');
}

afterAll(() => {
  // Only ever the path minted above — never whatever a test later pointed the
  // variables at. `force` makes the untouched (never created) case a no-op.
  rmSync(scratch, { recursive: true, force: true });
});
