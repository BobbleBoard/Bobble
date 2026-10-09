/**
 * GenServiceClient — the Node half of the generation worker. It launches the uv
 * worker ({@link ./worker-command}), streams the job JSON to its stdin, parses
 * the worker's NDJSON {@link GenEvent}s, and resolves with the produced outputs.
 *
 * The process runtime is injected structurally (`spawnFn`) so it unit-tests in
 * plain Node against a fake worker — mirroring afm/stream.ts and
 * inference/supervisor.ts. The command it builds IS remote-capable: swap the
 * default local-uv `spawnFn` for one that runs the same argv over SSH and the
 * exact same NDJSON stream flows back, no protocol change.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { uvEnvCached } from '@pi-desktop/inference/uv-run';
import { type GenEvent, type GenJob, type GenOutput, NdjsonParser } from './protocol.js';
import {
  buildWorkerUvArgs,
  resolveWorkerScript,
  type WorkerUvArgsOptions,
  workerUvEnv,
} from './worker-command.js';

/** Minimal stdin surface (write the job, then close). */
export interface GenWritable {
  write(data: string, cb?: (err?: Error | null) => void): void;
  end(): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Minimal readable surface (stdout / stderr). */
export interface GenReadable {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

/** Structural child so tests inject a fake without spawning uv. */
export interface GenChildProcess {
  readonly pid?: number;
  stdin: GenWritable | null;
  stdout: GenReadable | null;
  stderr: GenReadable | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type GenSpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => GenChildProcess;

/** Real spawn with piped stdio, adapted to {@link GenChildProcess}. */
export const defaultGenSpawn: GenSpawnFn = (command, args, options) =>
  nodeSpawn(command, args as string[], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
  }) as unknown as GenChildProcess;

export class GenAbortError extends Error {
  constructor() {
    super('generation aborted');
    this.name = 'GenAbortError';
  }
}

/** Read fresh at each call (TypeScript keeps a property's narrowing across an await). */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Resolve an executable by scanning PATH (absolute path). Mirrors mlx-manager. */
async function resolveOnPath(
  name: string,
  pathEnv: string | undefined,
): Promise<string | undefined> {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

export interface GenServiceClientOptions {
  /** The `uv` binary path. When unset it is resolved on PATH at first run. */
  readonly uvPath?: string;
  /** Explicit worker.py path (packaged app). Default = bundled `python/worker.py`. */
  readonly workerScript?: string;
  /** mflux pin passed to `uv --with` (default {@link MFLUX_PIN}). */
  readonly mfluxPin?: string;
  readonly python?: string;
  /** Injectable spawn (tests / a remote transport). Default: local uv spawn. */
  readonly spawnFn?: GenSpawnFn;
  /** Injectable uv resolver (tests). Default: PATH probe. */
  readonly resolveUv?: () => Promise<string>;
  /**
   * The worker just spawned for a job — its pid is what the app's memory guard
   * stops in place (SIGSTOP) when the machine is tight, and ends if that does
   * not help. Called once per `run`, before the first event.
   */
  readonly onChild?: (jobId: string, child: GenChildProcess) => void;
}

export interface RunJobOptions {
  /** Called for EVERY worker event (start/download/progress/candidate/done/error/log). */
  readonly onEvent?: (event: GenEvent) => void;
  /** Aborts the job and SIGKILLs the worker. */
  readonly signal?: AbortSignal;
  /** Extra `uv --with` deps for this job's backend (e.g. `mlx-audio`). */
  readonly extraWith?: readonly string[];
  /**
   * The mflux build this job runs on, in place of the client's pin: the
   * absolute path of the model's bundled wheel (catalog `mflux.wheel`, resolved
   * against worker.py by {@link bundledWheelPath}).
   */
  readonly mfluxWith?: string;
}

/**
 * Runs generation jobs by spawning the uv worker. One client can run many jobs
 * (each `run()` spawns its own worker); serialization/concurrency is the
 * JobQueue's concern, not the client's.
 */
export class GenServiceClient {
  readonly #opts: GenServiceClientOptions;
  #uvPath: string | undefined;

  constructor(opts: GenServiceClientOptions = {}) {
    this.#opts = opts;
    this.#uvPath = opts.uvPath;
  }

  async #resolveUvPath(): Promise<string> {
    if (this.#uvPath !== undefined) return this.#uvPath;
    if (this.#opts.resolveUv !== undefined) {
      this.#uvPath = await this.#opts.resolveUv();
      return this.#uvPath;
    }
    const found = await resolveOnPath('uv', process.env.PATH);
    if (found === undefined) {
      throw new Error(
        'uv is required to run generation models. Install uv (https://docs.astral.sh/uv/) and retry.',
      );
    }
    this.#uvPath = found;
    return found;
  }

  /**
   * Run one job to completion. Resolves with the produced outputs on the worker's
   * terminal `done`; rejects on `error`, an unexpected exit, or abort.
   */
  async run(job: GenJob, options: RunJobOptions = {}): Promise<GenOutput[]> {
    if (isAborted(options.signal)) throw new GenAbortError();
    const uvPath = await this.#resolveUvPath();
    const workerScript = resolveWorkerScript(this.#opts.workerScript);
    const argOpts: WorkerUvArgsOptions = {
      workerScript,
      /*
       * THE JOB'S OWN BACKEND, which this had never passed.
       *
       * `buildWorkerUvArgs` defaults `backend` to 'mflux', so EVERY job that
       * reaches the uv worker got an env with mflux in it and nothing else —
       * correct for image and wrong for every other backend that runs here.
       * MEASURED, from the Audio Studio: "No module named 'mlx_audio'", after
       * the identical argv had been confirmed to work by hand. `baseWorkerWith`
       * has always known the right dep per backend; nobody was asking it.
       */
      backend: job.backend,
      mfluxPin: this.#opts.mfluxPin,
      ...(options.mfluxWith !== undefined ? { mfluxWith: options.mfluxWith } : {}),
      python: this.#opts.python,
      extraWith: options.extraWith,
    };
    const spawnFn = this.#opts.spawnFn ?? defaultGenSpawn;
    const env = { ...process.env, UV_PYTHON_DOWNLOADS: 'automatic' };
    /*
     * OFFLINE FIRST. uv re-resolves the `--with` packages against PyPI on every
     * run once its index cache is ten minutes old, so with no network a job
     * failed before worker.py started — mflux, the wheel and the env all on
     * disk. A silent `uv run --offline` probe of the job's own env comes first;
     * everything cached → the worker launches `--offline`, else online as it
     * always did (uv-run.ts). The probe goes through `spawnFn`, the transport,
     * so it asks the uv that will run the job.
     */
    const offline = await uvEnvCached(
      (args) => spawnFn(uvPath, args, { env }),
      workerUvEnv(argOpts),
    );
    // The probe took a moment; an abort inside it must still stop the job.
    if (isAborted(options.signal)) throw new GenAbortError();
    const args = buildWorkerUvArgs({ ...argOpts, offline });

    return await new Promise<GenOutput[]>((resolve, reject) => {
      let child: GenChildProcess;
      try {
        child = spawnFn(uvPath, args, { env });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.#opts.onChild?.(job.id, child);

      const parser = new NdjsonParser();
      let settled = false;
      let outputs: GenOutput[] | null = null;
      let errored: { message: string; recoverable?: boolean } | null = null;
      let stderrTail = '';

      const onAbort = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        settle(() => reject(new GenAbortError()));
      };

      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const handleEvent = (event: GenEvent): void => {
        options.onEvent?.(event);
        if (event.event === 'done') {
          outputs = [...event.outputs];
        } else if (event.event === 'error') {
          errored = { message: event.message, recoverable: event.recoverable };
        }
      };

      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk) => {
        for (const event of parser.push(String(chunk))) handleEvent(event);
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        stderrTail = (stderrTail + text).slice(-2000);
        /*
         * SAY WHAT IT IS DOING. The protocol has always had a `log` event and
         * nothing ever produced one: stderr was collected here purely so a
         * FAILURE could quote it. Everything the worker says while it works —
         * uv provisioning a Python environment, HuggingFace fetching weights,
         * mflux loading a model — went into a buffer nobody read until it was
         * too late.
         *
         * MEASURED on the user's Mac with the weights already cached: 94 seconds
         * between pressing Generate and the first diffusion step, with the room
         * showing "Starting…" for all of it. The user reported the studio as "won't
         * work at all", and from the outside that is exactly what it looked
         * like. Advisory only — never parsed, only shown.
         */
        handleEvent({ event: 'log', jobId: job.id, text });
      });
      child.on('error', (err) => settle(() => reject(err)));
      child.on('exit', (code) => {
        for (const event of parser.flush()) handleEvent(event);
        if (errored !== null) {
          const e = errored as { message: string; recoverable?: boolean };
          settle(() => reject(new Error(e.message)));
          return;
        }
        if (outputs !== null) {
          const out = outputs as GenOutput[];
          settle(() => resolve(out));
          return;
        }
        const detail = stderrTail.trim().length > 0 ? `: ${stderrTail.trim().slice(-500)}` : '';
        settle(() =>
          reject(
            new Error(
              `gen worker exited (code ${code ?? 'null'}) without a done/error event${detail}`,
            ),
          ),
        );
      });

      // Send the job envelope, then close stdin.
      try {
        child.stdin?.on('error', (err) => settle(() => reject(err)));
        child.stdin?.write(`${JSON.stringify(job)}\n`, (err) => {
          if (err != null) settle(() => reject(err));
        });
        child.stdin?.end();
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }
}
