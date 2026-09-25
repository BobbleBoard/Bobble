import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleSidecarArgs,
  Gen3dSidecar,
  resolveUv,
  SIDECAR_HF_HUB_PIN,
  sidecarProbeArgs,
  sidecarUvEnv,
} from './sidecar';

describe('assembleSidecarArgs', () => {
  it('builds the pinned uv run argv', () => {
    const args = assembleSidecarArgs({
      serverScript: '/pkg/python/server.py',
      port: 4242,
      cacheDir: '/home/u/.cache/pi-desktop/gen3d',
      sandboxDir: '/home/u/.pi/desktop/sandbox/gen3d',
      registryPath: '/home/u/.cache/pi-desktop/gen3d/registry.json',
    });
    expect(args).toEqual([
      'run',
      '--no-project',
      '--python',
      '3.12',
      '--with',
      `huggingface_hub==${SIDECAR_HF_HUB_PIN}`,
      '/pkg/python/server.py',
      '--port',
      '4242',
      '--cache-dir',
      '/home/u/.cache/pi-desktop/gen3d',
      '--sandbox-dir',
      '/home/u/.pi/desktop/sandbox/gen3d',
      '--registry',
      '/home/u/.cache/pi-desktop/gen3d/registry.json',
    ]);
  });
});

const CFG = {
  serverScript: '/pkg/python/server.py',
  port: 4242,
  cacheDir: '/c',
  sandboxDir: '/s',
  registryPath: '/c/registry.json',
};

describe('the offline launch', () => {
  it('is the same argv with --offline straight after `run`', () => {
    const online = assembleSidecarArgs(CFG);
    expect(online).not.toContain('--offline');
    expect(assembleSidecarArgs({ ...CFG, offline: true })).toEqual([
      'run',
      '--offline',
      ...online.slice(1),
    ]);
  });

  it("probes the env the sidecar launches in: `uv run --offline <env> python -c ''`", () => {
    const online = assembleSidecarArgs(CFG);
    expect(sidecarUvEnv()).toEqual(online.slice(1, online.indexOf(CFG.serverScript)));
    expect(sidecarProbeArgs()).toEqual(['run', '--offline', ...sidecarUvEnv(), 'python', '-c', '']);
    expect(sidecarProbeArgs({ hfHubPin: '9.9.9' })).toContain('huggingface_hub==9.9.9');
  });
});

/** A fake uv: its probe exits with `probeExit()` (or errors), its server runs until killed. */
function fakeUv(probeExit: () => number | 'error') {
  const probes: { args: string[]; opts: { stdio?: unknown; env?: NodeJS.ProcessEnv } }[] = [];
  const launches: { args: string[]; env?: NodeJS.ProcessEnv; child: EventEmitter }[] = [];
  const spawnFn = ((
    _cmd: string,
    args: string[],
    opts: { stdio?: unknown; env?: NodeJS.ProcessEnv },
  ) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null as number | null,
      kill: () => true,
    });
    if (args.at(-2) === '-c' && args.at(-1) === '') {
      probes.push({ args, opts });
      const outcome = probeExit();
      queueMicrotask(() =>
        outcome === 'error'
          ? child.emit('error', new Error('spawn uv ENOENT'))
          : child.emit('exit', outcome, null),
      );
    } else {
      launches.push({ args, env: opts.env, child });
    }
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, probes, launches };
}

const healthyFetch = (async () => ({ ok: true }) as Response) as unknown as typeof fetch;

function sidecarOn(uv: ReturnType<typeof fakeUv>): Gen3dSidecar {
  return new Gen3dSidecar({
    uvPath: '/app/uv',
    ...CFG,
    env: { PATH: '/app' },
    spawnFn: uv.spawnFn,
    fetchImpl: healthyFetch,
  });
}

describe('Gen3dSidecar starts offline first', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('launches --offline when the probe finds the env on disk — same env for both', async () => {
    const uv = fakeUv(() => 0);
    const sidecar = sidecarOn(uv);
    await sidecar.ensureStarted();
    expect(uv.probes.map((p) => p.args)).toEqual([sidecarProbeArgs()]);
    expect(uv.probes[0]?.opts.stdio).toBe('ignore');
    expect(uv.launches.map((l) => l.args)).toEqual([
      assembleSidecarArgs({ ...CFG, offline: true }),
    ]);
    expect(uv.probes[0]?.opts.env).toBe(uv.launches[0]?.env);
    expect(uv.launches[0]?.env?.HF_HOME).toBe('/c/hf');
    expect(uv.launches[0]?.env?.PATH).toBe('/app');
    sidecar.dispose();
  });

  it('launches online, byte-for-byte as before, when the probe fails or cannot start', async () => {
    for (const outcome of [1, 'error'] as const) {
      const uv = fakeUv(() => outcome);
      const sidecar = sidecarOn(uv);
      await sidecar.ensureStarted();
      expect(uv.launches.map((l) => l.args)).toEqual([assembleSidecarArgs(CFG)]);
      sidecar.dispose();
    }
  });

  it('asks again before each crash restart', async () => {
    vi.useFakeTimers();
    // Nothing cached on the first start (uv downloads), all cached by the restart.
    const exits = [1, 0];
    const uv = fakeUv(() => exits.shift() ?? 0);
    const sidecar = sidecarOn(uv);
    await sidecar.ensureStarted();
    expect(uv.launches[0]?.args).not.toContain('--offline');

    uv.launches[0]?.child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000); // the first backoff
    expect(uv.probes).toHaveLength(2);
    expect(uv.launches).toHaveLength(2);
    expect(uv.launches[1]?.args.slice(0, 2)).toEqual(['run', '--offline']);
    sidecar.dispose();
  });

  it('spawns no server when disposed while the probe runs', async () => {
    let answer: () => void = () => {};
    const uv = fakeUv(() => 0);
    const slow = ((cmd: string, args: string[], opts: object) => {
      const child = (uv.spawnFn as unknown as (c: string, a: string[], o: object) => EventEmitter)(
        cmd,
        args,
        opts,
      );
      if (args.at(-1) === '') {
        // Hold the probe's exit until the test lets it go.
        const emit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event !== 'exit') return emit(event, ...rest);
          answer = () => emit(event, ...rest);
          return true;
        }) as typeof child.emit;
      }
      return child;
    }) as unknown as typeof spawn;
    const sidecar = new Gen3dSidecar({
      uvPath: '/app/uv',
      ...CFG,
      spawnFn: slow,
      fetchImpl: healthyFetch,
    });
    const starting = sidecar.ensureStarted();
    await new Promise((r) => setTimeout(r, 0));
    sidecar.dispose();
    answer();
    await expect(starting).rejects.toThrow(/disposed/);
    expect(uv.launches).toHaveLength(0);
  });
});

describe('resolveUv', () => {
  const statFor = (present: string[]) => async (p: string) => {
    if (present.includes(p)) return { isFile: () => true };
    throw new Error('ENOENT');
  };

  it('prefers PATH hits', async () => {
    const uv = await resolveUv({
      pathEnv: '/usr/local/bin:/opt/bin',
      home: '/home/u',
      statFn: statFor(['/opt/bin/uv', '/home/u/.local/bin/uv']),
    });
    expect(uv).toBe('/opt/bin/uv');
  });

  it('falls back to the app-provisioned copy, then ~/.local/bin', async () => {
    const provisioned = await resolveUv({
      pathEnv: '/usr/bin',
      home: '/home/u',
      statFn: statFor(['/home/u/.cache/pi-desktop/uv/uv']),
    });
    expect(provisioned).toBe('/home/u/.cache/pi-desktop/uv/uv');
    const local = await resolveUv({
      pathEnv: '/usr/bin',
      home: '/home/u',
      statFn: statFor(['/home/u/.local/bin/uv']),
    });
    expect(local).toBe('/home/u/.local/bin/uv');
  });

  it('returns undefined when uv is nowhere', async () => {
    expect(
      await resolveUv({ pathEnv: '/usr/bin', home: '/h', statFn: statFor([]) }),
    ).toBeUndefined();
  });
});
