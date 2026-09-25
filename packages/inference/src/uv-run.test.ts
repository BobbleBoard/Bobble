import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UV_PROBE_TIMEOUT_MS,
  type UvProbeChild,
  uvEnvCached,
  uvOfflineProbeArgs,
  uvRunArgs,
} from './uv-run.js';

const ENV = ['--no-project', '--python', '3.12', '--with', 'huggingface_hub==0.34.4'];

describe('uvRunArgs', () => {
  it('is `uv run <env> <command>` online — the argv every launch had before', () => {
    expect(uvRunArgs(ENV, ['server.py', '--port', '1'])).toEqual([
      'run',
      '--no-project',
      '--python',
      '3.12',
      '--with',
      'huggingface_hub==0.34.4',
      'server.py',
      '--port',
      '1',
    ]);
    expect(uvRunArgs(ENV, ['x'], { offline: false })).toEqual(uvRunArgs(ENV, ['x']));
  });

  it('puts --offline straight after `run` and changes nothing else', () => {
    const online = uvRunArgs(ENV, ['server.py']);
    const offline = uvRunArgs(ENV, ['server.py'], { offline: true });
    expect(offline).toEqual(['run', '--offline', ...online.slice(1)]);
  });
});

describe('uvOfflineProbeArgs', () => {
  it("asks the SAME env for a no-op python, offline: `uv run --offline <env> python -c ''`", () => {
    expect(uvOfflineProbeArgs(ENV)).toEqual(['run', '--offline', ...ENV, 'python', '-c', '']);
    // Everything between `run --offline` and the command is the launch's env.
    const launch = uvRunArgs(ENV, ['mlx_lm.server', '--port', '8'], { offline: true });
    const probe = uvOfflineProbeArgs(ENV);
    expect(probe.slice(0, 2 + ENV.length)).toEqual(launch.slice(0, 2 + ENV.length));
  });
});

/** A child that exits (or fails) on the next microtask, and records what it was told. */
function probeChild(outcome: { code?: number | null; error?: Error } = {}): UvProbeChild & {
  killedWith: string | undefined;
  drained: string[];
} {
  const child = {
    killedWith: undefined as string | undefined,
    drained: [] as string[],
    stdout: { on: (_e: 'data', _cb: unknown) => child.drained.push('stdout') },
    stderr: { on: (_e: 'data', _cb: unknown) => child.drained.push('stderr') },
    on(event: 'error' | 'exit', cb: (...a: never[]) => void): void {
      if (event === 'exit' && outcome.code !== undefined) {
        const exit = cb as unknown as (code: number | null, signal: string | null) => void;
        queueMicrotask(() => exit(outcome.code ?? null, null));
      }
      if (event === 'error' && outcome.error !== undefined) {
        const error = cb as unknown as (err: Error) => void;
        const err = outcome.error;
        queueMicrotask(() => error(err));
      }
    },
    kill(signal?: 'SIGKILL'): void {
      child.killedWith = signal;
    },
  };
  return child;
}

describe('uvEnvCached', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the probe argv through the given start, and exit 0 means cached', async () => {
    const started: string[][] = [];
    const cached = await uvEnvCached((args) => {
      started.push(args);
      return probeChild({ code: 0 });
    }, ENV);
    expect(cached).toBe(true);
    expect(started).toEqual([uvOfflineProbeArgs(ENV)]);
  });

  it('any other exit means not cached — launch online, as before', async () => {
    expect(await uvEnvCached(() => probeChild({ code: 2 }), ENV)).toBe(false);
    expect(await uvEnvCached(() => probeChild({ code: null }), ENV)).toBe(false);
  });

  it('a spawn that errors or throws (no uv) is not cached, and never rejects', async () => {
    expect(await uvEnvCached(() => probeChild({ error: new Error('ENOENT') }), ENV)).toBe(false);
    expect(
      await uvEnvCached(() => {
        throw new Error('spawn EACCES');
      }, ENV),
    ).toBe(false);
  });

  it('drains the probe’s output so a full pipe cannot stall it', async () => {
    const child = probeChild({ code: 0 });
    await uvEnvCached(() => child, ENV);
    expect(child.drained.sort()).toEqual(['stderr', 'stdout']);
  });

  it('abandons a probe that never answers: SIGKILL, not cached', async () => {
    vi.useFakeTimers();
    const hung = probeChild(); // never exits
    const answer = uvEnvCached(() => hung, ENV, { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hung.killedWith).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
    expect(hung.killedWith).toBe('SIGKILL');
    expect(UV_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('takes a real ChildProcess (node spawn) as it comes', async () => {
    const node = (code: number) => () =>
      spawn(process.execPath, ['-e', `process.exit(${code})`], { stdio: 'ignore' });
    expect(await uvEnvCached(node(0), ENV)).toBe(true);
    expect(await uvEnvCached(node(3), ENV)).toBe(false);
    expect(
      await uvEnvCached(() => spawn('/nonexistent/uv-for-a-probe', [], { stdio: 'ignore' }), ENV),
    ).toBe(false);
  });
});
