/**
 * LAUNCHING THE OTHER ENGINES — the OpenAI-compatible servers that are not
 * llama.cpp: rapid-mlx, dflash-mlx, mlx-dspark, oMLX and mlx-lm on Apple
 * Silicon, vLLM on a Linux box.
 *
 * They all speak `/v1/chat/completions` and answer `/v1/models` once loaded,
 * which is what lets one supervisor (the llama.cpp one, via its `buildArgsFn`
 * + `healthPath` seams) run any of them. What differs per engine is only the
 * command line: where the weights are named, how a drafter is attached, and
 * how a speculative method is asked for. That is this module — pure, so the
 * argv for every (engine, spec) pair is testable without a Metal device.
 *
 * The CLI shapes are the ones the installed packages print (`<tool> serve
 * --help`, 2026-09), not the README's:
 *
 *   rapid-mlx serve <model> --host --port --served-model-name <id>
 *                   [--speculative-config '{"method":"mtp",...}' | --no-spec-decode]
 *   dflash serve --model <path> --draft-model <drafter> --host --port
 *   mlx-dspark serve --model <path> --mode dspark|dflash|lookup|baseline
 *                    [--drafter <path>] --host --port
 *   omlx serve --model-dir <dir> --host --port        (models = subdirectories)
 *   mlx_lm.server --model <path> --host --port
 *   vllm serve <path> --host --port --served-model-name <id>
 *
 * Weights are LOCAL DIRECTORIES, never hub ids: every one of these would happily
 * download a repo on first launch, and calibration has to run with no network
 * at all — the user: "ensure this doesn't require internet to run the calibration".
 */
import type { CalibSpec, LaunchProfile } from './calibrate.js';

export interface EngineLaunchConfig {
  /** Absolute path of the engine's CLI (a venv `bin/…`). */
  readonly command: string;
  /** Local directory holding the MLX / safetensors weights. */
  readonly modelDir: string;
  /** What the server should call the model in `/v1/models` and requests. */
  readonly servedModelId: string;
  readonly host: string;
  readonly port: number;
  /** Local drafter directory for the drafted methods (DFlash / DSpark), or
   * the MTP head sidecar for rapid-mlx's MTP. */
  readonly draftDir?: string;
  /** oMLX: the directory whose SUBDIRECTORIES are the models it serves. */
  readonly modelRoot?: string;
  /**
   * rapid-mlx: serve the VISION lane (`--mllm`) so images can be read.
   * MEASURED 2026-09-23: that lane does not honour a speculative decoder
   * (asked for both, rapid-mlx "auto-downgraded to the text-only lane"), so a
   * vision launch carries no spec flags at all — see vision-launch.ts.
   */
  readonly vision?: boolean;
}

export interface EngineLaunch {
  readonly command: string;
  readonly args: string[];
  /** Readiness probe path — every one of these engines lists models once loaded. */
  readonly healthPath: '/v1/models';
  /** The id requests must carry (some engines echo the path they were given). */
  readonly servedModelId: string;
}

/** The engines this module knows how to start (everything but llama.cpp). */
export type ExternalEngine = Exclude<LaunchProfile['engine'], 'llamacpp'>;

function rapidSpec(spec: CalibSpec, draftDir: string | undefined): string[] {
  switch (spec) {
    case 'mtp':
      /*
       * The MTP head comes from a SIDECAR (rapid-mlx's word): mlx-community
       * conversions drop the `mtp.*` tensors from the trunk and publish them
       * separately (`Qwen3.5-4B-MTP-bf16`, ~240 MB). `model` names that
       * directory; without it rapid-mlx looks in the trunk and, for a twin
       * that kept its heads, finds them there.
       */
      return [
        '--speculative-config',
        JSON.stringify(
          draftDir === undefined
            ? { method: 'mtp', num_speculative_tokens: 3 }
            : { method: 'mtp', num_speculative_tokens: 3, model: draftDir },
        ),
      ];
    case 'dflash':
      return [
        '--speculative-config',
        JSON.stringify(
          draftDir === undefined ? { method: 'dflash' } : { method: 'dflash', model: draftDir },
        ),
      ];
    case 'auto':
      return [];
    default:
      // Plain decoding is the point of the row; the engine's auto-detection
      // would otherwise switch MTP on for a model that carries the heads.
      return ['--no-spec-decode'];
  }
}

function dsparkMode(spec: CalibSpec): 'auto' | 'dspark' | 'dflash' | 'lookup' | 'baseline' {
  switch (spec) {
    case 'dspark':
      return 'dspark';
    case 'dflash':
      return 'dflash';
    case 'ngram':
      return 'lookup';
    case 'auto':
      return 'auto';
    default:
      return 'baseline';
  }
}

/**
 * The command line for one (engine, spec) on one model. Throws for a pairing
 * the engine cannot do (a drafted method with no drafter on disk), so a launch
 * that would fail late fails here with a reason instead.
 */
export function assembleEngineLaunch(
  profile: LaunchProfile,
  cfg: EngineLaunchConfig,
): EngineLaunch {
  const hostPort = ['--host', cfg.host, '--port', String(cfg.port)];
  const needsDraft = (): string => {
    if (cfg.draftDir === undefined) {
      throw new Error(`${profile.engine}/${profile.spec} needs a drafter on disk`);
    }
    return cfg.draftDir;
  };
  switch (profile.engine) {
    case 'rapid-mlx':
      return {
        command: cfg.command,
        args: [
          'serve',
          cfg.modelDir,
          ...hostPort,
          '--served-model-name',
          cfg.servedModelId,
          ...(cfg.vision === true
            ? ['--mllm']
            : rapidSpec(profile.spec, profile.spec === 'dflash' ? needsDraft() : cfg.draftDir)),
        ],
        healthPath: '/v1/models',
        servedModelId: cfg.servedModelId,
      };
    case 'dflash-mlx':
      return {
        command: cfg.command,
        args: ['serve', '--model', cfg.modelDir, '--draft-model', needsDraft(), ...hostPort],
        healthPath: '/v1/models',
        // dflash answers with the path it was given.
        servedModelId: cfg.modelDir,
      };
    case 'mlx-dspark': {
      const mode = dsparkMode(profile.spec);
      const draft = mode === 'dspark' || mode === 'dflash' ? ['--drafter', needsDraft()] : [];
      return {
        command: cfg.command,
        args: ['serve', '--model', cfg.modelDir, '--mode', mode, ...draft, ...hostPort],
        healthPath: '/v1/models',
        servedModelId: cfg.modelDir,
      };
    }
    case 'omlx': {
      if (cfg.modelRoot === undefined) throw new Error('omlx needs a model root directory');
      return {
        command: cfg.command,
        args: ['serve', '--model-dir', cfg.modelRoot, ...hostPort],
        healthPath: '/v1/models',
        // oMLX names each model after its subdirectory.
        servedModelId: cfg.servedModelId,
      };
    }
    case 'mlx-lm':
      return {
        command: cfg.command,
        args: ['--model', cfg.modelDir, ...hostPort],
        healthPath: '/v1/models',
        servedModelId: cfg.modelDir,
      };
    case 'vllm':
      return {
        command: cfg.command,
        args: ['serve', cfg.modelDir, ...hostPort, '--served-model-name', cfg.servedModelId],
        healthPath: '/v1/models',
        servedModelId: cfg.servedModelId,
      };
    default:
      throw new Error(`no launcher for engine ${String(profile.engine)}`);
  }
}

/**
 * Environment for an engine's Python start-up patch, when Bobble has one.
 *
 * rapid-mlx: its thinking cap force-closes the thought with no words, and skips
 * tool turns while its tool grammar is off (as Bobble runs it). The patch at
 * `<patchesDir>/rapid-mlx/sitecustomize.py` makes the cap end with the message
 * and apply to tool turns; Python imports it at start-up from PYTHONPATH.
 * Every other engine: nothing.
 */
export function enginePatchEnv(
  engine: LaunchProfile['engine'],
  patchesDir: string | undefined,
  message: string,
  existingPythonPath?: string,
): Record<string, string> {
  if (engine !== 'rapid-mlx' || patchesDir === undefined || patchesDir.length === 0) return {};
  const dir = `${patchesDir.replace(/\/$/, '')}/rapid-mlx`;
  const rest =
    existingPythonPath !== undefined && existingPythonPath.length > 0
      ? `:${existingPythonPath}`
      : '';
  return { PYTHONPATH: `${dir}${rest}`, BOBBLE_THINK_END_MESSAGE: message };
}
