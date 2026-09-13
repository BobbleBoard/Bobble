/**
 * NO TEST TOUCHES THE REAL LIBRARY.
 *
 * `~/Bobble/Models` is where a person's weights live now. A unit test that
 * resolves a model path without pinning the library root would read — or
 * write a manifest into — that folder (it happened: five test manifests
 * landed in it on 2026-09-12). So every test process starts with the library
 * root pointed at a scratch folder of its own, and the cache root too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'pd-test-library-'));
process.env.PI_DESKTOP_MODELS_DIR = join(scratch, 'Models');
if (process.env.PI_DESKTOP_CACHE_DIR === undefined || process.env.PI_DESKTOP_CACHE_DIR === '') {
  process.env.PI_DESKTOP_CACHE_DIR = join(scratch, 'cache');
}
