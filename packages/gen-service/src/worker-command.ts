/**
 * Build the command that launches the Python generation worker under uv, and
 * resolve the bundled worker script. Pure + injectable so the argv is testable
 * without spawning (mirrors inference/mlx-manager's `assembleMlxServerArgs` and
 * afm/helper-path's binary resolution).
 *
 * The worker is launched exactly the same way locally and (later) remotely — the
 * argv here IS the remote command too; only the transport that runs it changes.
 * That is what keeps the job API remote-capable from day one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend } from './protocol.js';

/**
 * Pinned mflux version passed to `uv --with`. Bump deliberately. Verified on this
 * M5 Pro (2026-07): `uv run --with mflux==0.18.0 mflux-generate-z-image-turbo …`
 * generated a PNG end-to-end. mflux pulls mlx + its Metal wheels transitively.
 * [measured]
 */
export const MFLUX_PIN = '0.18.0';

/**
 * Pin passed to `uv --with mlx-audio==<pin>` for the TTS worker path. Correction
 * #5: 0.4.5 is the release that actually ships Qwen3-TTS / MOSS / Voxtral (and
 * worker.py's header documents 0.4.5). GitHub release [200]. [measured header]
 */
export const MLX_AUDIO_PIN = '0.4.5';

/** uv-provisioned CPython version for the worker (matches web-tools/mlx). */
export const DEFAULT_PYTHON_VERSION = '3.12';

/**
 * The design models (Ming-Image-0.1-Design) run on mlx-vlm at the commit that
 * merged Ming support (Blaizzy/mlx-vlm#2334, 2026-09-23). No PyPI release has
 * it yet: 0.7.2 predates it, and a bare `mlx-vlm` would resolve that, import
 * fine, and fail at the first picture. So the app ships a wheel built from
 * this commit's source archive plus four patches (python/mlx-vlm-ming/) and
 * never asks PyPI for mlx-vlm.
 */
export const MLX_VLM_COMMIT = '7b3397a621533fbebe31be0d9ac05441f2e7d845';

/**
 * The wheel `python/mlx-vlm-ming/build-wheel.sh` builds from
 * {@link MLX_VLM_COMMIT} plus the patches. It sits in `wheels/` beside
 * worker.py; see {@link bundledMlxVlmWheel}.
 */
export const MLX_VLM_WHEEL = 'mlx_vlm-0.7.3.dev0+bobble.ming-py3-none-any.whl';

/**
 * The design env resolves as PyPI stood at this instant (`uv --exclude-newer`).
 * python/mlx-vlm-ming/README.md records that resolution: 53 packages, every
 * one a wheel, 158 MB, 0 source builds. mlx-vlm's floors are days old
 * (transformers>=5.14, mlx>=0.32.2), so an open resolve would hand each user
 * whatever shipped that morning, untested. Frozen, every Mac gets the env
 * that was measured. Bump it together with the wheel.
 */
export const MLX_VLM_RESOLVED_BEFORE = '2026-09-24T00:00:00Z';

/** The bundled mlx-vlm wheel beside a given worker.py (checkout or packaged app). */
export function bundledMlxVlmWheel(workerScript: string): string {
  return bundledWheelPath(workerScript, MLX_VLM_WHEEL);
}

/** An optional path option, with `''` meaning "not given", as for `mfluxWith`. */
function given(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * uv flags a backend's env needs besides its `--with` packages; they go
 * before the packages, in the job and the env warm alike, so both resolve the
 * same env. The design env is frozen ({@link MLX_VLM_RESOLVED_BEFORE}) and
 * never builds from source: with `--no-build`, a resolve that would need a
 * compiler fails with uv's message instead of reaching for one. On a Mac
 * without the Command Line Tools, reaching for one means the install dialog,
 * mid-job. Every other backend gets none, so its argv is unchanged.
 */
export function backendUvFlags(backend: Backend): readonly string[] {
  return backend === 'mlx-vlm' ? ['--no-build', '--exclude-newer', MLX_VLM_RESOLVED_BEFORE] : [];
}

/**
 * The base `uv --with` package(s) a backend's `worker.py` modality dispatch
 * needs, BEFORE any entry-specific {@link WorkerUvArgsOptions.extraWith}. This is
 * the fix for the old hardcoded `--with mflux`: a TTS or 3D job must NOT drag in
 * mflux. Only the process-per-job uv-worker backends appear here — `comfyui`
 * (persistent aiohttp server) and `hyperframes` (Node+ffmpeg) do NOT go through
 * this argv builder, so they resolve to no base package.
 *
 * 3D deps (`triposr` / `trellis`) are forward-dated: the exact package set is
 * finalised when the Phase-D 3D worker lands. [projected]
 *
 * `mlx-vlm` needs `mlxVlmWith`, the absolute path of the bundled wheel
 * ({@link bundledMlxVlmWheel}). It throws without one rather than guess: the
 * wheel sits beside the worker.py being launched, and inside the bundled
 * Electron main the package's own path resolves to a folder that does not
 * exist (gen-manager's note on `resolveWorkerScript`). The argv builders
 * below pass it from their worker script.
 */
export function baseWorkerWith(
  backend: Backend,
  mfluxPin: string = MFLUX_PIN,
  mfluxWith?: string,
  mlxVlmWith?: string,
): readonly string[] {
  switch (backend) {
    case 'mflux':
      // A model that names its own mflux build (a bundled wheel — the Qwen-Image
      // 2.1 port, see catalog MfluxBackendConfig.wheel) replaces the pin.
      return [mfluxWith !== undefined && mfluxWith.length > 0 ? mfluxWith : `mflux==${mfluxPin}`];
    case 'mlx-vlm': {
      // The design models (Ming-Image): always the bundled wheel, never PyPI.
      const wheel = given(mlxVlmWith);
      if (wheel === undefined) {
        throw new Error(
          `the mlx-vlm env runs on the bundled wheel ${MLX_VLM_WHEEL}: pass its path ` +
            '(bundledMlxVlmWheel(workerScript)) or the worker script',
        );
      }
      return [wheel];
    }
    case 'mlx-audio':
      return [`mlx-audio==${MLX_AUDIO_PIN}`];
    case 'torch-tts':
      // Chatterbox (ResembleAI) — torch/MPS→CPU TTS, NOT the mlx-audio CLI; Perth
      // watermark on all output. Reserved until the torch-tts path lands. [projected]
      return ['chatterbox-tts'];
    case 'triposr':
      // TripoSR one-shot LRM; MPS-fallback torch stack. Correction #4: transformers
      // PINNED to 4.35.0 (newer transformers break TripoSR's LRM load) +
      // PYTORCH_ENABLE_MPS_FALLBACK=1 at spawn. [projected deps]
      return ['torch', 'torchvision', 'transformers==4.35.0'];
    case 'trellis':
      // trellis2-mlx persistent MLX worker (NOT ComfyUI). [fwd slug + projected]
      return ['mlx', 'trellis2-mlx'];
    case 'comfyui':
    case 'hyperframes':
      // Not driven by the uv worker — persistent server / Node path.
      return [];
  }
}

/**
 * The argv that WARMS a backend's environment and nothing else: the same
 * `uv run --with …` prefix the worker gets, running a one-line python instead
 * of worker.py. uv resolves and downloads every package before that line runs,
 * so this is the multi-gigabyte first-run download, done on purpose, with its
 * progress on screen (see the app's gen-modules) instead of inside somebody's
 * first picture. Pure.
 */
export function buildEnvWarmArgs(opts: {
  backend: Backend;
  mfluxPin?: string;
  /** The mflux requirement in place of the pin (a bundled wheel's path). */
  mfluxWith?: string;
  /** The mlx-vlm wheel's absolute path; defaults to the one beside `workerScript`. */
  mlxVlmWith?: string;
  /**
   * The worker.py the jobs will launch. The design env's wheel sits beside it,
   * so pass the same path the jobs get; then warm and job resolve one env.
   */
  workerScript?: string;
  python?: string;
  extraWith?: readonly string[];
}): string[] {
  const args = [
    'run',
    '--no-project',
    '--python',
    opts.python ?? DEFAULT_PYTHON_VERSION,
    ...backendUvFlags(opts.backend),
  ];
  const workerScript = given(opts.workerScript);
  const mlxVlmWith =
    given(opts.mlxVlmWith) ??
    (workerScript !== undefined ? bundledMlxVlmWheel(workerScript) : undefined);
  for (const dep of baseWorkerWith(opts.backend, opts.mfluxPin, opts.mfluxWith, mlxVlmWith))
    args.push('--with', dep);
  for (const dep of opts.extraWith ?? []) args.push('--with', dep);
  args.push('python', '-c', "print('module ready')");
  return args;
}

/** Env var an embedder can set to point at an explicit worker.py (packaged app). */
export const GEN_WORKER_PATH_ENV = 'PI_GEN_WORKER_PATH';

/** Absolute path to this package root (…/packages/gen-service), derived from src/. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/packages/gen-service/src
  return path.resolve(here, '..');
}

/**
 * Resolve the bundled worker script path, in priority order:
 *   1. an explicit override (packaged app passes the extraResources path),
 *   2. `PI_GEN_WORKER_PATH`,
 *   3. this package's `python/worker.py`.
 */
export function resolveWorkerScript(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const fromEnv = process.env[GEN_WORKER_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(packageRoot(), 'python', 'worker.py');
}

/**
 * Where a bundled mflux wheel sits: `wheels/<name>` beside worker.py, in the
 * checkout (packages/gen-service/python) and in the packaged app
 * (<Resources>/gen-worker) alike, since the whole python/ folder ships.
 */
export function bundledWheelPath(workerScript: string, wheel: string): string {
  return path.join(path.dirname(workerScript), 'wheels', wheel);
}

export interface WorkerUvArgsOptions {
  /** Absolute path to worker.py (from {@link resolveWorkerScript}). */
  readonly workerScript: string;
  /**
   * The job's backend — selects the base `uv --with` package(s) via
   * {@link baseWorkerWith}. Defaults to `mflux` (image), preserving the phase-1
   * behaviour. A TTS job passes `mlx-audio`, a 3D job `triposr`/`trellis`; none
   * of them force mflux.
   */
  readonly backend?: Backend;
  /** mflux version pin (default {@link MFLUX_PIN}); applies to the mflux base. */
  readonly mfluxPin?: string;
  /**
   * The mflux requirement to use INSTEAD of the pin — the absolute path of a
   * wheel shipped beside worker.py (catalog `mflux.wheel`, resolved by the
   * app). uv takes a path where it takes `name==version`.
   */
  readonly mfluxWith?: string;
  /**
   * The mlx-vlm wheel's absolute path, for an `mlx-vlm` job. Defaults to the
   * bundled wheel beside {@link workerScript}, which is where it ships.
   */
  readonly mlxVlmWith?: string;
  /** uv-provisioned Python version (default {@link DEFAULT_PYTHON_VERSION}). */
  readonly python?: string;
  /**
   * Extra `uv --with` deps ADDED ON TOP of the backend's base package(s) (e.g. a
   * codec). Additive only — it never changes which base backend package is used.
   */
  readonly extraWith?: readonly string[];
  /**
   * Launch the worker in persistent `--serve` stdin-loop mode instead of the
   * default one-job-per-process mode. This is the TRELLIS.2 3D path: its ~15GB
   * weights must load ONCE and stay resident across many assets, so a
   * persistent-worker adapter (Phase D) drives it with `serveMode:true` and
   * streams one job envelope per line. Default `false` → the existing
   * process-per-job behaviour (image/TTS), byte-for-byte unchanged.
   */
  readonly serveMode?: boolean;
}

/**
 * Build the argv for the `uv` binary that launches the worker:
 *
 *   run --no-project --python <v> [<backend flags>] --with <base…> [--with <extra> …] python <worker.py>
 *
 * The base `--with` package(s) come from the job's `backend` via
 * {@link baseWorkerWith} (mflux for image, mlx-audio for TTS, the 3D deps for
 * triposr/trellis, the bundled wheel for mlx-vlm) — NOT a hardcoded mflux. The
 * backend flags ({@link backendUvFlags}) are the design env's frozen, no-build
 * resolve; other backends have none. The job JSON is written to the worker's
 * stdin (see {@link ../client}); the worker streams
 * {@link ../protocol!GenEvent}s back on stdout. Pure.
 */
export function buildWorkerUvArgs(opts: WorkerUvArgsOptions): string[] {
  const backend = opts.backend ?? 'mflux';
  const args = [
    'run',
    '--no-project',
    '--python',
    opts.python ?? DEFAULT_PYTHON_VERSION,
    ...backendUvFlags(backend),
  ];
  const mlxVlmWith = given(opts.mlxVlmWith) ?? bundledMlxVlmWheel(opts.workerScript);
  for (const dep of baseWorkerWith(backend, opts.mfluxPin, opts.mfluxWith, mlxVlmWith)) {
    args.push('--with', dep);
  }
  for (const dep of opts.extraWith ?? []) {
    args.push('--with', dep);
  }
  args.push('python', opts.workerScript);
  // Persistent 3D (TRELLIS.2) serve mode: worker.py loads the pipeline once and
  // reads one job envelope per stdin line until EOF / a `{"type":"shutdown"}`.
  if (opts.serveMode === true) {
    args.push('--serve');
  }
  return args;
}
