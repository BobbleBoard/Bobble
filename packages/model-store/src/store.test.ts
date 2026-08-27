import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesAllow, selectFiles } from './download-repo.js';
import { entryDir, slugFor, storeRoot } from './layout.js';
import { parseManifest, type StoredModel, serializeManifest, totalBytes } from './manifest.js';
import { findByRepo, listStore, readManifest, removeStored, writeManifest } from './store.js';

const model = (over: Partial<StoredModel> & { repo: string; dir: string }): StoredModel => ({
  id: slugFor(over.repo),
  name: over.repo,
  org: over.repo.split('/')[0] ?? '',
  kind: 'text',
  files: [],
  bytes: 0,
  installedAt: '2026-08-20T00:00:00.000Z',
  source: 'store',
  ...over,
});

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'model-store-'));
}

describe('layout', () => {
  it('slugs a repo into one legible, collision-free directory name', () => {
    expect(slugFor('Lightricks/LTX-2.5')).toBe('lightricks__ltx-2.5');
    // Two orgs publishing the same model name must not share a directory.
    expect(slugFor('a/model')).not.toBe(slugFor('b/model'));
  });

  it('lowercases, because macOS would otherwise make two entries one directory', () => {
    expect(slugFor('Qwen/Qwen-Image')).toBe(slugFor('qwen/qwen-image'));
  });

  it('files a model under what it MAKES', () => {
    expect(entryDir('video', 'Lightricks/LTX-2.5', '/tmp/c')).toBe(
      '/tmp/c/store/video/lightricks__ltx-2.5',
    );
  });
});

describe('manifest', () => {
  it('round-trips', () => {
    const m = model({ repo: 'org/name', dir: '/tmp/x', bytes: 42 });
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it('rejects a file that is not a manifest rather than inventing one', () => {
    expect(parseManifest('not json')).toBeUndefined();
    expect(parseManifest('{"version":1}')).toBeUndefined();
    // Missing the fields the app would misbehave without.
    expect(parseManifest('{"version":1,"model":{"id":"x"}}')).toBeUndefined();
  });

  it('keeps a manifest written by a LATER version listable', () => {
    // A model that exists on disk and is invisible in the UI is the worse bug.
    const text = JSON.stringify({
      version: 99,
      model: { id: 'a', repo: 'o/n', dir: '/tmp/a', kind: 'image', futureField: true },
    });
    expect(parseManifest(text)?.id).toBe('a');
  });

  it('totals disk across entries', () => {
    expect(
      totalBytes([
        model({ repo: 'a/b', dir: '/1', bytes: 10 }),
        model({ repo: 'c/d', dir: '/2', bytes: 32 }),
      ]),
    ).toBe(42);
  });
});

describe('the index', () => {
  it('lists what it has written, across kinds', async () => {
    const root = await scratch();
    await writeManifest(
      model({ repo: 'a/text', dir: entryDir('text', 'a/text', root), kind: 'text' }),
    );
    await writeManifest(
      model({ repo: 'b/vid', dir: entryDir('video', 'b/vid', root), kind: 'video' }),
    );
    const all = await listStore({ root });
    expect(all.map((m) => m.repo).sort()).toEqual(['a/text', 'b/vid']);
  });

  it('SKIPS a directory with no manifest instead of guessing a model from it', async () => {
    // Half a download is not a model, and inferring one is how a hub ends up
    // listing something the user cannot run.
    const root = await scratch();
    const orphan = join(storeRoot(root), 'image', 'loose-files');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'weights.safetensors'), 'x');
    expect(await listStore({ root })).toEqual([]);
  });

  it('finds by repo id as well as by slug', async () => {
    const root = await scratch();
    await writeManifest(
      model({
        repo: 'Lightricks/LTX-2.5',
        dir: entryDir('video', 'Lightricks/LTX-2.5', root),
        kind: 'video',
      }),
    );
    expect((await findByRepo('Lightricks/LTX-2.5', { root }))?.repo).toBe('Lightricks/LTX-2.5');
  });

  it('marks an interrupted download so a crash cannot pass as a finished model', async () => {
    const root = await scratch();
    const dir = entryDir('video', 'x/y', root);
    await writeManifest(model({ repo: 'x/y', dir, kind: 'video', incomplete: true }));
    expect((await readManifest(dir))?.incomplete).toBe(true);
  });

  it('refuses to delete weights another component owns', async () => {
    // A GGUF lives in the supervisor's directory and a 3D repo in the engine's
    // HF cache; deleting either from here leaves its owner believing it is still
    // installed.
    const root = await scratch();
    const dir = entryDir('text', 'o/gguf', root);
    await writeManifest(model({ repo: 'o/gguf', dir, source: 'llm' }));
    await expect(removeStored(slugFor('o/gguf'), { root })).rejects.toThrow(/owned by the llm/);
  });

  it('deletes what it does own', async () => {
    const root = await scratch();
    const dir = entryDir('text', 'o/mine', root);
    await writeManifest(model({ repo: 'o/mine', dir }));
    await removeStored(slugFor('o/mine'), { root });
    expect(await listStore({ root })).toEqual([]);
  });
});

describe('choosing what to fetch', () => {
  it('takes the whole repo when nothing is specified', () => {
    expect(matchesAllow('anything/at/all.bin', undefined)).toBe(true);
    expect(matchesAllow('anything/at/all.bin', [])).toBe(true);
  });

  it('matches the prefix globs the 3D registry already uses', () => {
    expect(matchesAllow('ckpts/ss_dec_conv3d_16l8_fp16.safetensors', ['ckpts/ss_dec_*'])).toBe(
      true,
    );
    expect(matchesAllow('ckpts/other.safetensors', ['ckpts/ss_dec_*'])).toBe(false);
    expect(matchesAllow('config.json', ['config.json', 'model.safetensors'])).toBe(true);
  });

  it('drops git furniture when there are real weights beside it', () => {
    const files = [
      { path: '.gitattributes', sizeBytes: 1 },
      { path: 'model.safetensors', sizeBytes: 1_000_000 },
    ];
    expect(selectFiles(files).map((f) => f.path)).toEqual(['model.safetensors']);
  });

  it('keeps everything when the repo has no weighty file — an honest zero', () => {
    const files = [{ path: '.gitattributes', sizeBytes: 1 }, { path: 'README.md' }];
    expect(selectFiles(files)).toHaveLength(2);
  });
});
