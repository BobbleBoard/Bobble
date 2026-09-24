import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CliMissingError,
  type CliRunner,
  createCliBackend,
  locateCli,
  runCli,
} from './cli-backend';
import { STATUS_FIXTURE, WHOIS_FIXTURE } from './testing/fake-localapi';

interface Call {
  bin: string;
  args: readonly string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

function scripted(
  answer: (args: readonly string[]) => Partial<{
    stdout: string;
    stderr: string;
    code: number | null;
    missing: boolean;
    timedOut: boolean;
  }>,
): { run: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CliRunner = async (bin, args, opts) => {
    calls.push({ bin, args, timeoutMs: opts.timeoutMs, env: opts.env });
    return { stdout: '', stderr: '', code: 0, missing: false, timedOut: false, ...answer(args) };
  };
  return { run, calls };
}

const FINDER_ENV = { HOME: '/Users/someone', PATH: '/usr/bin:/bin' };

describe('the CLI backend', () => {
  it('reads status with `status --json`, in CLI mode, from a Finder-like environment', async () => {
    const { run, calls } = scripted(() => ({ stdout: STATUS_FIXTURE }));
    const cli = createCliBackend({
      bin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      run,
      env: FINDER_ENV,
    });
    const status = await cli.status();
    expect(status.state).toBe('Running');
    expect(status.peers).toHaveLength(4);
    expect(calls[0]?.args).toEqual(['status', '--json']);
    expect(calls[0]?.env).toEqual({ ...FINDER_ENV, TAILSCALE_BE_CLI: '1' });
    expect(calls[0]?.timeoutMs).toBe(5000);
    expect(cli.kind).toBe('cli');
    expect(cli.watch).toBeUndefined(); // no push channel: the adapter polls
  });

  it('turns a daemon that does not answer into NotRunning, with its words', async () => {
    const { run } = scripted(() => ({
      code: 1,
      stderr:
        '2026/09/23 18:00:00 failed to connect to local Tailscale daemon; it doesn’t appear to be running\n',
    }));
    const status = await createCliBackend({ bin: 'tailscale', run }).status();
    expect(status).toMatchObject({ available: false, state: 'NotRunning' });
    expect(status.reason).toContain('failed to connect to local Tailscale daemon');
    expect(status.reason).not.toContain('2026/09/23');
  });

  it('says so when the CLI hangs past its deadline', async () => {
    const { run } = scripted(() => ({ code: null, timedOut: true }));
    expect((await createCliBackend({ bin: 'tailscale', run }).status()).reason).toBe(
      'Tailscale did not answer in time.',
    );
  });

  it('throws when the binary is gone, so the adapter looks again', async () => {
    const { run } = scripted(() => ({ code: null, missing: true }));
    await expect(createCliBackend({ bin: '/gone/tailscale', run }).status()).rejects.toBeInstanceOf(
      CliMissingError,
    );
  });

  it('reads whois, and "peer not found" as an ordinary answer — MEASURED', async () => {
    const { run, calls } = scripted((args) =>
      args[2] === '100.101.102.110'
        ? { stdout: WHOIS_FIXTURE }
        : { code: 1, stderr: '2026/09/23 18:17:09 peer not found\n' },
    );
    const cli = createCliBackend({ bin: 'tailscale', run });
    expect(await cli.whois('100.101.102.110')).toMatchObject({
      found: true,
      stableId: 'nbYS7qLqVy11CNTRL',
    });
    expect(await cli.whois('100.99.99.99')).toEqual({
      found: false,
      reason: 'not-found',
      detail: 'peer not found',
    });
    expect(calls[0]?.args).toEqual(['whois', '--json', '100.101.102.110']);
  });

  it('pings once with a whole-second timeout and reads the answer', async () => {
    const { run, calls } = scripted(() => ({
      stdout: 'pong from linux-ms-7e59 (100.101.102.110) via 192.168.1.33:41641 in 9ms\n',
    }));
    const r = await createCliBackend({ bin: 'tailscale', run }).ping('100.101.102.110', {
      timeoutMs: 2500,
    });
    expect(r).toMatchObject({ ok: true, path: 'direct', latencyMs: 9 });
    expect(calls[0]?.args).toEqual(['ping', '--c', '1', '--timeout', '3s', '100.101.102.110']);
    // The process gets the ping's own deadline plus the second ping.go sleeps after a pong.
    expect(calls[0]?.timeoutMs).toBe(7500);
  });

  it('reads a ping the process deadline cut short as a timeout', async () => {
    const { run } = scripted(() => ({ code: null, timedOut: true }));
    expect(await createCliBackend({ bin: 'tailscale', run }).ping('100.64.0.2')).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });
});

describe('locateCli', () => {
  it('takes the first known location that exists, without running anything', async () => {
    const asked: string[] = [];
    const found = await locateCli({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      access: async (p) => {
        asked.push(p);
        if (p !== '/usr/local/bin/tailscale') throw new Error('ENOENT');
      },
    });
    expect(found).toBe('/usr/local/bin/tailscale');
    expect(asked[0]).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('searches PATH for a bare name', async () => {
    const found = await locateCli({
      platform: 'linux',
      candidates: ['tailscale'],
      env: { PATH: '/opt/a:/opt/b' },
      access: async (p) => {
        if (p !== '/opt/b/tailscale') throw new Error('ENOENT');
      },
    });
    expect(found).toBe('/opt/b/tailscale');
  });

  it('reads the Windows Path with Windows separators', async () => {
    const found = await locateCli({
      platform: 'win32',
      env: { Path: 'C:\\Windows;C:\\Tools' },
      access: async (p) => {
        if (p !== 'C:\\Tools\\tailscale.exe') throw new Error('ENOENT');
      },
    });
    expect(found).toBe('C:\\Tools\\tailscale.exe');
  });

  it('answers null when Tailscale is not installed', async () => {
    expect(
      await locateCli({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        access: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('runCli against a real process', () => {
  let dir: string;
  let fakeCli: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tscli-'));
    fakeCli = path.join(dir, 'tailscale');
    // Prints the CLI-mode switch it received, then exits the way `ping` does on no reply.
    writeFileSync(
      fakeCli,
      '#!/bin/sh\nif [ "$1" = ping ]; then echo "ping \\"$5\\" timed out"; echo "no reply" >&2; exit 1; fi\n' +
        'printf \'{"BackendState":"Running","Version":"%s"}\' "$TAILSCALE_BE_CLI"\n',
    );
    chmodSync(fakeCli, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('delivers TAILSCALE_BE_CLI=1 to the child even from an empty environment', async () => {
    const status = await createCliBackend({
      bin: fakeCli,
      env: { PATH: '/usr/bin:/bin' },
    }).status();
    expect(status.version).toBe('1');
  });

  it('returns a non-zero exit as an answer, not an exception', async () => {
    const r = await runCli(fakeCli, ['ping', '--c', '1', '100.64.0.9'], {
      timeoutMs: 5000,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r).toMatchObject({ code: 1, missing: false, timedOut: false });
    expect(await createCliBackend({ bin: fakeCli }).ping('100.64.0.9')).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });

  it('reports a missing binary as missing', async () => {
    const r = await runCli(path.join(dir, 'nope'), ['status'], { timeoutMs: 5000, env: {} });
    expect(r.missing).toBe(true);
  });
});
