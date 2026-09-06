import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRequirements, buildVariant, VARIANT_CMAKE_FLAGS } from './llamacpp-source-build.js';
import { K2_HORIZON_VARIANT } from './llamacpp-variants.js';

const SOURCE = Buffer.from('a source tarball, near enough');

/** Records what would have been run, and fakes the tree cmake would have made. */
function fakeToolchain(dir: string) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const execFileImpl = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === 'cmake' && args[0] === '--build') {
      // The compile's only observable output is the binary it leaves behind.
      const bin = join(dir, 'src', 'llama.cpp-abc', 'build', 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'llama-server'), '#!/bin/sh\n');
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, execFileImpl };
}

const fakeFetch = (body: Buffer = SOURCE) =>
  (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => body,
  })) as unknown as typeof fetch;

/** Stands in for `tar -xzf`: lays down the single directory a GitHub archive has. */
const extractInto = () => async (_archive: string, dest: string) => {
  await mkdir(join(dest, 'llama.cpp-abc'), { recursive: true });
};

describe('building an engine variant', () => {
  it('fetches the pinned commit, configures with Metal on, and returns the server it built', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'variant-'));
    const { calls, execFileImpl } = fakeToolchain(dir);
    const built = await buildVariant({
      variant: K2_HORIZON_VARIANT,
      dir,
      execFileImpl,
      fetchImpl: fakeFetch(),
      extract: extractInto(),
      jobs: 3,
    });

    expect(built.serverPath.endsWith('build/bin/llama-server')).toBe(true);
    const configure = calls.find((c) => c.cmd === 'cmake' && c.args[0] === '-B');
    expect(configure?.args).toEqual(['-B', 'build', ...VARIANT_CMAKE_FLAGS]);
    expect(VARIANT_CMAKE_FLAGS).toContain('-DGGML_METAL=ON');
    const compile = calls.find((c) => c.cmd === 'cmake' && c.args[0] === '--build');
    expect(compile?.args).toContain('3');
  });

  it('does not rebuild when the same commit is already built', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'variant-'));
    const first = fakeToolchain(dir);
    const opts = {
      variant: K2_HORIZON_VARIANT,
      dir,
      fetchImpl: fakeFetch(),
      extract: extractInto(),
    };
    await buildVariant({ ...opts, execFileImpl: first.execFileImpl });
    const second = fakeToolchain(dir);
    await buildVariant({ ...opts, execFileImpl: second.execFileImpl });
    // A compile is minutes. The second call must not run one.
    expect(second.calls).toEqual([]);
  });

  it('REBUILDS when the variant is re-pinned to a different commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'variant-'));
    const opts = { dir, fetchImpl: fakeFetch(), extract: extractInto() };
    const first = fakeToolchain(dir);
    await buildVariant({ ...opts, variant: K2_HORIZON_VARIANT, execFileImpl: first.execFileImpl });

    const moved = {
      ...K2_HORIZON_VARIANT,
      source: { ...K2_HORIZON_VARIANT.source, commit: 'f'.repeat(40) },
    };
    const second = fakeToolchain(dir);
    await buildVariant({ ...opts, variant: moved, execFileImpl: second.execFileImpl });
    /*
     * Silently keeping the old binary after a re-pin is the failure that would
     * be hardest to notice: the app runs, the model loads, and it is the wrong
     * engine.
     */
    expect(second.calls.some((c) => c.args[0] === '--build')).toBe(true);
  });

  it('refuses a source archive that changed under a pinned commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'variant-'));
    const opts = {
      variant: K2_HORIZON_VARIANT,
      dir,
      extract: extractInto(),
    };
    const first = fakeToolchain(dir);
    await buildVariant({ ...opts, execFileImpl: first.execFileImpl, fetchImpl: fakeFetch() });
    // Make the marker's binary disappear so the fast path does not short-circuit.
    const marker = join(dir, '.built.json');
    const m = JSON.parse(readFileSync(marker, 'utf8')) as { serverPath: string };
    writeFileSync(marker, JSON.stringify({ ...m, serverPath: join(dir, 'gone') }));

    const second = fakeToolchain(dir);
    await expect(
      buildVariant({
        ...opts,
        execFileImpl: second.execFileImpl,
        fetchImpl: fakeFetch(Buffer.from('a DIFFERENT tree at the same sha')),
      }),
    ).rejects.toThrow(/changed since it was last built/);
  });

  it('fails with the URL when the source cannot be fetched, not with a compiler error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'variant-'));
    const { execFileImpl } = fakeToolchain(dir);
    await expect(
      buildVariant({
        variant: K2_HORIZON_VARIANT,
        dir,
        execFileImpl,
        fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 404.*MBZUAI-IFM/s);
  });

  it('reports a missing toolchain as something to install, before anything is downloaded', async () => {
    const reqs = await buildRequirements(async (cmd) => {
      if (cmd === 'cmake') throw new Error('not found');
      return { stdout: '', stderr: '' };
    });
    const cmake = reqs.find((r) => r.tool === 'cmake');
    expect(cmake?.present).toBe(false);
    expect(cmake?.install).toMatch(/brew install cmake/);
    expect(reqs.find((r) => r.tool === 'cc')?.present).toBe(true);
  });
});
