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

/**
 * THE JOB BAR ONLY EVER MOVES FORWARDS.
 *
 * `JobProgress` says so in its own doc comment, and it was not true: the job
 * total is refused unless every planned file declares a size, and 11 of the
 * catalogue's 35 files declare none while 14 of its 19 models fetch more than
 * one file. So the ordinary multi-file download had no job denominator at all,
 * the UI fell back to the per-file fraction, and the bar filled to 100% and
 * restarted at the projector. MEASURED in the download stress probe: 1 → 0.86
 * at the file boundary.
 */
describe('downloadModel job progress', () => {
  const SIZED = {
    id: 'sized',
    displayName: 'Sized',
    hfRepo: 'org/Sized-GGUF',
    files: [{ name: 'main.gguf', bytes: 6, quant: 'Q4_K_M' }],
    mmproj: { name: 'mmproj-F16.gguf', bytes: 4, quant: 'F16' },
  } as unknown as CatalogModel;

  /** Same model with NO declared sizes — the case the catalogue actually has. */
  const UNSIZED = {
    ...SIZED,
    id: 'unsized',
    files: [{ name: 'main.gguf', bytes: 0, quant: 'Q4_K_M' }],
    mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  } as unknown as CatalogModel;

  /** Serves `main.gguf` as 6 bytes and the projector as 4, and answers HEAD with
   *  a content-length — what a mirror or proxy does. */
  function servingFetch(seen: string[]): typeof fetch {
    const bodies: Record<string, Uint8Array> = {
      'main.gguf': new Uint8Array([1, 2, 3, 4, 5, 6]),
      'mmproj-F16.gguf': new Uint8Array([7, 8, 9, 10]),
    };
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const name = String(input).split('/').pop() ?? '';
      const body = bodies[name] ?? new Uint8Array();
      seen.push(`${init?.method ?? 'GET'} ${name}`);
      if ((init?.method ?? 'GET') === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(body.length) },
        });
      }
      return new Response(body.buffer as ArrayBuffer, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      });
    }) as unknown as typeof fetch;
  }

  async function progressOf(model: CatalogModel): Promise<{
    fractions: number[];
    totals: (number | null)[];
    calls: string[];
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'pi-dl-'));
    dirs.push(dir);
    const calls: string[] = [];
    const fractions: number[] = [];
    const totals: (number | null)[] = [];
    await downloadModel(model, {
      dir,
      allCompanions: true,
      fetchImpl: servingFetch(calls),
      onProgress: (_file, p) => {
        totals.push(p.jobTotal);
        if (p.jobTotal !== null && p.jobTotal > 0) fractions.push(p.jobReceived / p.jobTotal);
      },
    });
    return { fractions, totals, calls };
  }

  it('reports a job total for a model whose sizes are all declared', async () => {
    const { totals } = await progressOf(SIZED);
    expect(totals.every((t) => t === 10)).toBe(true);
  });

  it('LEARNS the total for a model that declares none, with one HEAD per file', async () => {
    const { totals, calls } = await progressOf(UNSIZED);
    expect(totals.every((t) => t === 10)).toBe(true);
    expect(calls.filter((c) => c.startsWith('HEAD'))).toEqual([
      'HEAD main.gguf',
      'HEAD mmproj-F16.gguf',
    ]);
  });

  it('never goes backwards across the file boundary', async () => {
    const { fractions } = await progressOf(UNSIZED);
    expect(fractions.length).toBeGreaterThan(1);
    const sorted = [...fractions].sort((a, b) => a - b);
    expect(fractions).toEqual(sorted);
    expect(fractions.at(-1)).toBeCloseTo(1, 5);
  });

  it('falls back to no total when a size cannot be learned, rather than guessing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-dl-'));
    dirs.push(dir);
    const totals: (number | null)[] = [];
    const noHead: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 500 });
      const name = String(input).split('/').pop() ?? '';
      const body = name === 'main.gguf' ? new Uint8Array([1, 2, 3, 4, 5, 6]) : new Uint8Array(4);
      return new Response(body.buffer as ArrayBuffer, { status: 200 });
    }) as unknown as typeof fetch;
    await downloadModel(UNSIZED, {
      dir,
      allCompanions: true,
      fetchImpl: noHead,
      onProgress: (_f, p) => totals.push(p.jobTotal),
    });
    expect(totals.every((t) => t === null)).toBe(true);
  });
});
