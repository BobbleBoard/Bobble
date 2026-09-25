/**
 * `uv run --with …` that still starts with no network.
 *
 * uv re-resolves `--with` requirements against the package index on EVERY run,
 * and PyPI serves its simple-index pages with `cache-control: max-age=600`. So
 * about ten minutes after uv last resolved them, a launch with no network fails
 * — "Request failed after 3 retries … Failed to fetch:
 * https://pypi.org/simple/mflux/" — although the interpreter, the wheels and
 * the built environment are all on disk. MEASURED 2026-09-25 (uv 0.11.26, index
 * pages 12 h old, network cut): every `--with` launch the app makes failed that
 * way — the MLX server, the gen worker, the module warm, the 3D sidecar.
 *
 * So ask first. A silent `uv run --offline <env> python -c ''` exits 0 only when
 * the environment resolves and installs from uv's cache alone; the launch then
 * runs with `--offline` too and never touches the network. Otherwise — a fresh
 * machine, a pin bump, a package never fetched — it launches exactly as before
 * and uv downloads what it needs. `--offline` is uv's own switch: the program
 * it runs sees the same environment either way.
 *
 * `env` here is always the `uv run` options that define the environment —
 * everything between `run` and the command — so the probe and the launch
 * resolve the SAME environment by construction.
 */

/** `uv run [--offline] <env…> <command…>`. Pure. */
export function uvRunArgs(
  env: readonly string[],
  command: readonly string[],
  opts: { readonly offline?: boolean } = {},
): string[] {
  return ['run', ...(opts.offline === true ? ['--offline'] : []), ...env, ...command];
}

/** The probe: `uv run --offline <env…> python -c ''`. Pure. */
export function uvOfflineProbeArgs(env: readonly string[]): string[] {
  return uvRunArgs(env, ['python', '-c', ''], { offline: true });
}

/**
 * What the probe needs of a started process: its exit. Node's ChildProcess
 * fits, as do the structural children the supervisors and the gen client spawn.
 */
export interface UvProbeChild {
  readonly stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  readonly stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: 'SIGKILL'): void;
}

/**
 * A probe answers in 20–800 ms (MEASURED; the upper end is uv building the env
 * from cached wheels, which the launch then reuses). One that has not answered
 * by this is abandoned, and the launch goes online as it always did.
 */
export const UV_PROBE_TIMEOUT_MS = 120_000;

/**
 * Is `env` complete in uv's cache? Runs {@link uvOfflineProbeArgs} through
 * `start` — the same spawn the launch will use, so the answer comes from the
 * uv (and the machine) the launch runs on — and resolves true on exit 0 alone.
 * Not cached, no uv, a spawn error, the timeout: false, which means "launch
 * online, as before". Never rejects.
 */
export function uvEnvCached(
  start: (args: string[]) => UvProbeChild,
  env: readonly string[],
  opts: { readonly timeoutMs?: number } = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: UvProbeChild;
    try {
      child = start(uvOfflineProbeArgs(env));
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve(false);
    }, opts.timeoutMs ?? UV_PROBE_TIMEOUT_MS);
    const settle = (cached: boolean): void => {
      clearTimeout(timer);
      resolve(cached);
    };
    // Nothing reads the probe's output; drain it so a pipe can never fill and stall uv.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    child.on('error', () => settle(false));
    child.on('exit', (code) => settle(code === 0));
  });
}
