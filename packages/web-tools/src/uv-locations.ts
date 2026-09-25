/**
 * WHERE A uv ALREADY LIVES ON THIS MACHINE, without asking PATH.
 *
 * A GUI app does not see the user's shell PATH (a Mac app launched from Finder
 * gets the bare system one), so "is uv installed?" is answered by looking where
 * uv's own installers and the common package managers put it, then at the app's
 * own pinned copy (ensureUv's marker). Only when all of that is empty does an
 * install fetch the pinned build.
 *
 *   macOS    unchanged from before XP-04: `~/.local/bin` (the installer's
 *            default), then Homebrew on Apple Silicon and Intel.
 *   Linux    `$UV_INSTALL_DIR`, `$XDG_BIN_HOME`, `$XDG_DATA_HOME/../bin`,
 *            `~/.local/bin` (the installer's order), `~/.cargo/bin` (installers
 *            before uv 0.5), Linuxbrew, `/usr/local/bin`, `/usr/bin` (distro
 *            packages).
 *   Windows  the same installer order with `uv.exe` under `%USERPROFILE%`,
 *            `%USERPROFILE%\.cargo\bin`, then winget's links, Scoop's shims and
 *            Chocolatey's bin.
 *
 * Paths are built with the target OS's path flavour, so every list is unit-
 * tested on this Mac.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { uvDir } from './paths.js';
import { readUvMarker } from './uv.js';
import { detectUvHost, type UvHost, uvReleaseFor } from './uv-platform.js';

export interface UvLocationContext {
  /** `process.platform` of the machine being searched. */
  readonly platform: string;
  /** The user's home directory. */
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function set(v: string | undefined): v is string {
  return v !== undefined && v.length > 0;
}

/** Well-known uv locations for `ctx.platform`, most specific first, no duplicates. */
export function knownUvLocations(ctx: UvLocationContext): string[] {
  const { env, home } = ctx;
  if (ctx.platform === 'darwin') {
    const p = path.posix;
    return [p.join(home, '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv'];
  }

  const win = ctx.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const bin = win ? 'uv.exe' : 'uv';
  const out: string[] = [];
  const add = (...parts: string[]): void => {
    out.push(p.join(...parts));
  };

  // uv's installers: UV_INSTALL_DIR, then XDG_BIN_HOME, then XDG_DATA_HOME/../bin,
  // then ~/.local/bin — the same order on every OS.
  if (set(env.UV_INSTALL_DIR)) add(env.UV_INSTALL_DIR, bin);
  if (set(env.XDG_BIN_HOME)) add(env.XDG_BIN_HOME, bin);
  if (set(env.XDG_DATA_HOME)) add(env.XDG_DATA_HOME, '..', 'bin', bin);
  add(home, '.local', 'bin', bin);
  // Installers before uv 0.5 (and `cargo install uv`) used Cargo's bin.
  add(set(env.CARGO_HOME) ? env.CARGO_HOME : p.join(home, '.cargo'), 'bin', bin);

  if (win) {
    const localAppData = set(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : p.join(home, 'AppData', 'Local');
    add(localAppData, 'Microsoft', 'WinGet', 'Links', bin);
    add(set(env.SCOOP) ? env.SCOOP : p.join(home, 'scoop'), 'shims', bin);
    if (set(env.ChocolateyInstall)) add(env.ChocolateyInstall, 'bin', bin);
    add(set(env.ProgramData) ? env.ProgramData : 'C:\\ProgramData', 'chocolatey', 'bin', bin);
  } else {
    add('/home/linuxbrew/.linuxbrew/bin', bin);
    add(home, '.linuxbrew', 'bin', bin);
    add('/usr/local/bin', bin);
    add('/usr/bin', bin);
  }
  return [...new Set(out)];
}

export interface FindInstalledUvOptions {
  readonly host?: UvHost;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The pinned copy's cache dir (tests). Default: `uvDir(<pinned version>)`. */
  readonly dir?: string;
  readonly isFile?: (p: string) => boolean;
  readonly readText?: (p: string) => string | undefined;
}

/**
 * A uv already on this machine — a well-known location, else the app's own
 * pinned copy — or `null` when there is none of either (an install then fetches
 * the pinned build via `ensureUv`). Synchronous: cheap `stat`s only.
 */
export function findInstalledUv(opts: FindInstalledUvOptions = {}): string | null {
  const host = opts.host ?? detectUvHost();
  const isFile = opts.isFile ?? isRegularFile;
  const locations = knownUvLocations({
    platform: host.platform,
    home: opts.home ?? homedir(),
    env: opts.env ?? process.env,
  });
  for (const candidate of locations) {
    if (isFile(candidate)) return candidate;
  }
  let release: ReturnType<typeof uvReleaseFor>;
  try {
    release = uvReleaseFor(host);
  } catch {
    return null; // no pinned build for this machine
  }
  return (
    readUvMarker(opts.dir ?? uvDir(release.version), release, {
      isFile,
      readText: opts.readText,
    }) ?? null
  );
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
