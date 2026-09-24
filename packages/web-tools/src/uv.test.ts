import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChecksumMismatchError } from './download.js';
import { buildZip } from './testing/zip-builder.js';
import { ensureUv, readUvMarker, UV_MARKER, uvInstallDir } from './uv.js';
import { PINNED_UV } from './uv-pins.js';
import {
  UnsupportedUvHostError,
  type UvHost,
  type UvRelease,
  uvAssetUrl,
  uvReleaseForTarget,
} from './uv-platform.js';

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
});

const MAC: UvHost = { platform: 'darwin', arch: 'arm64', appleSilicon: true };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The pinned release for `target`, re-pinned to bytes a test serves. */
function releaseFor(target: string, bytes: Buffer): UvRelease {
  return { ...uvReleaseForTarget(target), sha256: sha(bytes) };
}

/** A fetch that serves `bytes` for the asset URL and records every request. */
function serving(bytes: Buffer): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
}

const never = (() => {
  throw new Error('should not be called on the cached path');
}) as unknown as typeof fetch;

describe('ensureUv PATH detection', () => {
  it('resolves an existing uv from a scanned PATH', async () => {
    const bindir = join(workdir, 'bin');
    await mkdir(bindir, { recursive: true });
    await writeFile(join(bindir, 'uv'), '#!/bin/sh\n');
    const install = await ensureUv({ pathEnv: bindir, host: MAC });
    expect(install.source).toBe('path');
    expect(install.uvPath).toBe(join(bindir, 'uv'));
  });

  it('looks for uv.exe on Windows, not a bare uv', async () => {
    const plain = join(workdir, 'plain');
    const exe = join(workdir, 'exe dir');
    await mkdir(plain, { recursive: true });
    await mkdir(exe, { recursive: true });
    await writeFile(join(plain, 'uv'), 'not a windows binary');
    await writeFile(join(exe, 'uv.exe'), 'MZ');
    const pathEnv = [plain, `"${exe}"`].join(process.platform === 'win32' ? ';' : ':');
    const install = await ensureUv({ pathEnv, host: { platform: 'win32', arch: 'x64' } });
    expect(install).toEqual({ uvPath: join(exe, 'uv.exe'), source: 'path' });
  });

  it('uses a uv on PATH even on a machine uv publishes no build for', async () => {
    const bindir = join(workdir, 'bin');
    await mkdir(bindir, { recursive: true });
    await writeFile(join(bindir, 'uv'), '#!/bin/sh\n');
    const install = await ensureUv({ pathEnv: bindir, host: { platform: 'freebsd', arch: 'x64' } });
    expect(install.source).toBe('path');
  });
});

describe('ensureUv download path (injected fetch + extract)', () => {
  const bytes = Buffer.from('fake-uv-tarball-contents-1234567890');
  const release = releaseFor('aarch64-apple-darwin', bytes);
  const extract = async (_archive: string, destDir: string): Promise<void> => {
    const inner = join(destDir, 'uv-aarch64-apple-darwin');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'uv'), '#!/bin/sh\necho uv');
    await writeFile(join(inner, 'uvx'), '#!/bin/sh\necho uvx');
  };

  it('downloads the asset, verifies it, extracts, and records a marker', async () => {
    const dir = join(workdir, 'cache');
    const fetchImpl = serving(bytes);
    const install = await ensureUv({ ignorePath: true, dir, fetchImpl, extract, release });
    expect(install).toEqual({
      uvPath: join(dir, 'uv-aarch64-apple-darwin', 'uv'),
      source: 'download',
      version: PINNED_UV.version,
      target: 'aarch64-apple-darwin',
    });
    expect(existsSync(install.uvPath)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(install.uvPath).mode & 0o111).not.toBe(0);
    // One request, for the asset itself: no checksum is fetched from beside it.
    expect(fetchImpl.urls).toEqual([uvAssetUrl(release)]);
    const marker = JSON.parse(await readFile(join(dir, UV_MARKER), 'utf8'));
    expect(marker).toEqual({
      version: PINNED_UV.version,
      uvPath: install.uvPath,
      target: 'aarch64-apple-darwin',
      assetName: 'uv-aarch64-apple-darwin.tar.gz',
      sha256: release.sha256,
    });
    // Nothing else is left behind: no archive, no staging folder.
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, 'uv-aarch64-apple-darwin']);
  });

  it('is idempotent — a second call uses the marker without fetching again', async () => {
    const dir = join(workdir, 'cache2');
    const first = await ensureUv({
      ignorePath: true,
      dir,
      fetchImpl: serving(bytes),
      extract,
      release,
    });
    const second = await ensureUv({
      ignorePath: true,
      dir,
      release,
      fetchImpl: never,
      extract: () => Promise.reject(new Error('should not extract again')),
    });
    expect(second.uvPath).toBe(first.uvPath);
  });

  it('checks the PINNED sha256: bytes that do not match it are refused', async () => {
    const dir = join(workdir, 'cache3');
    await expect(
      ensureUv({
        ignorePath: true,
        dir,
        host: MAC,
        fetchImpl: serving(bytes),
        extract,
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    await expect(
      ensureUv({ ignorePath: true, dir, host: MAC, fetchImpl: serving(bytes), extract }),
    ).rejects.toThrow(
      /sha256 mismatch: expected 33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232/,
    );
    expect(existsSync(join(dir, UV_MARKER))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('asks the pinned build for the host it is given', async () => {
    const dir = join(workdir, 'hosts');
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('wrong bytes');
    }) as typeof fetch;
    const hosts: UvHost[] = [
      { platform: 'win32', arch: 'arm64' },
      { platform: 'linux', arch: 'x64', libc: 'glibc', glibcVersion: '2.39' },
      { platform: 'linux', arch: 'arm64', libc: 'musl' },
      { platform: 'darwin', arch: 'x64', appleSilicon: false },
    ];
    for (const host of hosts) {
      await ensureUv({ ignorePath: true, dir, host, fetchImpl, extract }).catch(() => undefined);
    }
    const base = `https://github.com/astral-sh/uv/releases/download/${PINNED_UV.version}`;
    expect(seen).toEqual([
      `${base}/uv-aarch64-pc-windows-msvc.zip`,
      `${base}/uv-x86_64-unknown-linux-gnu.tar.gz`,
      `${base}/uv-aarch64-unknown-linux-musl.tar.gz`,
      `${base}/uv-x86_64-apple-darwin.tar.gz`,
    ]);
  });

  it('refuses a machine with no build, before any download', async () => {
    await expect(
      ensureUv({
        ignorePath: true,
        dir: join(workdir, 'bsd'),
        host: { platform: 'freebsd', arch: 'x64' },
        fetchImpl: never,
      }),
    ).rejects.toBeInstanceOf(UnsupportedUvHostError);
  });

  it('shares one download between concurrent callers', async () => {
    const dir = join(workdir, 'race');
    const fetchImpl = serving(bytes);
    const results = await Promise.all(
      [1, 2, 3].map(() => ensureUv({ ignorePath: true, dir, fetchImpl, extract, release })),
    );
    expect(new Set(results.map((r) => r.uvPath)).size).toBe(1);
    expect(fetchImpl.urls.length).toBe(1);
  });

  it('leaves no install and no marker when extraction fails', async () => {
    const dir = join(workdir, 'broken');
    await expect(
      ensureUv({
        ignorePath: true,
        dir,
        release,
        fetchImpl: serving(bytes),
        extract: async (_a, dest) => {
          await mkdir(join(dest, 'uv-aarch64-apple-darwin'), { recursive: true });
          await writeFile(join(dest, 'uv-aarch64-apple-darwin', 'half'), 'x');
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('says which binary it could not find in an archive', async () => {
    await expect(
      ensureUv({
        ignorePath: true,
        dir: join(workdir, 'empty'),
        release,
        fetchImpl: serving(bytes),
        extract: async () => {},
      }),
    ).rejects.toThrow(/uv not found in uv-aarch64-apple-darwin\.tar\.gz/);
  });

  it('replaces a half-written folder an interrupted older install left behind', async () => {
    const dir = join(workdir, 'stale');
    await mkdir(join(dir, 'uv-aarch64-apple-darwin'), { recursive: true });
    await writeFile(join(dir, 'uv-aarch64-apple-darwin', 'uvx'), 'truncated');
    const install = await ensureUv({
      ignorePath: true,
      dir,
      release,
      fetchImpl: serving(bytes),
      extract,
    });
    expect(await readFile(install.uvPath, 'utf8')).toBe('#!/bin/sh\necho uv');
    expect(await readFile(join(dir, 'uv-aarch64-apple-darwin', 'uvx'), 'utf8')).toBe(
      '#!/bin/sh\necho uvx',
    );
  });
});

describe('ensureUv with the real extractors', () => {
  it('installs a Windows zip: uv.exe lands in uv-<target>/ with its siblings', async () => {
    const zip = buildZip([
      { name: 'uv.exe', data: 'MZ uv' },
      { name: 'uvx.exe', data: 'MZ uvx' },
      { name: 'uvw.exe', data: 'MZ uvw' },
    ]);
    const dir = join(workdir, 'win');
    const install = await ensureUv({
      ignorePath: true,
      dir,
      release: releaseFor('x86_64-pc-windows-msvc', zip),
      fetchImpl: serving(zip),
    });
    expect(install.uvPath).toBe(join(uvInstallDir(dir, 'x86_64-pc-windows-msvc'), 'uv.exe'));
    expect(await readFile(install.uvPath, 'utf8')).toBe('MZ uv');
    expect(readdirSync(uvInstallDir(dir, 'x86_64-pc-windows-msvc')).sort()).toEqual([
      'uv.exe',
      'uvw.exe',
      'uvx.exe',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'installs a Linux tar.gz with `tar` and keeps the executable bit',
    async () => {
      const src = join(workdir, 'src');
      const folder = join(src, 'uv-x86_64-unknown-linux-gnu');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'uv'), '#!/bin/sh\necho uv 0.0.0\n', { mode: 0o755 });
      await writeFile(join(folder, 'uvx'), '#!/bin/sh\n', { mode: 0o755 });
      const tgz = join(workdir, 'uv.tar.gz');
      execFileSync('tar', ['-czf', tgz, '-C', src, 'uv-x86_64-unknown-linux-gnu']);
      const bytes = await readFile(tgz);
      const dir = join(workdir, 'linux');
      const install = await ensureUv({
        ignorePath: true,
        dir,
        release: releaseFor('x86_64-unknown-linux-gnu', bytes),
        fetchImpl: serving(bytes),
      });
      expect(install.uvPath).toBe(join(dir, 'uv-x86_64-unknown-linux-gnu', 'uv'));
      expect(statSync(install.uvPath).mode & 0o111).not.toBe(0);
      expect(readdirSync(dir).sort()).toEqual([UV_MARKER, 'uv-x86_64-unknown-linux-gnu']);
    },
  );
});

describe('the install marker', () => {
  const mac = uvReleaseForTarget('aarch64-apple-darwin');

  async function legacyInstall(dir: string, recordedPath?: string): Promise<string> {
    const bin = join(dir, 'uv-aarch64-apple-darwin', 'uv');
    await mkdir(join(dir, 'uv-aarch64-apple-darwin'), { recursive: true });
    await writeFile(bin, '#!/bin/sh\n');
    // Exactly what the macOS-only bootstrap wrote: no target, no digest.
    await writeFile(
      join(dir, UV_MARKER),
      JSON.stringify({ version: PINNED_UV.version, uvPath: recordedPath ?? bin }, null, 2),
    );
    return bin;
  }

  it('honours a copy installed before per-platform pins (it can only be macOS arm64)', async () => {
    const dir = join(workdir, 'legacy');
    const bin = await legacyInstall(dir);
    const install = await ensureUv({ ignorePath: true, dir, host: MAC, fetchImpl: never });
    expect(install.uvPath).toBe(bin);
    expect(readUvMarker(dir, mac)).toBe(bin);
  });

  it('does not let that old marker stand in for another platform', async () => {
    const dir = join(workdir, 'legacy-win');
    await legacyInstall(dir);
    expect(readUvMarker(dir, uvReleaseForTarget('x86_64-pc-windows-msvc'))).toBeUndefined();
    const zip = buildZip([{ name: 'uv.exe', data: 'MZ' }]);
    const install = await ensureUv({
      ignorePath: true,
      dir,
      release: releaseFor('x86_64-pc-windows-msvc', zip),
      fetchImpl: serving(zip),
    });
    expect(install.target).toBe('x86_64-pc-windows-msvc');
  });

  it('finds the binary after the cache folder moved (a renamed cache root)', async () => {
    const dir = join(workdir, 'moved');
    const bin = await legacyInstall(dir, '/somewhere/that/was/renamed/uv-aarch64-apple-darwin/uv');
    expect(readUvMarker(dir, mac)).toBe(bin);
  });

  it('ignores a marker for another version, a corrupt marker, or a missing binary', async () => {
    const dir = join(workdir, 'odd');
    const bin = await legacyInstall(dir);
    expect(readUvMarker(dir, { ...mac, version: '0.0.1' })).toBeUndefined();
    await writeFile(join(dir, UV_MARKER), '{ not json');
    expect(readUvMarker(dir, mac)).toBeUndefined();
    await rm(bin);
    await writeFile(
      join(dir, UV_MARKER),
      JSON.stringify({ version: PINNED_UV.version, uvPath: bin }),
    );
    expect(readUvMarker(dir, mac)).toBeUndefined();
  });
});
