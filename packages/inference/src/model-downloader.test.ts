/**
 * What a DOWNLOAD fetches, as distinct from what a LAUNCH loads.
 *
 * These two questions were the same option for a long time (`launchMode`), and
 * the Model Manager asked the launch one. A vision model therefore reported
 * itself fully downloaded with no projector on disk, and paid for it mid-chat
 * the first time it was shown an image.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog.js';
import { downloadModel } from './model-downloader.js';

/** A model with one of every companion, so each branch is observable. The byte
 * counts are 3 because the downloader verifies size against the catalog and the
 * stub serves a 3-byte body; only WHICH files are requested is under test. */
const KITCHEN_SINK = {
  id: 'test-model',
  displayName: 'Test',
  hfRepo: 'unsloth/Test-GGUF',
  files: [{ name: 'Test-Q4_K_M.gguf', bytes: 3, quant: 'Q4_K_M' }],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 3, quant: 'F16' },
  mtpFile: { name: 'mtp-Test.gguf', bytes: 3, quant: 'F16' },
} as unknown as CatalogModel;

/** Records which repo-relative names were asked for, and writes nothing. */
function recordingFetch(seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url.split('/').pop() ?? url);
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '3' },
    });
  }) as unknown as typeof fetch;
}

/* A FRESH DIR PER CASE. downloadModel is idempotent — an already-present,
   correctly-sized file is skipped — so a reused directory makes the second run
   fetch nothing and every assertion here vacuously wrong. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function namesFetched(opts: Parameters<typeof downloadModel>[1]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dl-'));
  dirs.push(dir);
  const seen: string[] = [];
  await downloadModel(KITCHEN_SINK, { ...opts, dir, fetchImpl: recordingFetch(seen) });
  return seen;
}

describe('downloadModel companion scope', () => {
  it('fast-text alone leaves the vision projector on the server', async () => {
    const seen = await namesFetched({ launchMode: 'fast-text' });
    expect(seen).toContain('Test-Q4_K_M.gguf');
    expect(seen).toContain('mtp-Test.gguf');
    expect(seen).not.toContain('mmproj-F16.gguf');
  });

  it('multimodal alone leaves the MTP head on the server', async () => {
    const seen = await namesFetched({ launchMode: 'multimodal' });
    expect(seen).toContain('mmproj-F16.gguf');
    expect(seen).not.toContain('mtp-Test.gguf');
  });

  it('allCompanions fetches everything the model can use, whatever the mode', async () => {
    const seen = await namesFetched({ launchMode: 'fast-text', allCompanions: true });
    expect(seen).toContain('Test-Q4_K_M.gguf');
    expect(seen).toContain('mmproj-F16.gguf');
    expect(seen).toContain('mtp-Test.gguf');
  });
});
