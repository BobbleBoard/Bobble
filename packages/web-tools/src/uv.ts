/**
 * uv runtime bootstrap — self-contained in this package (W6 owns its Python
 * runtime independently of @pi-desktop/inference).
 *
 * Detects an existing `uv` on PATH first; otherwise downloads the pinned
 * standalone uv build FOR THIS MACHINE (uv-platform.ts picks it: macOS arm64 /
 * x64, Windows x64 / arm64 / ia32 zips carrying `uv.exe`, Linux glibc or static
 * musl builds) into `~/.cache/bobble/uv/<version>/uv-<target>/`. Every download
 * is checked against the sha256 pinned in uv-pins.ts (generated from the
 * release's own `sha256.sum`), never against a checksum fetched beside it.
 *
 * The install is atomic: the archive is unpacked into a staging folder and
 * renamed into place, so a crash leaves no half-written `uv-<target>/`, and an
 * `.installed.json` marker (version, target, digest, path) lets later runs skip
 * all work. Concurrent callers in one process share a single install. Provisioning
 * an isolated Python is uv's job (see python.ts) — we never touch system Python.
 *
 * Windows' file rules are followed (win-fs.ts): a virus scanner holding the fresh
 * uv.exe is waited out, the download and staging folders are removed through the
 * same holds, and an older copy in the way is moved aside WHOLE before the new
 * one goes in — never deleted in place, which on Windows would leave a running
 * uv.exe stripped of its uvx.exe and uvw.exe.
 *
 * spawn/extract/fetch and the file operations are injectable, so unit tests
 * never need a real download and the Windows rules run on any machine.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';
import { type DownloadProgress, downloadFile } from './download.js';
import { uvDir } from './paths.js';
import { extractZip } from './unzip.js';
import {
  detectUvHost,
  type UvHost,
  type UvRelease,
  uvAssetUrl,
  uvReleaseFor,
} from './uv-platform.js';
import {
  defaultRetryFs,
  REMOVE_OPTIONS,
  type RemoveOptions,
  type RetryFs,
  renameRetrying,
} from './win-fs.js';

/**
 * The file operations an install makes, and the OS whose rules they follow: the
 * PATH format, and on Windows a scanner's hold and a running uv.exe. Injectable
 * so those rules are exercised on any machine. Default: node:fs on this OS.
 */
export interface UvInstallFs extends RetryFs {
  readonly rm: (path: string, opts: RemoveOptions) => Promise<void>;
  /** Whether `p` is a regular file (false when it is missing or unreadable). */
  readonly isFile: (p: string) => Promise<boolean>;
}

const defaultInstallFs: UvInstallFs = {
  ...defaultRetryFs,
  rm: (p, opts) => rm(p, opts),
  isFile: async (p) => {
    try {
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  },
};

export interface EnsureUvOptions {
  /** The build to install. Default: the pinned build for {@link host}. */
  readonly release?: UvRelease;
  /** The machine to pick a build for. Default: this one ({@link detectUvHost}). */
  readonly host?: UvHost;
  /** Cache dir override (defaults to `~/.cache/bobble/uv/<version>`). */
  readonly dir?: string;
  readonly onProgress?: (p: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /**
   * Injectable extractor (tests): unpack `archivePath` into `destDir`. Default:
   * `.zip` builds → {@link extractZip} (no child process), `.tar.gz` → `tar -xzf`.
   */
  readonly extract?: (archivePath: string, destDir: string) => Promise<void>;
  /** Skip the PATH probe (tests forcing the download path). */
  readonly ignorePath?: boolean;
  /** PATH string to scan when probing (tests). Default: process.env.PATH. */
  readonly pathEnv?: string;
  /** File operations and the OS whose rules they follow (tests). Default: node:fs here. */
  readonly fs?: Partial<UvInstallFs>;
}

export interface UvInstall {
  /** Absolute path (download) or the PATH hit to invoke. */
  readonly uvPath: string;
  readonly source: 'path' | 'download';
  readonly version?: string;
  /** The build installed, e.g. `x86_64-pc-windows-msvc` (download only). */
  readonly target?: string;
}

/** What `.installed.json` records. Copies installed before XP-04 carry no `target`. */
export interface UvInstallMarker {
  readonly version: string;
  readonly uvPath: string;
  readonly target?: string;
  readonly assetName?: string;
  readonly sha256?: string;
}

/** The marker file inside a version's cache dir. */
export const UV_MARKER = '.installed.json';

/**
 * A marker without `target` was written when the app could only install the
 * macOS arm64 build, so that is the build it describes.
 */
const LEGACY_MARKER_TARGET = 'aarch64-apple-darwin';

/** The folder a target's binary lives in under a version's cache dir. */
export function uvInstallDir(dir: string, target: string): string {
  return join(dir, `uv-${target}`);
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The installed binary the marker in `dir` vouches for `release`, or undefined.
 * The marker must name the same version and target. Its recorded path is used
 * when it still exists; when the cache root moved (the pi-desktop → bobble
 * rename), the binary at the expected place inside `dir` is accepted instead.
 * Synchronous on purpose: engines-main resolves uv without awaiting.
 */
export function readUvMarker(
  dir: string,
  release: Pick<UvRelease, 'version' | 'target' | 'binName'>,
  io: {
    readonly isFile?: (p: string) => boolean;
    readonly readText?: (p: string) => string | undefined;
  } = {},
): string | undefined {
  const isFile = io.isFile ?? defaultIsFile;
  const raw = (io.readText ?? defaultReadText)(join(dir, UV_MARKER));
  if (raw === undefined) return undefined;
  let marker: Partial<UvInstallMarker>;
  try {
    marker = JSON.parse(raw) as Partial<UvInstallMarker>;
  } catch {
    return undefined; // corrupt marker: reinstall
  }
  if (marker.version !== release.version) return undefined;
  if ((marker.target ?? LEGACY_MARKER_TARGET) !== release.target) return undefined;
  if (typeof marker.uvPath === 'string' && isFile(marker.uvPath)) return marker.uvPath;
  const expected = join(uvInstallDir(dir, release.target), release.binName);
  return isFile(expected) ? expected : undefined;
}

/**
 * Resolve an executable by scanning PATH (so we get an absolute path), read the
 * way `fs.platform` writes it: on Windows `;`-separated, entries possibly quoted
 * (`"C:\Program Files\uv"`), `\` paths.
 */
async function resolveOnPath(
  name: string,
  pathEnv: string | undefined,
  fs: UvInstallFs,
): Promise<string | undefined> {
  const flavour = fs.platform === 'win32' ? win32 : posix;
  for (const entry of (pathEnv ?? '').split(flavour.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (dir.length === 0) continue;
    const candidate = flavour.join(dir, name);
    if (await fs.isFile(candidate)) return candidate;
  }
  return undefined;
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn('tar', ['-xzf', archivePath, '-C', destDir], { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr}`)),
    );
  });
}

function defaultExtract(release: UvRelease, fs: UvInstallFs) {
  return async (archivePath: string, destDir: string): Promise<void> => {
    if (release.archive === 'zip') {
      // Each file is written under a temporary name and renamed: on Windows the
      // scanner may be holding the uv.exe it just saw appear.
      await extractZip(archivePath, destDir, {
        platform: fs.platform,
        rename: (from, to) => renameRetrying(from, to, fs),
      });
    } else {
      await extractTarGz(archivePath, destDir);
    }
  };
}

/** Recursively locate an executable by name within a directory tree. */
async function findExecutable(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return undefined;
  const want = name.toLowerCase();
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === want) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findExecutable(join(root, entry.name), name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Put a freshly unpacked folder at `installDir`.
 *
 * An older folder already there (an interrupted install from before staging
 * existed, or a lost marker) is first renamed to `aside` — all at once — and only
 * then deleted. Deleting it where it stands is not safe on Windows: a recursive
 * delete removes what it can, and a running uv.exe cannot be removed, so the
 * folder would be left with a uv.exe and no uvx.exe or uvw.exe. When it cannot be
 * moved aside (on Windows, because its uv.exe is running), or another process
 * moved its own copy in first, the copy that is there is kept, untouched, if it
 * has the binary: something put it there whole, or is running it.
 */
async function moveIntoPlace(
  from: string,
  installDir: string,
  aside: string,
  binName: string,
  fs: UvInstallFs,
): Promise<void> {
  const keepExisting = async (err: unknown): Promise<void> => {
    if (!(await fs.isFile(join(installDir, binName)))) throw err;
  };
  if (await fs.isDirectory(installDir)) {
    try {
      await renameRetrying(installDir, aside, fs);
      await fs.rm(aside, REMOVE_OPTIONS).catch(() => {}); // out of the way already
    } catch (err) {
      // Gone meanwhile (another install moved it): the way is clear.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        await keepExisting(err);
        return;
      }
    }
  }
  try {
    await renameRetrying(from, installDir, fs);
  } catch (err) {
    await keepExisting(err);
  }
}

async function install(
  release: UvRelease,
  dir: string,
  opts: EnsureUvOptions,
  fs: UvInstallFs,
): Promise<UvInstall> {
  await mkdir(dir, { recursive: true });
  const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const archivePath = join(dir, `.${release.assetName}.${stamp}.download`);
  const staging = join(dir, `.uv-${release.target}.${stamp}.staging`);
  const aside = join(dir, `.uv-${release.target}.${stamp}.old`);
  const markerTmp = join(dir, `${UV_MARKER}.${stamp}`);
  try {
    await downloadFile({
      url: uvAssetUrl(release),
      dest: archivePath,
      expectedSha256: release.sha256,
      onProgress: opts.onProgress,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl ?? fetch,
      headers: { 'user-agent': 'pi-desktop-web-tools' },
    });

    await mkdir(staging, { recursive: true });
    await (opts.extract ?? defaultExtract(release, fs))(archivePath, staging);
    const found = await findExecutable(staging, release.binName);
    if (found === undefined) {
      throw new Error(`${release.binName} not found in ${release.assetName} after extracting it`);
    }
    if (fs.platform !== 'win32') await chmod(found, 0o755).catch(() => {});

    const installDir = uvInstallDir(dir, release.target);
    await moveIntoPlace(dirname(found), installDir, aside, release.binName, fs);
    const uvPath = join(installDir, release.binName);

    const marker: UvInstallMarker = {
      version: release.version,
      uvPath,
      target: release.target,
      assetName: release.assetName,
      sha256: release.sha256,
    };
    await writeFile(markerTmp, JSON.stringify(marker, null, 2));
    await renameRetrying(markerTmp, join(dir, UV_MARKER), fs);

    return { uvPath, source: 'download', version: release.version, target: release.target };
  } finally {
    // Every temporary this install made, through a scanner's hold; none may stay.
    for (const leftover of [archivePath, `${archivePath}.part`, staging, aside, markerTmp]) {
      await fs.rm(leftover, REMOVE_OPTIONS).catch(() => {});
    }
  }
}

/** In-flight installs, so concurrent first-run callers share one download. */
const inflight = new Map<string, Promise<UvInstall>>();

/**
 * Ensure uv is available; return how to invoke it. Prefers an existing PATH
 * install, else downloads + verifies the pinned build for this machine into the
 * cache. Skips all work when the cache marker + binary are already present.
 * Throws {@link UnsupportedUvHostError} on a machine uv publishes no build for
 * (and that has no uv on PATH).
 */
export async function ensureUv(opts: EnsureUvOptions = {}): Promise<UvInstall> {
  const fs: UvInstallFs = { ...defaultInstallFs, ...opts.fs };
  const host = opts.host ?? (opts.release === undefined ? detectUvHost() : undefined);
  const binName = opts.release?.binName ?? (host?.platform === 'win32' ? 'uv.exe' : 'uv');

  if (opts.ignorePath !== true) {
    const onPath = await resolveOnPath(binName, opts.pathEnv ?? process.env.PATH, fs);
    if (onPath !== undefined) return { uvPath: onPath, source: 'path' };
  }

  const release = opts.release ?? uvReleaseFor(host);
  const dir = opts.dir ?? uvDir(release.version);

  // Fast path: honour the install marker if the binary still exists.
  const installed = readUvMarker(dir, release);
  if (installed !== undefined) {
    return {
      uvPath: installed,
      source: 'download',
      version: release.version,
      target: release.target,
    };
  }

  const key = `${dir}\0${release.target}`;
  const running = inflight.get(key);
  if (running !== undefined) return running;
  const job = install(release, dir, opts, fs).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
