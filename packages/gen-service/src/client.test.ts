import { describe, expect, it, vi } from 'vitest';
import {
  GenAbortError,
  type GenChildProcess,
  GenServiceClient,
  type GenSpawnFn,
} from './client.ts';
import type { GenEvent, GenJob } from './protocol.ts';
import { buildWorkerUvArgs, resolveWorkerScript, workerUvEnv } from './worker-command.ts';

/** A controllable fake worker child that records what it was spawned with. */
class FakeChild implements GenChildProcess {
  pid = 4242;
  stdinData = '';
  stdinEnded = false;
  #stdoutCbs: ((chunk: string) => void)[] = [];
  #exitCbs: ((code: number | null, signal: string | null) => void)[] = [];
  #errorCbs: ((err: Error) => void)[] = [];
  killed: NodeJS.Signals | undefined;

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void) => {
      this.stdinData += data;
      cb?.(null);
    },
    end: () => {
      this.stdinEnded = true;
    },
    on: (_e: 'error', _cb: (err: Error) => void) => {},
  };
  stdout = {
    on: (_e: 'data', cb: (chunk: string) => void) => {
      this.#stdoutCbs.push(cb);
    },
  };
  stderr = {
    on: (_e: 'data', _cb: (chunk: string) => void) => {
      this.#stderrCb = _cb;
    },
  };
  #stderrCb: ((chunk: string) => void) | undefined;

  on(event: 'error' | 'exit', cb: never): void {
    if (event === 'exit')
      this.#exitCbs.push(cb as unknown as (c: number | null, s: string | null) => void);
    else this.#errorCbs.push(cb as unknown as (e: Error) => void);
  }
  kill(signal?: NodeJS.Signals): void {
    this.killed = signal;
  }

  // ---- test drivers ----
  emitStdout(text: string): void {
    for (const cb of this.#stdoutCbs) cb(text);
  }
  emitStderr(text: string): void {
    this.#stderrCb?.(text);
  }
  emitExit(code: number | null, signal: string | null = null): void {
    for (const cb of this.#exitCbs) cb(code, signal);
  }
  emitError(err: Error): void {
    for (const cb of this.#errorCbs) cb(err);
  }
}

const IMAGE_JOB: GenJob = {
  id: 'job-1',
  modality: 'image',
  backend: 'mflux',
  outputDir: '/out',
  image: {
    prompt: 'a crane',
    modelId: 'z-image-turbo',
    mfluxCommand: 'mflux-generate-z-image-turbo',
    seeds: [42],
    steps: 4,
    width: 256,
    height: 256,
    quantize: 4,
  },
};

/** The offline probe the client runs before each job: `uv run --offline … python -c ''`. */
const isProbe = (args: readonly string[]): boolean => args.at(-2) === '-c' && args.at(-1) === '';

/** A probe child that answers at once — exit 0 means the job's env is all in uv's cache. */
function probeChild(code: number): GenChildProcess {
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    on(event: 'error' | 'exit', cb: never): void {
      const exit = cb as unknown as (c: number | null, s: string | null) => void;
      if (event === 'exit') queueMicrotask(() => exit(code, null));
    },
    kill: () => {},
  };
}

function clientWith(
  child: FakeChild,
  opts: { cached?: boolean; probe?: GenChildProcess } = {},
): { client: GenServiceClient; spawnFn: GenSpawnFn } {
  const spawnFn: GenSpawnFn = vi.fn((_cmd: string, args: readonly string[]) =>
    isProbe(args) ? (opts.probe ?? probeChild(opts.cached === true ? 0 : 1)) : child,
  );
  const client = new GenServiceClient({ uvPath: '/usr/bin/uv', spawnFn });
  return { client, spawnFn };
}

/** Every spawn, as [args, env] — the probe first, then the worker. */
const spawns = (spawnFn: GenSpawnFn): [string[], NodeJS.ProcessEnv][] =>
  (spawnFn as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[1] as string[], c[2].env]);

/** The worker's argv (not the probe's). */
const launchArgs = (spawnFn: GenSpawnFn): string[] =>
  spawns(spawnFn).find(([args]) => !isProbe(args))?.[0] ?? [];

/** `run()` is async (it resolves uv before spawning), so let the spawn + handler
 * wiring settle before driving the fake child — one macrotask drains the
 * microtasks the awaits queue. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('GenServiceClient.run', () => {
  it("spawns the worker on the job's own mflux build when one is named (a bundled wheel)", async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child);
    const p = client.run(IMAGE_JOB, { mfluxWith: '/res/gen-worker/wheels/mflux-x.whl' });
    await flush();
    const args = launchArgs(spawnFn);
    expect(args[args.indexOf('--with') + 1]).toBe('/res/gen-worker/wheels/mflux-x.whl');
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    child.emitStdout('{"event":"done","jobId":"job-1","outputs":[]}\n');
    child.emitExit(0);
    await expect(p).resolves.toEqual([]);
  });

  it('streams events and resolves with outputs on done', async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child);
    const events: GenEvent[] = [];

    const p = client.run(IMAGE_JOB, { onEvent: (e) => events.push(e) });
    await flush();

    // The job envelope was written to stdin and stdin closed.
    expect(child.stdinData).toContain('"id":"job-1"');
    expect(child.stdinEnded).toBe(true);
    // Spawned uv with the worker argv.
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/uv',
      expect.arrayContaining(['run', 'python']),
      expect.objectContaining({
        env: expect.objectContaining({ UV_PYTHON_DOWNLOADS: 'automatic' }),
      }),
    );

    // Drive a realistic stream, split across chunk boundaries.
    child.emitStdout('{"event":"start","jobId":"job-1","total":4,"candidates":1}\n');
    child.emitStdout('{"event":"progress","jobId":"job-1","candidate":0,"step":1,"tot');
    child.emitStdout('al":4,"previewPath":"/out/steps/s.png"}\n');
    child.emitStdout(
      '{"event":"candidate","jobId":"job-1","index":0,"output":{"outputPath":"/out/o.png","modality":"image","model":"z-image-turbo","seed":42}}\n',
    );
    child.emitStdout(
      '{"event":"done","jobId":"job-1","outputs":[{"outputPath":"/out/o.png","modality":"image","model":"z-image-turbo","seed":42,"width":256,"height":256}]}\n',
    );
    child.emitExit(0);

    const outputs = await p;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.outputPath).toBe('/out/o.png');
    expect(outputs[0]?.model).toBe('z-image-turbo');
    expect(events.map((e) => e.event)).toEqual(['start', 'progress', 'candidate', 'done']);
  });

  it('parses a trailing done line delivered without a newline before exit', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB);
    await flush();
    child.emitStdout('{"event":"done","jobId":"job-1","outputs":[]}'); // no newline
    child.emitExit(0);
    await expect(p).resolves.toEqual([]);
  });

  it('rejects with the worker error message on an error event', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB);
    await flush();
    child.emitStdout(
      '{"event":"error","jobId":"job-1","message":"CUDA not found","recoverable":false}\n',
    );
    child.emitExit(1);
    await expect(p).rejects.toThrow('CUDA not found');
  });

  it('rejects with stderr detail when the worker exits without a terminal event', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB);
    await flush();
    child.emitStderr('Traceback: boom');
    child.emitExit(1);
    await expect(p).rejects.toThrow(/without a done\/error event.*boom/s);
  });

  it('aborts: SIGKILLs the worker and rejects with GenAbortError', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(GenAbortError);
    expect(child.killed).toBe('SIGKILL');
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run(IMAGE_JOB, { signal: controller.signal })).rejects.toBeInstanceOf(
      GenAbortError,
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('offline first', () => {
  /*
   * With no network a job used to fail inside uv — "Failed to fetch:
   * https://pypi.org/simple/mflux/" — once uv's index cache was ten minutes
   * old, although mflux, the wheel and the env were all on disk. The client
   * now asks first (a silent `uv run --offline` probe of the job's own env)
   * and launches `--offline` when everything is cached.
   */
  const workerScript = resolveWorkerScript();
  const done = (child: FakeChild): void => {
    child.emitStdout('{"event":"done","jobId":"job-1","outputs":[]}\n');
    child.emitExit(0);
  };

  it("probes the job's own env through the same spawn and env, then launches --offline", async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child, { cached: true });
    const p = client.run(IMAGE_JOB);
    await flush();
    const [probe, launch] = spawns(spawnFn);
    expect(probe?.[0]).toEqual([
      'run',
      '--offline',
      ...workerUvEnv({ workerScript, backend: 'mflux' }),
      'python',
      '-c',
      '',
    ]);
    expect(launch?.[0]).toEqual(
      buildWorkerUvArgs({ workerScript, backend: 'mflux', offline: true }),
    );
    expect(launch?.[0].slice(0, 2)).toEqual(['run', '--offline']);
    // Same env for both: the probe asks exactly what the launch will do.
    expect(probe?.[1]).toBe(launch?.[1]);
    expect(launch?.[1]?.UV_PYTHON_DOWNLOADS).toBe('automatic');
    done(child);
    await expect(p).resolves.toEqual([]);
  });

  it('launches online, byte-for-byte as before, when the probe says not cached', async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child, { cached: false });
    const p = client.run(IMAGE_JOB);
    await flush();
    expect(spawns(spawnFn)).toHaveLength(2);
    expect(launchArgs(spawnFn)).toEqual(buildWorkerUvArgs({ workerScript, backend: 'mflux' }));
    expect(launchArgs(spawnFn)).not.toContain('--offline');
    done(child);
    await expect(p).resolves.toEqual([]);
  });

  it('asks about the extra deps too (Kokoro: mlx-audio + misaki[en])', async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child, { cached: true });
    const p = client.run({ ...IMAGE_JOB, backend: 'mlx-audio' }, { extraWith: ['misaki[en]'] });
    await flush();
    const [probe] = spawns(spawnFn);
    expect(probe?.[0]).toContain('misaki[en]');
    expect(probe?.[0]).toContain('mlx-audio==0.4.5');
    expect(launchArgs(spawnFn)).toEqual(
      buildWorkerUvArgs({
        workerScript,
        backend: 'mlx-audio',
        extraWith: ['misaki[en]'],
        offline: true,
      }),
    );
    done(child);
    await p;
  });

  it('an abort while the probe runs never launches the worker', async () => {
    let answer: (code: number) => void = () => {};
    const slowProbe: GenChildProcess = {
      stdin: null,
      stdout: null,
      stderr: null,
      on(event: 'error' | 'exit', cb: never): void {
        if (event === 'exit') answer = (code) => (cb as unknown as (c: number) => void)(code);
      },
      kill: () => {},
    };
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child, { probe: slowProbe });
    const controller = new AbortController();
    const p = client.run(IMAGE_JOB, { signal: controller.signal });
    await flush();
    controller.abort();
    answer(0);
    await expect(p).rejects.toBeInstanceOf(GenAbortError);
    expect(spawns(spawnFn).map(([args]) => isProbe(args))).toEqual([true]);
  });
});

describe('the worker says what it is doing', () => {
  /*
   * the user: the image studio "won't work at all". MEASURED on his Mac with the
   * weights already cached: 94 seconds between pressing Generate and step 1,
   * with the room showing "Starting…" throughout. Everything the worker said in
   * that window went into a buffer that was only read if the job FAILED.
   */
  it('emits a log event for each stderr chunk, not just on failure', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const events: GenEvent[] = [];
    const p = client.run(IMAGE_JOB, { onEvent: (e) => events.push(e) });
    await flush();

    child.emitStderr('Fetching 12 files:  30%|###\n');
    child.emitStderr('Loading model…\n');
    child.emitStdout(`${JSON.stringify({ event: 'done', jobId: 'job-1', outputs: [] })}\n`);
    child.emitExit(0);
    await p;

    const logs = events.filter((e) => e.event === 'log');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ jobId: 'job-1', text: expect.stringContaining('Fetching') });
    expect(logs[1]).toMatchObject({ text: expect.stringContaining('Loading model') });
  });
});
