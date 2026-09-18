/**
 * ComfyUI process supervisor — reuses inference's {@link LlamaServerSupervisor}
 * crash-restart / health-poll / graceful-dispose skeleton (exactly as
 * `createMlxSupervisor` does for `mlx_lm.server`) via its `buildArgsFn(port)` +
 * `healthPath` override seams. ComfyUI is a persistent aiohttp server, so it fits
 * the same lifecycle: spawn `python main.py …`, poll a readiness endpoint, restart
 * on crash, SIGTERM→SIGKILL on dispose.
 *
 * The launch flags are the round-13 §2/§3 macOS defaults:
 *   main.py --listen 127.0.0.1 --port <ephemeral> --disable-auto-launch
 *           --extra-model-paths-config <app.yaml> --force-upcast-attention
 * and readiness is a 200 on `/system_stats` (ComfyUI has no `/health`). The
 * arg-builder is pure + exported so it unit-tests without spawning; the
 * health/dispose wiring is exercised with a fake child (see the co-located test).
 *
 * `createComfySupervisor` returns the supervisor AND a memoized `resolveOrigin()`
 * that starts it once and yields the bare http origin (`http://host:port`, no
 * `/v1`) — which is what {@link ComfyClient} needs (the supervisor's own
 * `baseUrl` getter appends `/v1`, an llama.cpp-ism ComfyUI does not use).
 */
import { LlamaServerSupervisor } from '@pi-desktop/inference';

/** Pure launch-arg builder for ComfyUI (`python main.py …`). Exported for tests. */
export interface ComfyLaunchConfig {
  /** Absolute path to the ComfyUI `main.py` (ComfyUI derives its base dir from __file__). */
  readonly mainPy: string;
  /** Bind host (default `127.0.0.1`). */
  readonly host?: string;
  /** `--extra-model-paths-config` yaml pointing at the app-controlled models dir. */
  readonly extraModelPathsYaml?: string;
  /** `--force-upcast-attention` (macOS default ON; pass `false` to omit). */
  readonly forceUpcastAttention?: boolean;
  /** `--fp32-vae`, on unless told otherwise — see buildComfyArgs. */
  readonly fp32Vae?: boolean;
  /** Extra flags appended verbatim. */
  readonly extraArgs?: readonly string[];
}

/**
 * Build the `python`/`uv` argv that launches ComfyUI headless on `port`. Pure.
 * `serverPath` (the python or uv binary) is the command; these are its arguments.
 */
export function buildComfyArgs(cfg: ComfyLaunchConfig, port: number): string[] {
  const host = cfg.host ?? '127.0.0.1';
  const args = [cfg.mainPy, '--listen', host, '--port', String(port), '--disable-auto-launch'];
  if (cfg.extraModelPathsYaml !== undefined && cfg.extraModelPathsYaml.length > 0) {
    args.push('--extra-model-paths-config', cfg.extraModelPathsYaml);
  }
  if (cfg.forceUpcastAttention !== false) args.push('--force-upcast-attention');
  /*
   * THE VAE IN fp32. MEASURED 2026-09-18 on the M5 (Stable Audio 3 small, the
   * same graph, the same seed): ComfyUI picked bfloat16 for the audio VAE on
   * MPS and every clip came out as broadband noise with a click train — the
   * "sfx and music work 0, nada, nothing, random noise" the user reported. The
   * diffusion model in fp16 vs fp32 made no difference at all (identical
   * output); the VAE decode did: in fp32 a "solo piano" prompt shows its
   * harmonics, a door creak its stick-slip pulses. bf16 on MPS is where the
   * garbage comes from, so every VAE decodes in fp32 here (the image and
   * video VAEs are tiled; the cost is memory, not correctness).
   */
  if (cfg.fp32Vae !== false) args.push('--fp32-vae');
  if (cfg.extraArgs !== undefined) args.push(...cfg.extraArgs);
  return args;
}

export interface CreateComfySupervisorOptions extends ComfyLaunchConfig {
  /** Command to spawn — the ComfyUI venv's python (or `uv`). */
  readonly pythonPath: string;
  /** Fixed port; when undefined a free ephemeral port is chosen at start(). */
  readonly port?: number;
  /**
   * Health timeout. Generous: first launch may resolve the venv + torch MPS wheel
   * AND import ComfyUI's node graph before `/system_stats` answers.
   */
  readonly healthTimeoutMs?: number;
  // -- structural injection (tests never spawn/socket) --------------------
  readonly spawnFn?: ConstructorParameters<typeof LlamaServerSupervisor>[0]['spawnFn'];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface ComfySupervisorHandle {
  /** The reused lifecycle supervisor (health / crash-restart / dispose). */
  readonly supervisor: LlamaServerSupervisor;
  /**
   * Start the server once (idempotent/memoized) and resolve its bare http origin,
   * e.g. `http://127.0.0.1:8188`. Pass this straight to {@link ComfyClient}.
   */
  readonly resolveOrigin: () => Promise<string>;
}

/**
 * Build a ComfyUI supervisor reusing {@link LlamaServerSupervisor}'s skeleton via
 * `buildArgsFn` + `healthPath:'/system_stats'`. For a REMOTE ComfyUI, skip this
 * entirely and hand {@link ComfyClient} a constant `resolveOrigin` — the adapter
 * is identical over the socket.
 */
export function createComfySupervisor(opts: CreateComfySupervisorOptions): ComfySupervisorHandle {
  const host = opts.host ?? '127.0.0.1';
  const supervisor = new LlamaServerSupervisor({
    serverPath: opts.pythonPath,
    modelPath: opts.mainPy, // unused by buildArgsFn; kept for logging/parity
    launchMode: 'fast-text', // placeholder — buildArgsFn overrides the argv
    host,
    port: opts.port,
    healthPath: '/system_stats',
    healthTimeoutMs: opts.healthTimeoutMs ?? 120_000,
    buildArgsFn: (port) => buildComfyArgs(opts, port),
    spawnFn: opts.spawnFn,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  });
  let originPromise: Promise<string> | null = null;
  const resolveOrigin = (): Promise<string> => {
    originPromise ??= supervisor.start().then((r) => `http://${host}:${r.port}`);
    return originPromise;
  };
  return { supervisor, resolveOrigin };
}
