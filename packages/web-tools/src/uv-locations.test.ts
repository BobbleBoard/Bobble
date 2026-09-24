import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UV_MARKER } from './uv.js';
import { findInstalledUv, knownUvLocations } from './uv-locations.js';
import { PINNED_UV } from './uv-pins.js';

describe('knownUvLocations', () => {
  it('keeps the macOS list exactly as it was before per-platform pins', () => {
    expect(
      knownUvLocations({
        platform: 'darwin',
        home: '/Users/jane',
        env: { XDG_BIN_HOME: '/ignored', CARGO_HOME: '/ignored' },
      }),
    ).toEqual(['/Users/jane/.local/bin/uv', '/opt/homebrew/bin/uv', '/usr/local/bin/uv']);
  });

  it('follows the installer order on Linux, then Cargo, Linuxbrew and the system dirs', () => {
    expect(knownUvLocations({ platform: 'linux', home: '/home/jane', env: {} })).toEqual([
      '/home/jane/.local/bin/uv',
      '/home/jane/.cargo/bin/uv',
      '/home/linuxbrew/.linuxbrew/bin/uv',
      '/home/jane/.linuxbrew/bin/uv',
      '/usr/local/bin/uv',
      '/usr/bin/uv',
    ]);
    expect(
      knownUvLocations({
        platform: 'linux',
        home: '/home/jane',
        env: {
          UV_INSTALL_DIR: '/opt/uv',
          XDG_BIN_HOME: '/home/jane/bin',
          XDG_DATA_HOME: '/home/jane/.local/share',
          CARGO_HOME: '/home/jane/.rust/cargo',
        },
      }).slice(0, 5),
    ).toEqual([
      '/opt/uv/uv',
      '/home/jane/bin/uv',
      // XDG_DATA_HOME/../bin is ~/.local/bin again: listed once.
      '/home/jane/.local/bin/uv',
      '/home/jane/.rust/cargo/bin/uv',
      '/home/linuxbrew/.linuxbrew/bin/uv',
    ]);
  });

  it('looks for uv.exe on Windows: installer dirs, Cargo, winget, Scoop, Chocolatey', () => {
    expect(
      knownUvLocations({
        platform: 'win32',
        home: 'C:\\Users\\Jane Doe',
        env: {
          LOCALAPPDATA: 'C:\\Users\\Jane Doe\\AppData\\Local',
          ProgramData: 'C:\\ProgramData',
        },
      }),
    ).toEqual([
      'C:\\Users\\Jane Doe\\.local\\bin\\uv.exe',
      'C:\\Users\\Jane Doe\\.cargo\\bin\\uv.exe',
      'C:\\Users\\Jane Doe\\AppData\\Local\\Microsoft\\WinGet\\Links\\uv.exe',
      'C:\\Users\\Jane Doe\\scoop\\shims\\uv.exe',
      'C:\\ProgramData\\chocolatey\\bin\\uv.exe',
    ]);
    const custom = knownUvLocations({
      platform: 'win32',
      home: 'C:\\Users\\jane',
      env: {
        UV_INSTALL_DIR: 'D:\\tools\\uv',
        SCOOP: 'D:\\scoop',
        ChocolateyInstall: 'D:\\choco',
      },
    });
    expect(custom[0]).toBe('D:\\tools\\uv\\uv.exe');
    expect(custom).toContain('D:\\scoop\\shims\\uv.exe');
    expect(custom).toContain('D:\\choco\\bin\\uv.exe');
    expect(custom).toContain('C:\\Users\\jane\\AppData\\Local\\Microsoft\\WinGet\\Links\\uv.exe');
  });
});

describe('findInstalledUv', () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'pi-web-tools-uvloc-'));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the first well-known location that holds a file', () => {
    const present = new Set(['/usr/local/bin/uv', '/opt/homebrew/bin/uv']);
    expect(
      findInstalledUv({
        host: { platform: 'darwin', arch: 'arm64' },
        home: '/Users/jane',
        env: {},
        isFile: (p) => present.has(p),
      }),
    ).toBe('/opt/homebrew/bin/uv');
  });

  it('falls back to the app’s pinned copy, then to null', async () => {
    const dir = join(work, 'uv', PINNED_UV.version);
    const nothing = {
      home: '/nowhere',
      env: {},
      dir,
      // Hermetic: only files this test made exist (a runner may have a real /usr/bin/uv).
      isFile: (p: string) => p.startsWith(work) && existsSync(p) && statSync(p).isFile(),
    };
    const host = { platform: 'linux', arch: 'x64', libc: 'glibc', glibcVersion: '2.39' } as const;
    expect(findInstalledUv({ ...nothing, host })).toBeNull();

    const bin = join(dir, 'uv-x86_64-unknown-linux-gnu', 'uv');
    await mkdir(join(dir, 'uv-x86_64-unknown-linux-gnu'), { recursive: true });
    await writeFile(bin, '#!/bin/sh\n');
    await writeFile(
      join(dir, UV_MARKER),
      JSON.stringify({
        version: PINNED_UV.version,
        uvPath: bin,
        target: 'x86_64-unknown-linux-gnu',
      }),
    );
    expect(findInstalledUv({ ...nothing, host })).toBe(bin);
    // The same marker does not answer for a musl machine.
    expect(
      findInstalledUv({ ...nothing, host: { platform: 'linux', arch: 'x64', libc: 'musl' } }),
    ).toBeNull();
  });

  it('answers on a Mac exactly as the engines resolver did before per-platform pins', () => {
    const home = '/Users/jane';
    // The cache paths go through the host's `join`, as readUvMarker builds them.
    const dir = join('/cache', 'uv', PINNED_UV.version);
    const pinned = join(dir, 'uv-aarch64-apple-darwin', 'uv');
    const legacyMarker = JSON.stringify({ version: PINNED_UV.version, uvPath: pinned });
    // engines-main.ts `uvPath()` as it was (main @ 6eb58aaf), over the same fake disk.
    const legacy = (files: Set<string>, marker: string | undefined): string | null => {
      for (const p of [`${home}/.local/bin/uv`, '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
        if (files.has(p)) return p;
      }
      try {
        const m = JSON.parse(marker ?? '') as { uvPath?: string };
        if (typeof m.uvPath === 'string' && files.has(m.uvPath)) return m.uvPath;
      } catch {
        // no pinned copy yet
      }
      return null;
    };
    const states: Array<[string[], string | undefined]> = [
      [[`${home}/.local/bin/uv`, '/opt/homebrew/bin/uv', pinned], legacyMarker],
      [['/opt/homebrew/bin/uv', '/usr/local/bin/uv'], undefined],
      [['/usr/local/bin/uv', pinned], legacyMarker],
      [[pinned], legacyMarker],
      [[], legacyMarker],
      [[pinned], undefined],
      [[pinned], '{ corrupt'],
      [[], undefined],
    ];
    for (const [present, marker] of states) {
      const files = new Set(present);
      const now = findInstalledUv({
        host: { platform: 'darwin', arch: 'arm64', appleSilicon: true },
        home,
        env: {},
        dir,
        isFile: (p) => files.has(p),
        readText: (p) => (p === join(dir, UV_MARKER) ? marker : undefined),
      });
      expect(now, JSON.stringify({ present, marker })).toBe(legacy(files, marker));
    }
  });

  it('no longer hands an Intel Mac the arm64 copy the old bootstrap installed', () => {
    const dir = join('/cache', 'uv', PINNED_UV.version);
    const pinned = join(dir, 'uv-aarch64-apple-darwin', 'uv');
    expect(
      findInstalledUv({
        host: { platform: 'darwin', arch: 'x64', appleSilicon: false },
        home: '/Users/jane',
        env: {},
        dir,
        isFile: (p) => p === pinned,
        readText: () => JSON.stringify({ version: PINNED_UV.version, uvPath: pinned }),
      }),
    ).toBeNull();
  });

  it('returns null on a machine uv has no build for and nothing installed', () => {
    expect(
      findInstalledUv({
        host: { platform: 'freebsd', arch: 'x64' },
        home: '/home/jane',
        env: {},
        isFile: () => false,
      }),
    ).toBeNull();
  });

  it('reads the real machine by default without throwing', () => {
    const found = findInstalledUv();
    expect(found === null || typeof found === 'string').toBe(true);
  });
});
