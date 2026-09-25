/**
 * Every child process the uv bootstrap starts hides its console window: from a
 * GUI app on Windows a console child otherwise FLASHES a window, which is a
 * focus steal (crossplatform.md §2.4 A10). The children are reg.exe (the Windows
 * OS architecture), sysctl (Rosetta) and tar (the macOS and Linux builds).
 *
 * Two checks: the calls made at runtime are recorded with their options, and a
 * scan of the sources finds every child-process call site, so a spawn added
 * later on a path these runs do not reach is caught too.
 */
import { execFileSync as realExecFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(
  () => [] as Array<{ fn: string; file: string; args: readonly string[]; options: unknown }>,
);

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, args: readonly string[], options: object) => {
    calls.push({ fn: 'execFileSync', file, args, options });
    return real.execFileSync(file, args, options);
  }) as typeof real.execFileSync;
  const spawn = ((cmd: string, args: readonly string[], options: object) => {
    calls.push({ fn: 'spawn', file: cmd, args, options });
    return real.spawn(cmd, args, options);
  }) as typeof real.spawn;
  return { ...real, execFileSync, spawn, default: { ...real, execFileSync, spawn } };
});

const { detectUvHost, readWindowsRegistryArch, uvReleaseForTarget, WINDOWS_ENVIRONMENT_KEY } =
  await import('./uv-platform.js');
const { ensureUv } = await import('./uv.js');

let workdir: string;
beforeEach(async () => {
  calls.length = 0;
  workdir = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-spawn-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
});

describe('children the uv bootstrap starts hide their window', () => {
  it('reg.exe: from System32, the one value it needs, hidden, with a timeout', () => {
    const answer = readWindowsRegistryArch({ SystemRoot: 'C:\\Windows' });
    // On a Windows runner this is the real answer; anywhere else there is no reg.exe.
    if (process.platform === 'win32') expect(answer).toMatch(/^(AMD64|ARM64|x86)$/i);
    else expect(answer).toBeUndefined();
    expect(calls).toEqual([
      {
        fn: 'execFileSync',
        file: join('C:\\Windows', 'System32', 'reg.exe'),
        args: ['query', WINDOWS_ENVIRONMENT_KEY, '/v', 'PROCESSOR_ARCHITECTURE'],
        options: expect.objectContaining({ windowsHide: true, timeout: 3_000 }),
      },
    ]);
  });

  it('detectUvHost asks reg.exe only for an x64 Windows process, hidden', () => {
    detectUvHost({ platform: 'win32', arch: 'arm64', env: {} });
    detectUvHost({ platform: 'win32', arch: 'ia32', env: { PROCESSOR_ARCHITEW6432: 'AMD64' } });
    expect(calls).toEqual([]);
    detectUvHost({ platform: 'win32', arch: 'x64', env: { SystemRoot: 'D:\\WINNT' } });
    expect(calls).toEqual([
      expect.objectContaining({
        file: join('D:\\WINNT', 'System32', 'reg.exe'),
        options: expect.objectContaining({ windowsHide: true }),
      }),
    ]);
  });

  it('sysctl (the Rosetta check) is hidden too', () => {
    detectUvHost({ platform: 'darwin', arch: 'x64' });
    expect(calls).toEqual([
      expect.objectContaining({
        fn: 'execFileSync',
        args: ['-n', 'hw.optional.arm64'],
        options: expect.objectContaining({ windowsHide: true }),
      }),
    ]);
  });

  it.skipIf(process.platform === 'win32')('tar, unpacking a tar.gz build, is hidden', async () => {
    const src = join(workdir, 'src');
    await mkdir(join(src, 'uv-x86_64-unknown-linux-gnu'), { recursive: true });
    await writeFile(join(src, 'uv-x86_64-unknown-linux-gnu', 'uv'), '#!/bin/sh\n', { mode: 0o755 });
    const tgz = join(workdir, 'uv.tar.gz');
    realExecFileSync('tar', ['-czf', tgz, '-C', src, 'uv-x86_64-unknown-linux-gnu']);
    calls.length = 0; // that tar was the test's own
    const bytes = await readFile(tgz);
    const release = {
      ...uvReleaseForTarget('x86_64-unknown-linux-gnu'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await ensureUv({
      ignorePath: true,
      dir: join(workdir, 'cache'),
      release,
      fetchImpl: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        fn: 'spawn',
        file: 'tar',
        options: expect.objectContaining({ windowsHide: true }),
      }),
    ]);
  });
});

describe('every child-process call site in the bootstrap passes windowsHide: true', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const FILES = [
    'uv.ts',
    'uv-platform.ts',
    'uv-locations.ts',
    'uv-pins.ts',
    'unzip.ts',
    'download.ts',
    'win-fs.ts',
    'paths.ts',
  ];

  /** The argument text of the call whose `(` is at `open`, balanced. */
  function callArgs(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
    }
    throw new Error('unbalanced call');
  }

  it.each(FILES)('%s', (file) => {
    const src = readFileSync(join(here, file), 'utf8');
    const names: string[] = [];
    const importRe = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g;
    for (let m = importRe.exec(src); m !== null; m = importRe.exec(src)) {
      for (const part of (m[1] as string).split(',')) {
        const local = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (local !== undefined && local !== '' && !local.startsWith('type ')) names.push(local);
      }
    }
    // Named imports only, so every name bound to a child-process function is known.
    expect(src).not.toMatch(/import\s+(\*\s*as\s+)?\w+\s+from\s+'node:child_process'/);
    expect(src).not.toMatch(/(import|require)\(\s*'node:child_process'/);
    let sites = 0;
    for (const name of names) {
      const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
      for (let m = callRe.exec(src); m !== null; m = callRe.exec(src)) {
        const args = callArgs(src, m.index + m[0].length - 1);
        sites++;
        expect(args, `${file}: ${name}(…) without windowsHide`).toMatch(/windowsHide:\s*true/);
      }
    }
    // The files that start children do start them; the rest start none.
    const expected: Record<string, number> = { 'uv.ts': 1, 'uv-platform.ts': 2 };
    expect(sites).toBe(expected[file] ?? 0);
  });
});
