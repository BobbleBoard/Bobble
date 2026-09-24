/**
 * ensureUv under WINDOWS' FILE RULES, on any machine.
 *
 * The CI run on real Windows runners is deferred (PLAN §2.2 R16: it needs the user's
 * push), so these tests give the install a file system that behaves the way
 * Windows does where it differs from macOS and Linux, on top of real temp dirs:
 *   - a scanner can hold a file it just saw written: rename and delete fail with
 *     EBUSY for a while (Node's `rm` retries such holds when asked to);
 *   - a running executable cannot be deleted, and the folder holding it cannot
 *     be renamed; a recursive delete removes everything else and then fails;
 *   - nothing can be renamed onto an existing folder, empty or not;
 *   - PATH is `;`-separated with `\` paths, and entries may be quoted.
 * Underneath, the real operations still go through the real retries, so on an
 * actual Windows runner the scanner holding these files does no harm either.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildZip } from './testing/zip-builder.js';
import { ensureUv, UV_MARKER, type UvInstallFs, uvInstallDir } from './uv.js';
import { type UvRelease, uvReleaseForTarget } from './uv-platform.js';
import {
  REMOVE_OPTIONS,
  RENAME_RETRY_DELAYS_MS,
  type RemoveOptions,
  renameRetrying,
} from './win-fs.js';

const TARGET = 'x86_64-pc-windows-msvc';

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-win-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
});

const zip = buildZip([
  { name: 'uv.exe', data: 'MZ new uv' },
  { name: 'uvx.exe', data: 'MZ new uvx' },
  { name: 'uvw.exe', data: 'MZ new uvw' },
]);
const release: UvRelease = {
  ...uvReleaseForTarget(TARGET),
  sha256: createHash('sha256').update(zip).digest('hex'),
};
const fetchImpl = (async () => new Response(new Uint8Array(zip))) as typeof fetch;

interface Hold {
  readonly match: (path: string) => boolean;
  /** Attempts that fail while the scanner holds the file. */
  times: number;
}

interface WindowsRules {
  /** Files Windows is running as a program: undeletable, and their folders unmovable. */
  readonly running?: readonly string[];
  /** A scanner holding the source of a rename. */
  readonly renameHolds?: Hold[];
  /** A scanner holding a file being removed; Node's `rm` retries `maxRetries` times. */
  readonly rmHolds?: Hold[];
  /** Runs before each rename (another process acting at that moment). */
  readonly beforeRename?: (from: string, to: string) => Promise<void>;
}

function errno(code: string, op: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${op} '${path}'`), { code });
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** A file system with Windows' rules, over the real one. */
function windowsLikeFs(rules: WindowsRules = {}) {
  const sleeps: number[] = [];
  const running = new Set((rules.running ?? []).map((p) => resolve(p)));
  const holdsRunning = (dir: string): boolean =>
    [...running].some((f) => f.startsWith(`${resolve(dir)}${sep}`));

  /** Node's recursive rm as it behaves on Windows: removes what it can, then fails. */
  async function removeTree(p: string, opts: RemoveOptions): Promise<void> {
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && opts.force) return;
      throw err;
    }
    if (st.isDirectory()) {
      let first: unknown;
      for (const name of await readdir(p)) {
        await removeTree(join(p, name), opts).catch((err) => {
          first ??= err;
        });
      }
      if (first !== undefined) throw first;
      await rm(p, REMOVE_OPTIONS);
      return;
    }
    if (running.has(resolve(p))) throw errno('EPERM', 'unlink', p);
    await rm(p, REMOVE_OPTIONS);
  }

  const fs: Partial<UvInstallFs> = {
    platform: 'win32',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    isDirectory: isDir,
    isFile: async (p) => {
      try {
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },
    rename: async (from, to) => {
      await rules.beforeRename?.(from, to);
      const hold = rules.renameHolds?.find((h) => h.times > 0 && h.match(from));
      if (hold !== undefined) {
        hold.times--;
        throw errno('EBUSY', 'rename', from);
      }
      if (holdsRunning(from)) throw errno('EPERM', 'rename', from);
      if (await isDir(to)) throw errno('EPERM', 'rename', to);
      await renameRetrying(from, to); // this machine's own rules, with real waits
    },
    rm: async (p, opts) => {
      const hold = rules.rmHolds?.find((h) => h.times > 0 && h.match(p));
      if (hold !== undefined) {
        // Node retries up to maxRetries times; a longer hold outlasts them.
        if (hold.times > opts.maxRetries) throw errno('EBUSY', 'rm', p);
        hold.times = 0;
      }
      await removeTree(p, opts);
    },
  };
  return { fs, sleeps };
}

async function oldCopy(dir: string): Promise<string> {
  const installDir = uvInstallDir(dir, TARGET);
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, 'uv.exe'), 'MZ old uv');
  await writeFile(join(installDir, 'uvx.exe'), 'MZ old uvx');
  await writeFile(join(installDir, 'uvw.exe'), 'MZ old uvw');
  return installDir;
}

const EXES = ['uv.exe', 'uvw.exe', 'uvx.exe'];

describe('ensureUv under Windows file rules', () => {
  it('waits out a scanner holding the fresh uv.exe and its folder, then installs', async () => {
    const dir = join(workdir, 'held');
    const { fs, sleeps } = windowsLikeFs({
      renameHolds: [
        // extractZip's move of the finished `uv.exe.<pid>.unzip-part` to `uv.exe`
        { match: (p) => p.endsWith('.unzip-part') && p.includes(`${sep}uv.exe.`), times: 2 },
        // the unpacked folder moving into place
        { match: (p) => p.endsWith('.staging'), times: 2 },
      ],
    });
    const install = await ensureUv({ ignorePath: true, dir, release, fetchImpl, fs });
    const installDir = uvInstallDir(dir, TARGET);
    expect(install.uvPath).toBe(join(installDir, 'uv.exe'));
    expect(sleeps).toEqual([100, 200, 100, 200]);
    expect(readdirSync(installDir).sort()).toEqual(EXES);
    expect(await readFile(install.uvPath, 'utf8')).toBe('MZ new uv');
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, `uv-${TARGET}`]);
  });

  it('fails cleanly when the hold outlasts the wait: no marker, no leftovers', async () => {
    const dir = join(workdir, 'stuck');
    const { fs, sleeps } = windowsLikeFs({
      renameHolds: [{ match: (p) => p.endsWith('.staging'), times: 1_000 }],
    });
    await expect(ensureUv({ ignorePath: true, dir, release, fetchImpl, fs })).rejects.toMatchObject(
      { code: 'EBUSY' },
    );
    expect(sleeps).toEqual([...RENAME_RETRY_DELAYS_MS]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps an older copy whose uv.exe is running WHOLE — never half deleted', async () => {
    const dir = join(workdir, 'running');
    const installDir = await oldCopy(dir);
    const { fs } = windowsLikeFs({ running: [join(installDir, 'uv.exe')] });
    const install = await ensureUv({ ignorePath: true, dir, release, fetchImpl, fs });
    expect(install.uvPath).toBe(join(installDir, 'uv.exe'));
    // A delete in place would have taken uvx.exe and uvw.exe and left uv.exe alone.
    expect(readdirSync(installDir).sort()).toEqual(EXES);
    expect(await readFile(join(installDir, 'uvx.exe'), 'utf8')).toBe('MZ old uvx');
    expect(await readFile(join(installDir, 'uv.exe'), 'utf8')).toBe('MZ old uv');
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, `uv-${TARGET}`]);
  });

  it('replaces an older copy that is not running, leaving nothing aside', async () => {
    const dir = join(workdir, 'stale');
    const installDir = await oldCopy(dir);
    const { fs, sleeps } = windowsLikeFs();
    await ensureUv({ ignorePath: true, dir, release, fetchImpl, fs });
    expect(readdirSync(installDir).sort()).toEqual(EXES);
    expect(await readFile(join(installDir, 'uvx.exe'), 'utf8')).toBe('MZ new uvx');
    expect(sleeps).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, `uv-${TARGET}`]);
  });

  it('uses the copy another process moved in first, without waiting on the taken name', async () => {
    const dir = join(workdir, 'race');
    let raced = false;
    const { fs, sleeps } = windowsLikeFs({
      beforeRename: async (from) => {
        if (raced || !from.endsWith('.staging')) return;
        raced = true;
        await oldCopy(dir); // the other process's finished install lands now
      },
    });
    const install = await ensureUv({ ignorePath: true, dir, release, fetchImpl, fs });
    expect(install.uvPath).toBe(join(uvInstallDir(dir, TARGET), 'uv.exe'));
    expect(await readFile(install.uvPath, 'utf8')).toBe('MZ old uv');
    expect(sleeps).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, `uv-${TARGET}`]);
  });

  it('uses a copy another process finished while this one downloaded: no wait, no replace', async () => {
    // The app and its pi child both bootstrap uv at first run. Here the other one
    // finishes (marker written) during this download and is already running its
    // uv.exe; replacing that copy could only wait out the running file (9.5 s).
    const dir = join(workdir, 'finished-meanwhile');
    const installDir = uvInstallDir(dir, TARGET);
    const { fs, sleeps } = windowsLikeFs({ running: [join(installDir, 'uv.exe')] });
    const otherFinishes = (async () => {
      await oldCopy(dir);
      await writeFile(
        join(dir, UV_MARKER),
        JSON.stringify({
          version: release.version,
          uvPath: join(installDir, 'uv.exe'),
          target: TARGET,
          assetName: release.assetName,
          sha256: release.sha256,
        }),
      );
      return new Response(new Uint8Array(zip));
    }) as typeof fetch;
    const install = await ensureUv({
      ignorePath: true,
      dir,
      release,
      fetchImpl: otherFinishes,
      fs,
    });
    expect(install.uvPath).toBe(join(installDir, 'uv.exe'));
    expect(await readFile(install.uvPath, 'utf8')).toBe('MZ old uv');
    expect(sleeps).toEqual([]);
    expect(readdirSync(installDir).sort()).toEqual(EXES);
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, `uv-${TARGET}`]);
  });

  it('removes the download and staging folder through a scanner’s brief hold', async () => {
    const dir = join(workdir, 'cleanup');
    const holds: Hold[] = [
      { match: (p) => p.endsWith('.download'), times: 3 },
      { match: (p) => p.endsWith('.staging'), times: 3 },
    ];
    const { fs } = windowsLikeFs({ rmHolds: holds });
    await ensureUv({ ignorePath: true, dir, release, fetchImpl, fs });
    expect(holds.map((h) => h.times)).toEqual([0, 0]);
    expect(readdirSync(dir).sort()).toEqual([UV_MARKER, `uv-${TARGET}`]);
  });

  it('removes the partial download when the digest is wrong, under the same holds', async () => {
    const dir = join(workdir, 'mismatch');
    const { fs } = windowsLikeFs({
      rmHolds: [{ match: (p) => p.endsWith('.download'), times: 2 }],
    });
    const wrong = (async () => new Response('not the pinned bytes')) as typeof fetch;
    await expect(
      ensureUv({ ignorePath: true, dir, release, fetchImpl: wrong, fs }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('does not retry off Windows: the same error is reported at once', async () => {
    const dir = join(workdir, 'posix');
    const { fs, sleeps } = windowsLikeFs({
      renameHolds: [{ match: (p) => p.endsWith('.staging'), times: 1 }],
    });
    await expect(
      ensureUv({ ignorePath: true, dir, release, fetchImpl, fs: { ...fs, platform: 'linux' } }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(sleeps).toEqual([]);
  });
});

describe('ensureUv reads a Windows PATH the Windows way', () => {
  it('splits on ";", unquotes entries, joins with "\\" and wants uv.exe', async () => {
    const seen: string[] = [];
    const want = 'C:\\Program Files\\uv\\uv.exe';
    const fs: Partial<UvInstallFs> = {
      platform: 'win32',
      isFile: async (p) => {
        seen.push(p);
        return p === want;
      },
    };
    const pathEnv =
      'C:\\WINDOWS\\system32;;C:\\Users\\Jane Doe\\bin\\;"C:\\Program Files\\uv";C:\\later';
    const install = await ensureUv({
      pathEnv,
      host: { platform: 'win32', arch: 'x64', osArch: 'x64' },
      fs,
      // Should the PATH lookup miss, fail here rather than install anything.
      dir: join(workdir, 'must-not-install'),
      fetchImpl: (async () => {
        throw new Error('the PATH lookup missed and an install was attempted');
      }) as typeof fetch,
    });
    expect(install).toEqual({ uvPath: want, source: 'path' });
    expect(seen).toEqual([
      'C:\\WINDOWS\\system32\\uv.exe',
      'C:\\Users\\Jane Doe\\bin\\uv.exe',
      want,
    ]);
  });
});
