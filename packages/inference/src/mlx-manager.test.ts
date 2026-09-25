import { describe, expect, it } from 'vitest';
import {
  assembleMlxServerArgs,
  createMlxSupervisor,
  ensureMlx,
  isMlxSupported,
  MLX_LM_PIN,
  mlxServerUvEnv,
  TRANSFORMERS_PIN,
} from './mlx-manager.js';
import type { LlamaChildProcess } from './supervisor.js';

describe('assembleMlxServerArgs', () => {
  it('builds the `uv run … mlx_lm.server` argv with model/host/port', () => {
    const args = assembleMlxServerArgs({
      repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
      host: '127.0.0.1',
      port: 9999,
    });
    expect(args).toContain('run');
    expect(args).toContain('mlx_lm.server');
    // uv resolves + caches the pinned mlx-lm on first run. Both pins are needed:
    // a naked mlx-lm pulls a too-new transformers that import-breaks the server.
    expect(args).toContain(`mlx-lm==${MLX_LM_PIN}`);
    expect(args.some((a) => a.startsWith('transformers=='))).toBe(true);
    // --model <repo> --host <h> --port <p> in order.
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'mlx-community/Qwen3.5-4B-MLX-4bit',
    ]);
    expect(args.slice(args.indexOf('--port'), args.indexOf('--port') + 2)).toEqual([
      '--port',
      '9999',
    ]);
    // No draft-model unless requested (no MTP/EAGLE on MLX).
    expect(args).not.toContain('--draft-model');
  });

  it('adds classic draft-model speculative decoding when a draft repo is given', () => {
    const args = assembleMlxServerArgs({
      repo: 'mlx-community/Qwen3.6-27B-OptiQ-4bit',
      host: '127.0.0.1',
      port: 8000,
      draftRepo: 'mlx-community/Qwen3.5-2B-MLX-4bit',
      numDraftTokens: 4,
    });
    expect(args.slice(args.indexOf('--draft-model'), args.indexOf('--draft-model') + 2)).toEqual([
      '--draft-model',
      'mlx-community/Qwen3.5-2B-MLX-4bit',
    ]);
    expect(args).toContain('--num-draft-tokens');
    expect(args[args.indexOf('--num-draft-tokens') + 1]).toBe('4');
  });
});

describe('isMlxSupported', () => {
  it('is true only on darwin + arm64', () => {
    expect(isMlxSupported('darwin', 'arm64')).toBe(true);
    expect(isMlxSupported('darwin', 'x64')).toBe(false);
    expect(isMlxSupported('linux', 'arm64')).toBe(false);
    expect(isMlxSupported('win32', 'arm64')).toBe(false);
  });
});

describe('ensureMlx', () => {
  it('resolves uv from PATH', async () => {
    // Point the probe at a fake PATH dir that (by name) contains no uv → error…
    await expect(ensureMlx({ pathEnv: '/nonexistent-path-xyz' })).rejects.toThrow(/uv is required/);
  });
});

describe('the offline launch', () => {
  it('is the same argv with --offline straight after `run`', () => {
    const cfg = { repo: 'mlx-community/Qwen3.5-4B-MLX-4bit', host: '127.0.0.1', port: 9999 };
    const online = assembleMlxServerArgs(cfg);
    expect(online).not.toContain('--offline');
    expect(assembleMlxServerArgs({ ...cfg, offline: true })).toEqual([
      'run',
      '--offline',
      ...online.slice(1),
    ]);
  });

  it('launches in exactly the env the probe asks about (both pins, same Python)', () => {
    const env = mlxServerUvEnv();
    expect(env).toEqual([
      '--no-project',
      '--python',
      '3.12',
      '--with',
      `mlx-lm==${MLX_LM_PIN}`,
      '--with',
      `transformers==${TRANSFORMERS_PIN}`,
    ]);
    const args = assembleMlxServerArgs({ repo: 'r', host: 'h', port: 1 });
    expect(args.slice(1, args.indexOf('mlx_lm.server'))).toEqual(env);
    expect(mlxServerUvEnv({ mlxLmPin: '9.9.9' })).toContain('mlx-lm==9.9.9');
  });
});

/**
 * A child that can actually EXIT. This used to be `on: () => {}` /
 * `kill: () => {}` — a stub that could never fire 'exit', so dispose() only
 * ever returned because it gave up waiting. That was invisible until dispose
 * started waiting for the real exit (the model-switch fix), at which point the
 * createMlxSupervisor test timed out against a supervisor that was behaving
 * correctly. A fake process that cannot die is not a useful fake. `exitCode`
 * set = exits by itself at once (the offline probe); unset = runs until killed.
 */
function fakeChild(exitCode?: number): LlamaChildProcess {
  const listeners = new Map<string, (...a: unknown[]) => void>();
  return {
    pid: 4242,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      listeners.set(event, cb);
      if (event === 'exit' && exitCode !== undefined) queueMicrotask(() => cb(exitCode, null));
    },
    kill: () => {
      queueMicrotask(() => listeners.get('exit')?.(0, 'SIGTERM'));
    },
  } as unknown as LlamaChildProcess;
}

/** A spawn whose probe (`uv run --offline … python -c ''`) exits `probeExit`. */
function fakeUv(probeExit: number): {
  spawnFn: (cmd: string, args: string[]) => LlamaChildProcess;
  probes: string[][];
  launches: { cmd: string; args: string[] }[];
} {
  const probes: string[][] = [];
  const launches: { cmd: string; args: string[] }[] = [];
  const spawnFn = (cmd: string, args: string[]): LlamaChildProcess => {
    if (args.at(-1) === '' && args.at(-2) === '-c') {
      probes.push(args);
      return fakeChild(probeExit);
    }
    launches.push({ cmd, args });
    return fakeChild();
  };
  return { spawnFn, probes, launches };
}

const healthy = (fetched: string[] = []): typeof fetch =>
  (async (url: string) => {
    fetched.push(String(url));
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

describe('createMlxSupervisor', () => {
  it('reuses the supervisor with MLX argv (uv command) + a /v1/models health probe', async () => {
    const fetched: string[] = [];
    const uv = fakeUv(1);
    const sup = createMlxSupervisor({
      uvPath: '/usr/local/bin/uv',
      repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
      port: 8123,
      spawnFn: uv.spawnFn,
      fetchImpl: healthy(fetched),
    });

    await sup.start();
    // Health URL uses /v1/models (mlx_lm.server has no /health); the fixed port
    // is assigned at start().
    expect(sup.healthUrl).toBe('http://127.0.0.1:8123/v1/models');
    // The command spawned is `uv`, with the mlx_lm.server argv.
    expect(uv.launches).toHaveLength(1);
    expect(uv.launches[0]?.cmd).toBe('/usr/local/bin/uv');
    expect(uv.launches[0]?.args).toContain('mlx_lm.server');
    expect(uv.launches[0]?.args).toContain('mlx-community/Qwen3.5-4B-MLX-4bit');
    expect(fetched.some((u) => u.endsWith('/v1/models'))).toBe(true);
    await sup.dispose();
  });

  it('launches --offline when the probe finds the env on disk', async () => {
    const uv = fakeUv(0);
    const sup = createMlxSupervisor({
      uvPath: '/usr/local/bin/uv',
      repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
      port: 8124,
      spawnFn: uv.spawnFn,
      fetchImpl: healthy(),
    });
    await sup.start();
    // The probe asked about the server's own env, through the same uv.
    expect(uv.probes).toEqual([['run', '--offline', ...mlxServerUvEnv(), 'python', '-c', '']]);
    const launched = uv.launches[0]?.args ?? [];
    expect(launched.slice(0, 2)).toEqual(['run', '--offline']);
    expect(launched).toEqual(
      assembleMlxServerArgs({
        repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
        host: '127.0.0.1',
        port: 8124,
        offline: true,
      }),
    );
    // The panel's "current command" is what actually ran.
    expect(sup.argv()).toEqual(launched);
    await sup.dispose();
  });

  it('launches online, exactly as before, when the probe fails (nothing cached yet)', async () => {
    const uv = fakeUv(2);
    const sup = createMlxSupervisor({
      uvPath: '/usr/local/bin/uv',
      repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
      port: 8125,
      spawnFn: uv.spawnFn,
      fetchImpl: healthy(),
    });
    await sup.start();
    expect(uv.probes).toHaveLength(1);
    expect(uv.launches[0]?.args).toEqual(
      assembleMlxServerArgs({
        repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
        host: '127.0.0.1',
        port: 8125,
      }),
    );
    expect(uv.launches[0]?.args).not.toContain('--offline');
    await sup.dispose();
  });
});
