/**
 * The app calls `ensureUv()` with no host: the build must follow the machine it
 * runs on. Each case loads the modules fresh (the host probe is cached per
 * module instance) with `process.platform` / `process.arch` — and the Windows
 * environment the real probe reads — pretending to be another machine, and
 * records which asset the download asks for.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realPlatform = process.platform;
const realArch = process.arch;
const WINDOWS_ENV = ['SystemRoot', 'PROCESSOR_ARCHITEW6432'] as const;
const realEnv = Object.fromEntries(WINDOWS_ENV.map((k) => [k, process.env[k]]));
const BASE = 'https://github.com/astral-sh/uv/releases/download/0.11.28';

function setEnv(values: Readonly<Record<string, string | undefined>>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function pretend(
  platform: string,
  arch: string,
  env: Readonly<Record<string, string | undefined>> = {},
): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  setEnv(env);
}

async function requestedAssets(dir: string): Promise<string[]> {
  vi.resetModules();
  const { ensureUv } = await import('./uv.js');
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response('not served in tests', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
  await expect(ensureUv({ ignorePath: true, dir, fetchImpl })).rejects.toThrow(/HTTP 404/);
  return urls;
}

let dir: string;
/** A SystemRoot with no reg.exe in it: the OS architecture cannot be read. */
let nowhere: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-host-'));
  nowhere = join(dir, 'no-windows-here');
});
afterEach(async () => {
  pretend(realPlatform, realArch, realEnv);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('ensureUv() picks the build for the machine it runs on', () => {
  it('Windows x64, OS architecture unreadable → the x64 zip, and nothing else is fetched', async () => {
    pretend('win32', 'x64', { SystemRoot: nowhere, PROCESSOR_ARCHITEW6432: undefined });
    expect(await requestedAssets(dir)).toEqual([`${BASE}/uv-x86_64-pc-windows-msvc.zip`]);
  });

  it('Windows on ARM → the arm64 zip', async () => {
    pretend('win32', 'arm64', { SystemRoot: nowhere, PROCESSOR_ARCHITEW6432: undefined });
    expect(await requestedAssets(dir)).toEqual([`${BASE}/uv-aarch64-pc-windows-msvc.zip`]);
  });

  it('a 32-bit app on x64 Windows (WOW64) → the x64 zip, as uv’s installer gives it', async () => {
    pretend('win32', 'ia32', { SystemRoot: nowhere, PROCESSOR_ARCHITEW6432: 'AMD64' });
    expect(await requestedAssets(dir)).toEqual([`${BASE}/uv-x86_64-pc-windows-msvc.zip`]);
  });

  // The real probe end to end — reg.exe run, its answer parsed — with a stand-in
  // reg.exe (a shell script, so not on Windows itself, where CI runs the real one).
  it.skipIf(realPlatform === 'win32')(
    'an x64 app emulated on Windows on ARM → the arm64 zip (reg.exe answers ARM64)',
    async () => {
      const root = join(dir, 'Windows');
      const argsFile = join(dir, 'reg-args.txt');
      await mkdir(join(root, 'System32'), { recursive: true });
      const reg = join(root, 'System32', 'reg.exe');
      await writeFile(
        reg,
        [
          '#!/bin/sh',
          `printf '%s\\n' "$@" > '${argsFile}'`,
          "printf '\\r\\nHKEY_LOCAL_MACHINE\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\Session Manager\\\\Environment\\r\\n'",
          "printf '    PROCESSOR_ARCHITECTURE    REG_SZ    ARM64\\r\\n\\r\\n'",
          '',
        ].join('\n'),
      );
      await chmod(reg, 0o755);
      pretend('win32', 'x64', { SystemRoot: root, PROCESSOR_ARCHITEW6432: undefined });
      expect(await requestedAssets(dir)).toEqual([`${BASE}/uv-aarch64-pc-windows-msvc.zip`]);
      expect((await readFile(argsFile, 'utf8')).trim().split('\n')).toEqual([
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
        '/v',
        'PROCESSOR_ARCHITECTURE',
      ]);
    },
  );

  it('this machine → the build uv-platform chooses for it', async () => {
    vi.resetModules();
    const { detectUvHost, uvReleaseFor, uvAssetUrl } = await import('./uv-platform.js');
    const want = uvAssetUrl(uvReleaseFor(detectUvHost()));
    expect(await requestedAssets(dir)).toEqual([want]);
  });
});
