/**
 * VISION DECIDES THE LAUNCH — which engine actually starts when the model has
 * to be able to read an image.
 *
 * The user (2026-09-23): "mmproj/vision should always be loaded and usable by
 * default unless explicitly turned off … however it should always be on unless
 * the user says to turn it off." And the note their runs kept getting — "this
 * model is currently running in TEXT-ONLY mode, so images cannot be read" — was
 * true: the calibrated engine was rapid-mlx with MTP, and MEASURED on this Mac
 * rapid-mlx serves a speculative decoder only on its TEXT lane ("auto-downgraded
 * to the text-only lane because the requested speculative decoder is not
 * honored by its vision lane"), answering an image with HTTP 400
 * `image_input_unsupported`. Every other MLX engine here is text-only outright.
 *
 * So the calibrated or chosen profile is only a wish; this is where it meets
 * the setting. Pure, so every combination is a test rather than a launch.
 */
import type { CalibEngine, CalibSpec, LaunchProfile } from './calibrate.js';

/** Why a running server cannot read an image — said to the model in those words. */
export type BlindReason =
  /** The user switched vision off (Settings → Engines → Vision). */
  | 'off'
  /** The model has no vision at all: no projector, no vision tower. */
  | 'model'
  /** The engine it runs on is text-only, and nothing that sees could take it. */
  | 'engine'
  /** The projector exists but could not be fetched or attached. */
  | 'projector';

export interface VisionEngineInput {
  /** The profile calibration chose, the user picked, or the default. */
  readonly profile: LaunchProfile;
  /** The setting (default on) — or an explicit multimodal launch. */
  readonly visionWanted: boolean;
  /** The user clicked this exact engine row: honour it, and say if it is blind. */
  readonly explicit: boolean;
  /** The catalogue gives this model a projector (llama.cpp can see with it). */
  readonly modelHasProjector: boolean;
  /** The model's GGUF is on disk, so llama.cpp can take the launch. */
  readonly ggufOnDisk: boolean;
  /** Its MLX weights carry a vision tower (rapid-mlx's vision lane can use them). */
  readonly mlxTwinHasVision: boolean;
  /** rapid-mlx's vision runtime (its own venv: mlx-vlm 0.6.17 + torch) is installed. */
  readonly rapidVisionReady: boolean;
}

export interface VisionEnginePlan {
  /** What actually launches. */
  readonly profile: LaunchProfile;
  /**
   * How it sees: `projector` = llama.cpp `--mmproj`; `lane` = rapid-mlx
   * `--mllm`; `none` = it cannot.
   */
  readonly vision: 'projector' | 'lane' | 'none';
  /** Set when `vision` is `none`. */
  readonly blindReason?: BlindReason;
  /** Set when vision moved the launch off the engine that was chosen. */
  readonly fallback?: { readonly from: CalibEngine; readonly why: string };
}

/** The llama.cpp method a model gets on a fallback: its head if it has one. */
function llamaSpecFor(profile: LaunchProfile, fallbackSpec: CalibSpec): CalibSpec {
  /* The chosen method carries over when llama.cpp can run it (a calibrated
     `mtp` stays `mtp`); an MLX-only method does not exist there. */
  return profile.spec === 'mtp' || profile.spec === 'none' || profile.spec === 'eagle3'
    ? profile.spec
    : fallbackSpec;
}

export function planVisionEngine(
  input: VisionEngineInput,
  /** The spec llama.cpp uses for this model when nothing else says (its default). */
  llamaDefaultSpec: CalibSpec = 'none',
): VisionEnginePlan {
  const { profile } = input;
  const modelCanSee = input.modelHasProjector || input.mlxTwinHasVision;

  if (!input.visionWanted) {
    return { profile, vision: 'none', blindReason: modelCanSee ? 'off' : 'model' };
  }
  if (!modelCanSee) return { profile, vision: 'none', blindReason: 'model' };

  if (profile.engine === 'llamacpp') {
    return input.modelHasProjector
      ? { profile, vision: 'projector' }
      : { profile, vision: 'none', blindReason: 'model' };
  }

  /* RAPID-MLX SEES on its vision lane — without a speculative decoder, which
     that lane does not honour, and only from its own runtime. A row that names
     a decoder (a calibration step, a row the user clicked) is not moved onto
     the lane: rewritten to `none`, calibration's MTP and DFlash rows re-measured
     the lane already running, and a clicked MTP row ran without MTP. It keeps
     its method and is blind, below. */
  if (
    profile.engine === 'rapid-mlx' &&
    input.mlxTwinHasVision &&
    input.rapidVisionReady &&
    (profile.spec === 'none' || !input.explicit)
  ) {
    return { profile: { engine: 'rapid-mlx', spec: 'none' }, vision: 'lane' };
  }

  const why =
    profile.engine === 'rapid-mlx'
      ? input.mlxTwinHasVision
        ? 'rapid-mlx sees only through its vision runtime, which is not installed'
        : "this model's MLX weights have no vision tower"
      : `${profile.engine} is text-only`;

  /* A clicked row is honoured as clicked; it just cannot see. */
  if (input.explicit) return { profile, vision: 'none', blindReason: 'engine' };

  /* Otherwise the launch goes to the engine that CAN see — llama.cpp with the
     projector — when the model is there to run on it. */
  if (input.ggufOnDisk && input.modelHasProjector) {
    return {
      profile: { engine: 'llamacpp', spec: llamaSpecFor(profile, llamaDefaultSpec) },
      vision: 'projector',
      fallback: { from: profile.engine, why },
    };
  }
  return { profile, vision: 'none', blindReason: 'engine' };
}

/**
 * Does an MLX checkpoint carry a vision tower? The same evidence rapid-mlx's
 * own lane router reads (vllm_mlx `is_mllm_model`): a `vision_config` in the
 * config AND vision tensors in the weights — a config alone is a text-only fork
 * of a multimodal architecture (its #393), and routing that to the vision lane
 * crashes on the missing tower.
 */
export function mlxWeightsHaveVision(
  config: { readonly vision_config?: unknown } | null,
  tensorNames: readonly string[],
): boolean {
  if (config === null || config.vision_config === undefined || config.vision_config === null) {
    return false;
  }
  return tensorNames.some(
    (n) =>
      n.startsWith('vision_tower.') ||
      n.startsWith('visual.') ||
      n.includes('.visual.') ||
      n.startsWith('vision_model.') ||
      n.includes('mm_projector') ||
      n.startsWith('multi_modal_projector.'),
  );
}

/** The one line a model reads in place of an image it cannot see. */
export function blindNote(reason: BlindReason | undefined): string {
  const lead = '[An image was attached here, but it could not be shown to you: ';
  const tail =
    ' Retrying will not help — the next capture will be just as invisible. Do NOT loop. ' +
    'Carry on without looking, and if seeing it matters, say so to the user plainly.]';
  switch (reason) {
    case 'off':
      return `${lead}vision is switched off for this model (the user can turn it on in the engine menu → Vision).${tail}`;
    case 'model':
      return `${lead}this model has no vision — it cannot read images at all.${tail}`;
    case 'engine':
      return `${lead}the engine this model is running on is text-only (the user can switch engines in the engine menu).${tail}`;
    case 'projector':
      return `${lead}this model's vision projector could not be loaded.${tail}`;
    default:
      return `${lead}the model server cannot read images right now.${tail}`;
  }
}
