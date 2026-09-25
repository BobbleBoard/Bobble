/**
 * The gen3d sidecar supervisor — spawns the uv-provisioned Python server
 * (python/server.py, stdlib http + pinned huggingface_hub) and owns its
 * lifecycle: health probing, crash restart with backoff, disposal. Mirrors
 * the mlx-manager/LlamaServerSupervisor pattern but is self-contained so this
 * package has no dependency on packages/inference.
 *
 * All process/network IO is injectable for tests; arg assembly is pure.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as net from 'node:net';
import { delimiter, join } from 'node:path';

/** Pinned sidecar deps (uv `--with`). huggingface_hub is the only runtime dep
 * of server.py itself — workers run in their own provisioned venvs. */
export const SIDECAR_HF_HUB_PIN = '0.34.4';
export const SIDECAR_PYTHON = '3.12';

export interface SidecarArgsConfig {
  /** Absolute path to python/server.py. */
  readonly serverScript: string;
  readonly port: number;
  /** Engine cache root (weights/venvs/stamps). */
  readonly cacheDir: string;
  /** Job-artifact root (inside the renderer-readable sandbox fence). */
  readonly sandboxDir: string;
  /** Registry JSON path (written from catalog.toSidecarRegistry()). */
  readonly registryPath: string;
  readonly hfHubPin?: string;
  readonly python?: string;
  /** `uv run --offline`: the probe found the env already in uv's cache. */
  readonly offline?: boolean;
}

/**
 * The `uv run` options that make the sidecar's environment — everything
 * between `run` and server.py. The launch and its offline probe both take it
 * from here, so they resolve one env. Pure.
 */
export function sidecarUvEnv(cfg: Pick<SidecarArgsConfig, 'hfHubPin' | 'python'> = {}): string[] {
  return [
    '--no-project',
    '--python',
    cfg.python ?? SIDECAR_PYTHON,
    '--with',
    `huggingface_hub==${cfg.hfHubPin ?? SIDECAR_HF_HUB_PIN}`,
  ];
}

/**
 * The offline probe: `uv run --offline <env> python -c ''` exits 0 only when
 * the sidecar's env resolves and installs from uv's cache alone. Pure. (The
 * same probe as @pi-desktop/inference's uv-run.ts, kept here because this
 * package is self-contained.)
 */
export function sidecarProbeArgs(
  cfg: Pick<SidecarArgsConfig, 'hfHubPin' | 'python'> = {},
): string[] {
  return ['run', '--offline', ...sidecarUvEnv(cfg), 'python', '-c', ''];
}

/** Build the uv argv for the sidecar. Pure. */
export function assembleSidecarArgs(cfg: SidecarArgsConfig): string[] {
  return [
    'run',
    ...(cfg.offline === true ? ['--offline'] : []),
    ...sidecarUvEnv(cfg),
    cfg.serverScript,
    '--port',
    String(cfg.port),
    '--cache-dir',
    cfg.cacheDir,
    '--sandbox-dir',
    cfg.sandboxDir,
    '--registry',
    cfg.registryPath,
  ];
}

/** A probe answers in well under a second; one that has not by this is abandoned (→ online). */
export const SIDECAR_PROBE_TIMEOUT_MS = 120_000;

/**
 * Run the offline probe through the sidecar's own spawn and env; true on exit 0
 * alone. Not cached, no uv, a spawn error, the timeout: false — launch online,
 * as before. Never rejects.
 */
function envCached(
  spawnFn: typeof spawn,
  uvPath: string,
  probeArgs: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = SIDECAR_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(uvPath, probeArgs, { stdio: 'ignore', env });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    const settle = (cached: boolean): void => {
      clearTimeout(timer);
      resolve(cached);
    };
    child.on('error', () => settle(false));
    child.on('exit', (code) => settle(code === 0));
  });
}

/**
 * Resolve the uv binary: PATH first, then the app's own provisioned copy at
 * ~/.cache/pi-desktop/uv/uv (how the rest of the app bootstraps Python), then
 * ~/.local/bin/uv (the standard installer location).
 */
export async function resolveUv(opts: {
  readonly pathEnv?: string;
  readonly home?: string;
  readonly statFn?: (p: string) => Promise<{ isFile(): boolean }>;
}): Promise<string | undefined> {
  const statFn = opts.statFn ?? stat;
  const candidates: string[] = [];
  for (const dir of (opts.pathEnv ?? '').split(delimiter)) {
    if (dir.length > 0) candidates.push(join(dir, 'uv'));
  }
  if (opts.home !== undefined && opts.home.length > 0) {
    candidates.push(join(opts.home, '.cache', 'bobble', 'uv', 'uv'));
    candidates.push(join(opts.home, '.cache', 'pi-desktop', 'uv', 'uv'));
    candidates.push(join(opts.home, '.local', 'bin', 'uv'));
  }
  for (const candidate of candidates) {
    try {
      const s = await statFn(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/** Pick a free localhost port (the sidecar binds it before health passes). */
export async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Gen3dSidecarOptions {
  readonly uvPath: string;
  readonly serverScript: string;
  readonly cacheDir: string;
  readonly sandboxDir: string;
  readonly registryPath: string;
  readonly port: number;
  /** Extra env (HF_HOME is set automatically to <cacheDir>/hf). */
  readonly env?: Record<string, string>;
  readonly healthTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly spawnFn?: typeof spawn;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Called when the sidecar exits and no restart is attempted. */
  readonly onDown?: () => void;
}

/** Supervises one sidecar process. `ensureStarted` is idempotent. */
export class Gen3dSidecar {
  readonly baseUrl: string;
  private child: ChildProcess | null = null;

  /** The sidecar process — the root of every worker it runs (memory guard). */
  get pid(): number | undefined {
    return this.child?.pid;
  }
  private disposed = false;
  private restarts = 0;
  private starting: Promise<void> | null = null;
  private readonly opts: Gen3dSidecarOptions;

  constructor(opts: Gen3dSidecarOptions) {
    this.opts = opts;
    this.baseUrl = `http://127.0.0.1:${opts.port}`;
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('gen3d sidecar disposed');
    if (this.starting !== null) return this.starting;
    this.starting = this.startOnce().catch((err) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const log = this.opts.log ?? (() => {});
    const env = {
      ...process.env,
      HF_HOME: join(this.opts.cacheDir, 'hf'),
      ...this.opts.env,
    };
    const cfg: SidecarArgsConfig = {
      serverScript: this.opts.serverScript,
      port: this.opts.port,
      cacheDir: this.opts.cacheDir,
      sandboxDir: this.opts.sandboxDir,
      registryPath: this.opts.registryPath,
    };
    /*
     * OFFLINE FIRST, before every start and every restart. uv re-resolves
     * `--with huggingface_hub==<pin>` against PyPI on each run once its index
     * cache is ten minutes old, so with no network the sidecar died inside uv —
     * "Failed to fetch: https://pypi.org/simple/huggingface-hub/" — and each
     * backoff restart failed the same way, with Python and the package on disk
     * (MEASURED 2026-09-25). A silent `--offline` probe decides: all cached →
     * launch `--offline`; not (a fresh machine, a pin bump) → online, as before.
     */
    const offline = await envCached(spawnFn, this.opts.uvPath, sidecarProbeArgs(cfg), env);
    if (this.disposed) throw new Error('gen3d sidecar disposed');
    const child = spawnFn(this.opts.uvPath, assembleSidecarArgs({ ...cfg, offline }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => log('sidecar', { out: d.toString().trimEnd() }));
    child.stderr?.on('data', (d: Buffer) => log('sidecar', { err: d.toString().trimEnd() }));
    child.on('exit', (code) => {
      log('sidecar exited', { code });
      this.child = null;
      this.starting = null;
      if (this.disposed) return;
      if (this.restarts < (this.opts.maxRestarts ?? 3)) {
        const backoffMs = [1_000, 5_000, 15_000][this.restarts] ?? 15_000;
        this.restarts += 1;
        setTimeout(() => {
          if (!this.disposed) void this.ensureStarted().catch(() => this.opts.onDown?.());
        }, backoffMs);
      } else {
        this.opts.onDown?.();
      }
    });

    await this.waitHealthy();
    this.restarts = 0;
  }

  private async waitHealthy(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('gen3d sidecar disposed');
      try {
        const res = await fetchImpl(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('gen3d sidecar failed health check');
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (child === null) return;
    this.child = null;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3_000);
    killTimer.unref?.();
  }
}
