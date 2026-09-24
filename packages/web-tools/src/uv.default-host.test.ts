/**
 * The app calls `ensureUv()` with no host: the build must follow the process it
 * runs in. Each case loads the modules fresh (the host probe is cached per
 * module instance) with `process.platform` / `process.arch` pretending to be
 * another machine, and records which asset the download asks for.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realPlatform = process.platform;
const realArch = process.arch;
const BASE = 'https://github.com/astral-sh/uv/releases/download/0.11.28';

function pretend(platform: string, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
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
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-host-'));
});
afterEach(async () => {
  pretend(realPlatform, realArch);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('ensureUv() picks the build for the machine it runs on', () => {
  it('Windows x64 → the x64 zip, and nothing else is fetched', async () => {
    pretend('win32', 'x64');
    expect(await requestedAssets(dir)).toEqual([`${BASE}/uv-x86_64-pc-windows-msvc.zip`]);
  });

  it('Windows on ARM → the arm64 zip', async () => {
    pretend('win32', 'arm64');
    expect(await requestedAssets(dir)).toEqual([`${BASE}/uv-aarch64-pc-windows-msvc.zip`]);
  });

  it('this machine → the build uv-platform chooses for it', async () => {
    vi.resetModules();
    const { detectUvHost, uvReleaseFor, uvAssetUrl } = await import('./uv-platform.js');
    const want = uvAssetUrl(uvReleaseFor(detectUvHost()));
    expect(await requestedAssets(dir)).toEqual([want]);
  });
});
