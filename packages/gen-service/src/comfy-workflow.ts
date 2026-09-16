/**
 * ComfyUI workflow-JSON template registry + fill (round-13 synthesis §2/§5 Phase
 * A). ComfyUI's `/prompt` endpoint takes an **API-format** graph — a flat map of
 * `nodeId → { class_type, inputs }`. Each generation modality (LTX video,
 * ACE-Step music, FLUX-GGUF advanced image) ships as ONE parameterized template
 * here: a static graph whose per-job values (`prompt` / `width` / `steps` /
 * `seed` / …) are spliced in at run time from a {@link ComfyJobSpec}.
 *
 * The splice addresses are the template's `paramMap` — the SAME node-input paths
 * the catalog's {@link ../catalog!ModalityModel.comfy} config carries (e.g.
 * `prompt` → `"6.inputs.text"`). The registry is the runtime source of truth for
 * those paths (a {@link ComfyJobSpec} deliberately does NOT carry the map — it
 * stays catalog-free so a remote ComfyUI needs no TS catalog); a co-located test
 * cross-checks that every registry `paramMap` matches its catalog entry so the
 * two can't drift.
 *
 * NOTE (honesty): the node ids / class_types / connections below are the plan's
 * `[fwd]` placeholders — structurally valid API-format graphs finalised against
 * the real published graphs at build time. What is load-bearing NOW and tested
 * is the FILL mechanism (path-splice + per-candidate seed) and the paramMap ↔
 * catalog consistency, not the exact denoise wiring.
 */
import type { ComfyJobSpec } from './protocol.js';

/** One node in a ComfyUI API-format graph. */
export interface ComfyNode {
  readonly class_type: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly _meta?: { readonly title?: string };
}

/** A ComfyUI API-format graph: `nodeId → node`. This is exactly what `/prompt` takes. */
export type ComfyGraph = Readonly<Record<string, ComfyNode>>;

/** A parameterized workflow template: a base graph + where each catalog param splices in. */
export interface WorkflowTemplate {
  /** Template id (matches a catalog entry's `comfy.workflowTemplate`). */
  readonly id: string;
  /** API-format base graph with placeholder default values. */
  readonly graph: ComfyGraph;
  /** catalog param name → dotted node-input path, or several (mirrors the
   * catalog `comfy.paramMap`). */
  readonly paramMap: Readonly<Record<string, string | readonly string[]>>;
}

// ── graph builders (one per modality family) ────────────────────────────────
// Kept as small factories so the three LTX variants share one graph shape and
// the file stays readable. Connections are `[nodeId, outputSlot]` refs, ComfyUI's
// API-format wire encoding.

/** LTX-Video (image/text → video). Shared by the 2B-distilled / default / 22B rows. */
function ltxVideoGraph(): ComfyGraph {
  return {
    '38': { class_type: 'CLIPLoader', inputs: { clip_name: 't5xxl.safetensors', type: 'ltxv' } },
    '44': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'ltxv-distilled-q4_k_m.gguf' } },
    '45': { class_type: 'VAELoader', inputs: { vae_name: 'ltxv-vae.safetensors' } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Positive prompt' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Negative prompt' },
    },
    '70': {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: 512, height: 512, length: 97, batch_size: 1 },
    },
    '72': {
      class_type: 'LTXVScheduler',
      inputs: { steps: 8, max_shift: 2.05, base_shift: 0.95, stretch: true, latent: ['70', 0] },
    },
    '73': {
      class_type: 'KSamplerSelect',
      inputs: {
        noise_seed: 0,
        sampler_name: 'euler', // Euler: uni_pc diverges → rainbow noise on MPS [measured]
        model: ['44', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['70', 0],
        sigmas: ['72', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['73', 0], vae: ['45', 0] } },
    '9': {
      class_type: 'SaveVideo',
      inputs: { images: ['8', 0], filename_prefix: 'pi-video', format: 'mp4', fps: 24 },
    },
  };
}

const LTX_PARAM_MAP = {
  prompt: '6.inputs.text',
  negativePrompt: '7.inputs.text',
  width: '70.inputs.width',
  height: '70.inputs.height',
  length: '70.inputs.length',
  steps: '72.inputs.steps',
  seed: '73.inputs.noise_seed',
} as const;

/**
 * Wan2.1 T2V (text → video) via native ComfyUI nodes. Shares the LTX node-id
 * skeleton (positive/negative encode, empty latent video, scheduler, sampler,
 * VAE decode, save) so the SAME `LTX_PARAM_MAP` binds it and the fill mechanism
 * is what's tested; exact Wan class_types / connections are `[fwd]` placeholders.
 */
function wanVideoGraph(): ComfyGraph {
  return {
    /*
     * MEASURED, not planned. This graph was run against ComfyUI 0.33.0 on this
     * Mac and produced a 2.06s 416x416 clip in 178s; the placeholder it replaces
     * could not have run at all. Three things it got wrong, all load-bearing:
     *
     *  - it fed `sigmas` and `noise_seed` to `KSampler`, which takes neither
     *    (its required inputs are model/seed/steps/cfg/sampler_name/scheduler/
     *    positive/negative/latent_image/denoise). A scheduler + sigmas belongs
     *    to SamplerCustom; KSampler carries its own scheduler by name;
     *  - it asked for `umt5_xxl_fp8_e4m3fn`, and fp8 casts are refused on MPS
     *    (see the ComfyUI-on-MPS note) — fp16 is the only thing that loads here;
     *  - `SaveVideo` takes a VIDEO, not IMAGE: the frames go through
     *    `CreateVideo` (which is where fps lives) first.
     */
    /*
     * THE TEXT ENCODER IS THE MEMORY PROBLEM, so it is the one that is quantised.
     *
     * Wan's umt5-xxl is 11GB at fp16 and 6.7GB at fp8 — and fp8 is refused on
     * MPS, so fp16 was the only safetensors option. MEASURED on a 24GB M5 Pro:
     * with the 11GB encoder resident beside Electron and the sampler, the
     * machine pages (ComfyUI sat in uninterruptible wait) and a 48-frame clip
     * took over 45 minutes. The Q5_K_M GGUF is 4.1GB for the same encoder, and
     * the same job runs in 8.7 minutes at a LARGER size (512x512, 49 frames).
     *
     * The encoder runs once per job and is then freed, so quantising it costs
     * almost nothing in quality and buys the sampler 7GB of headroom.
     */
    '38': {
      class_type: 'CLIPLoaderGGUF',
      inputs: { clip_name: 'umt5-xxl-encoder-Q5_K_M.gguf', type: 'wan' },
    },
    '44': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'wan2.1_t2v_1.3B_fp16.safetensors', weight_dtype: 'default' },
    },
    '45': { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Positive prompt' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Negative prompt' },
    },
    '70': {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: { width: 512, height: 512, length: 49, batch_size: 1 },
    },
    '73': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 20,
        cfg: 6,
        // Euler: uni_pc diverges into rainbow noise on MPS [measured].
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['44', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['70', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['73', 0], vae: ['45', 0] } },
    '80': { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: 16 } },
    '9': {
      class_type: 'SaveVideo',
      inputs: { video: ['80', 0], filename_prefix: 'pi-video', format: 'mp4', codec: 'h264' },
    },
  };
}

/** Wan's own splice points. It does NOT share LTX's map: LTX puts steps on its
 * scheduler node and calls the seed `noise_seed`; Wan's KSampler owns both. */
const WAN_PARAM_MAP = {
  prompt: '6.inputs.text',
  negativePrompt: '7.inputs.text',
  width: '70.inputs.width',
  height: '70.inputs.height',
  length: '70.inputs.length',
  steps: '73.inputs.steps',
  seed: '73.inputs.seed',
} as const;

/**
 * LTX-2.5 (text → video WITH audio), the local two-tower cascade's first stage.
 *
 * MEASURED on this M5 Pro 24GB against ComfyUI 0.33.0: 640x352, 49 frames (2s at
 * 24fps), 8 steps, 326s wall, and the clip carries a real 48kHz audio track.
 *
 * WHAT IS DIFFERENT ABOUT THIS MODEL, and why the graph looks unlike the others:
 *
 *  - it is JOINT audio-video. The sampler runs on one latent that is the video
 *    and audio latents concatenated (`LTXVConcatAVLatent`), and they are pulled
 *    apart again (`LTXVSeparateAVLatent`) for two different decoders. The audio
 *    VAE is not optional scenery: the latent has the wrong shape without it.
 *  - guidance is `LTXVDualCFGGuider`, which carries SEPARATE cfg scales for the
 *    video and audio halves. The distilled checkpoint wants 1.0/1.0 — it is
 *    already guidance-distilled, and raising either burns the picture.
 *  - conditioning goes through `LTXVConditioning`, which stamps the frame rate
 *    onto both prompts; the model is trained to read it.
 *
 * Upstream's own template runs this stage at half resolution and then adds a
 * second pass through a latent upscaler. That second stage is a quality step,
 * not a correctness one, and it needs another model on disk — so this template
 * is stage one at full size, which is the part that must work first.
 *
 * THE TEXT ENCODER IS NOT A GGUF here, unlike Wan's. LTX-2.5's Gemma-4-12B has a
 * projection head, and the only GGUF conversion of it is behind a gate; the
 * int8+convrot safetensors release is ungated and, on a machine with no CUDA,
 * takes ComfyUI's eager quantised path, which is plain torch and runs on MPS.
 */
function ltx25Graph(): ComfyGraph {
  return {
    '38': {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
        type: 'ltxv',
      },
    },
    '44': {
      class_type: 'UnetLoaderGGUF',
      inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-bf16-Q2_K.gguf' },
    },
    '45': { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
    '46': { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Positive prompt' },
    },
    /*
     * NO SECOND ENCODE. The distilled model runs at video_cfg 1 / audio_cfg 1,
     * where the guider never evaluates the negative tower — and a
     * `CLIPTextEncode` of the empty string still costs a full pass through the
     * 12B encoder: MEASURED 35s of a 195s job (ComfyUI 0.35, M5 Pro 24GB).
     * Zeroing the positive gives `LTXVConditioning` the negative it needs for
     * free, and frame 24 of the same seed is bit-identical (mean abs diff 0.0).
     * So this template binds no `negativePrompt`; video-dispatch does not send
     * one to a graph that has nowhere to put it.
     */
    '7': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
    '60': {
      class_type: 'LTXVConditioning',
      inputs: { positive: ['6', 0], negative: ['7', 0], frame_rate: 24 },
    },
    '70': {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: 640, height: 352, length: 49, batch_size: 1 },
    },
    '71': {
      class_type: 'LTXVEmptyLatentAudio',
      inputs: { frames_number: 49, frame_rate: 24, batch_size: 1, audio_vae: ['46', 0] },
    },
    '72': {
      class_type: 'LTXVConcatAVLatent',
      inputs: { video_latent: ['70', 0], audio_latent: ['71', 0] },
    },
    '73': {
      // LTX's own scheduler rather than upstream's hardcoded sigma list, because
      // a `ManualSigmas` string is not a step count and the studio's steps
      // control has to reach something. MEASURED side by side at 8 steps: this
      // is if anything the sharper of the two. The latent is what makes its
      // shift resolution-aware, so it is wired, not left to a default.
      class_type: 'LTXVScheduler',
      inputs: {
        steps: 8,
        max_shift: 2.05,
        base_shift: 0.95,
        stretch: true,
        terminal: 0.1,
        latent: ['72', 0],
      },
    },
    '74': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    '75': { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
    '76': {
      class_type: 'LTXVDualCFGGuider',
      inputs: {
        model: ['44', 0],
        positive: ['60', 0],
        negative: ['60', 1],
        video_cfg: 1,
        audio_cfg: 1,
      },
    },
    '77': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['75', 0],
        guider: ['76', 0],
        sampler: ['74', 0],
        sigmas: ['73', 0],
        latent_image: ['72', 0],
      },
    },
    '78': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['77', 0] } },
    '8': {
      class_type: 'VAEDecodeTiled',
      inputs: {
        samples: ['78', 0],
        vae: ['45', 0],
        tile_size: 512,
        overlap: 64,
        temporal_size: 64,
        temporal_overlap: 8,
      },
    },
    '79': {
      class_type: 'LTXVAudioVAEDecode',
      inputs: { samples: ['78', 1], audio_vae: ['46', 0] },
    },
    '80': {
      class_type: 'CreateVideo',
      inputs: { images: ['8', 0], fps: 24, audio: ['79', 0] },
    },
    '9': {
      class_type: 'SaveVideo',
      inputs: { video: ['80', 0], filename_prefix: 'pi-video', format: 'auto', codec: 'auto' },
    },
  };
}

/** LTX-2.5's splice points. The frame count has to reach BOTH halves of the
 * joint latent — a video latent longer than its audio latent will not concat. */
const LTX_25_PARAM_MAP = {
  prompt: '6.inputs.text',
  width: '70.inputs.width',
  height: '70.inputs.height',
  // Both halves of the joint latent, or `LTXVConcatAVLatent` gets a 49-frame
  // video and a 49-frame audio track that no longer agree.
  length: ['70.inputs.length', '71.inputs.frames_number'],
  steps: '73.inputs.steps',
  seed: '75.inputs.noise_seed',
} as const;

/**
 * MiniMax H3 (text → video), pruned FL2VA at Q3_K_M.
 *
 * MEASURED on this M5 Pro 24GB: 608x352, 5 frames, 6 steps, 192s wall, and the
 * frames are a coherent scene rather than the usual quantisation soup.
 *
 * TWO things about H3 shape this graph:
 *
 *  - there is NO negative prompt. `MiniMaxH3ImageToVideo` emits a single
 *    CONDITIONING and upstream drives it with `BasicGuider`, which takes one.
 *    The model is guidance-distilled; a second tower would cost a full pass
 *    through a 32B text encoder to be multiplied by zero.
 *  - `MiniMaxH3ImageToVideo` is the text-to-video node too: `first_frame` is
 *    optional, and omitting it is how you ask for a clip from nothing. It emits
 *    the conditioning AND the correctly-shaped empty latent together, which is
 *    why the size lives on that node instead of an `Empty*` one.
 *
 * The text encoder is Qwen3-VL-32B truncated to 50 layers. The GGUF conversion
 * carries all 64 of the original's layers and no vision tower, and both facts
 * are fine: ComfyUI builds the 50 it wants and ignores the rest, and text-only
 * generation never touches the vision half. Recognising that file needs
 * `bobble_comfy_fixes`, installed with the engine.
 */
function minimaxH3Graph(): ComfyGraph {
  return {
    '38': {
      class_type: 'CLIPLoaderGGUF',
      inputs: { clip_name: 'MiniMax-H3-encoder-Q4_K_M.gguf', type: 'minimax' },
    },
    '44': {
      class_type: 'UnetLoaderGGUF',
      inputs: { unet_name: 'MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf' },
    },
    '45': {
      class_type: 'VAELoader',
      inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' },
    },
    '6': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['38', 0],
        vae: ['45', 0],
        prompt: '',
        width: 608,
        height: 352,
        length: 5,
      },
      _meta: { title: 'Prompt + empty AV latent' },
    },
    '73': {
      class_type: 'BasicScheduler',
      inputs: { model: ['44', 0], scheduler: 'simple', steps: 6, denoise: 1 },
    },
    '74': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '75': { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
    '76': { class_type: 'BasicGuider', inputs: { model: ['44', 0], conditioning: ['6', 0] } },
    '77': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['75', 0],
        guider: ['76', 0],
        sampler: ['74', 0],
        sigmas: ['73', 0],
        latent_image: ['6', 1],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['77', 0], vae: ['45', 0] } },
    '80': { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: 24 } },
    '9': {
      class_type: 'SaveVideo',
      inputs: { video: ['80', 0], filename_prefix: 'pi-video', format: 'auto', codec: 'auto' },
    },
  };
}

/** H3's splice points. No `negativePrompt`: the model has no second tower. */
const MINIMAX_H3_PARAM_MAP = {
  prompt: '6.inputs.prompt',
  width: '6.inputs.width',
  height: '6.inputs.height',
  length: '6.inputs.length',
  steps: '73.inputs.steps',
  seed: '75.inputs.noise_seed',
} as const;

function aceStepGraph(): ComfyGraph {
  return {
    '40': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'ace_step_v1_3.5b.safetensors' },
    },
    '14': {
      class_type: 'TextEncodeAceStepAudio',
      inputs: { tags: '', lyrics: '', lyrics_strength: 0.99, clip: ['40', 1] },
    },
    '15': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['14', 0] } },
    '17': {
      class_type: 'EmptyAceStepLatentAudio',
      inputs: { seconds: 120, batch_size: 1 },
    },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 50,
        cfg: 5,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['40', 0],
        positive: ['14', 0],
        negative: ['15', 0],
        latent_image: ['17', 0],
      },
    },
    '18': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['40', 2] } },
    '19': { class_type: 'SaveAudio', inputs: { audio: ['18', 0], filename_prefix: 'pi-music' } },
  };
}

const ACE_STEP_PARAM_MAP = {
  prompt: '14.inputs.tags',
  lyrics: '14.inputs.lyrics',
  seconds: '17.inputs.seconds',
  steps: '3.inputs.steps',
  seed: '3.inputs.seed',
} as const;

/** Stable Audio Open (text → music/SFX) via native ComfyUI core nodes. */
function stableAudioGraph(): ComfyGraph {
  return {
    '40': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'stable_audio_open_1.0.safetensors' },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['40', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['40', 1] } },
    '11': { class_type: 'EmptyLatentAudio', inputs: { seconds: 47, batch_size: 1 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 50,
        cfg: 5,
        sampler_name: 'dpmpp_3m_sde_gpu',
        scheduler: 'exponential',
        denoise: 1,
        model: ['40', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['11', 0],
      },
    },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['40', 2] } },
    '13': { class_type: 'SaveAudio', inputs: { audio: ['12', 0], filename_prefix: 'pi-audio' } },
  };
}

/**
 * Stable Audio 3 small (music / SFX) — MEASURED working on this Mac: a 6s stereo
 * 44.1kHz clip in 6 seconds, from a 2.1GB checkpoint.
 *
 * Unlike Stable Audio Open 1.0, the 3-small checkpoints carry NO text encoder:
 * `CheckpointLoaderSimple` returns a null CLIP and the first encode dies with
 * "your checkpoint does not contain a valid clip or text encoder model". The
 * t5gemma encoder is loaded separately, and the pair of conditionings must go
 * through `ConditioningStableAudio` to carry the clip length — without it the
 * model has no idea how long a sound it is making.
 */
function stableAudio3Graph(): ComfyGraph {
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'stable_audio_3_small_sfx.safetensors' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 't5gemma_b_b_ul2.safetensors', type: 'stable_audio' },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '10': {
      class_type: 'ConditioningStableAudio',
      inputs: { positive: ['6', 0], negative: ['7', 0], seconds_start: 0, seconds_total: 8 },
    },
    '5': { class_type: 'EmptyLatentAudio', inputs: { seconds: 8, batch_size: 1 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 25,
        cfg: 6,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['1', 0],
        positive: ['10', 0],
        negative: ['10', 1],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['1', 2] } },
    '9': { class_type: 'SaveAudio', inputs: { audio: ['8', 0], filename_prefix: 'pi-audio' } },
  };
}

/** Stable Audio 3's splice points. `seconds` lands in TWO places — the empty
 * latent's length and the conditioning's `seconds_total` — and they have to
 * agree or the clip is padded with silence to the latent's length. */
const STABLE_AUDIO_3_PARAM_MAP = {
  prompt: '6.inputs.text',
  negativePrompt: '7.inputs.text',
  seconds: '5.inputs.seconds',
  steps: '3.inputs.steps',
  seed: '3.inputs.seed',
} as const;

const STABLE_AUDIO_PARAM_MAP = {
  prompt: '6.inputs.text',
  negativePrompt: '7.inputs.text',
  seconds: '11.inputs.seconds',
  steps: '3.inputs.steps',
  seed: '3.inputs.seed',
} as const;

/** FLUX.1-dev GGUF Q6_K advanced image graph (beyond what mflux one-shots). */
function fluxGgufGraph(): ComfyGraph {
  return {
    '10': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '11': {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: 't5xxl_fp16.safetensors',
        clip_name2: 'clip_l.safetensors',
        type: 'flux',
      },
    },
    '12': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q6_K.gguf' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['11', 0] } },
    '26': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['6', 0] } },
    '22': { class_type: 'BasicGuider', inputs: { model: ['12', 0], conditioning: ['26', 0] } },
    '16': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '17': {
      class_type: 'BasicScheduler',
      inputs: { scheduler: 'simple', steps: 20, denoise: 1, model: ['12', 0] },
    },
    '25': { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
    '13': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['25', 0],
        guider: ['22', 0],
        sampler: ['16', 0],
        sigmas: ['17', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['10', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pi-image' } },
  };
}

/**
 * Image → 3D on ComfyUI's own nodes (0.35): TRELLIS.2 or Pixal3D, then the
 * mesh pipeline that ships beside them — no git, no Xcode, no custom wheels,
 * which is what puts a 3D model within one click on any Apple Silicon Mac.
 *
 * THE SHAPE OF IT, from the upstream template
 * (`3d_pixal3d_trellis2_image_to_model.json`), with the switches resolved:
 *
 *   BiRefNet cuts the subject out → ImageCropToMask squares it (1.0 pad for
 *   TRELLIS.2, 1.1 for Pixal3D, which also reads the camera's field of view
 *   off MoGe) → DINOv3 conditioning → a 12-step STRUCTURE sample on the
 *   int8 DiT (cfg 7.5, shift 5, guidance only from 66.7%, rescaled 0.7) →
 *   a 20-step SHAPE sample at 512³ → the shape VAE → a 12-step TEXTURE sample
 *   at cfg 1 → the texture VAE (a coloured voxel field) → decimate to
 *   300k faces → smooth normals → UV unwrap → bake base colour / metallic /
 *   roughness from the voxels, a normal map and ambient occlusion from the
 *   dense mesh → one GLB with a PBR material (SaveGLB), plus the raw
 *   vertex-painted mesh as a second file.
 *
 * WHAT IS NOT HERE, and why:
 *
 *  - the 1024/1536 UPSAMPLE stage. MEASURED on the M5 Pro 24GB: 835s for the
 *    12 upsample steps, 134s to decode, 474s to texture — half an hour before
 *    the mesh stage, against 314s for the whole 512 chain. The Bobble 3D
 *    engine (MLX, needs Xcode) does 1024 in 352s; this path is the one that
 *    needs nothing, and 512 is where it earns that.
 *
 * ON THE CPU: every mesh node after the VAEs. On MPS they die with a negative
 * scatter index (ComfyUI 0.35 / torch 2.13); `bobble_comfy_fixes/mesh_on_cpu.py`,
 * installed with the engine, answers "cpu" while one runs. int8 or bf16 DiT is
 * the same speed here (75s vs 82s for the shape stage) — the int8 is 5 GB
 * smaller, so it is the one the catalog names.
 *
 * MEASURED on the M5 Pro 24GB, mug.png at 512³: TRELLIS.2 314s (structure 31s,
 * shape 82s, decode 25s, texture 33s + 15s, decimate 38s, unwrap 6s, normal
 * bake 11s, AO 50s, voxel bake 8s); Pixal3D 260s.
 */
/**
 * How far the model is finished — the user (2026-09-15): "add a setting for
 * Grey/Color/PBR".
 *   grey   the shape only: structure → shape → remesh → decimate. No texture
 *          sampler, no unwrap, no bakes — the cheapest model, for when the
 *          form is what is wanted (MEASURED at 512³: the texture sampler and
 *          decode are ~48 s and the unwrap + three bakes another ~75 s).
 *   color  painted: the texture stage runs and its base colour is baked onto
 *          an atlas, with nothing else — no metal/roughness, no normal map, no
 *          occlusion. A coloured model that lights like clay.
 *   pbr    the full material: base colour + metallic + roughness from the
 *          voxel bake, a normal map and ambient occlusion from the high-poly.
 */
export type ModelFinish = 'grey' | 'color' | 'pbr';

function trellis2ImageTo3dGraph(
  engine: 'trellis2' | 'pixal3d',
  finish: ModelFinish = 'pbr',
): ComfyGraph {
  const cond = engine === 'trellis2' ? '299' : '298';
  const conditioning: ComfyGraph =
    engine === 'trellis2'
      ? {
          '15': {
            class_type: 'CLIPVisionLoader',
            inputs: { clip_name: 'dino_v3_vit_l.safetensors' },
          },
          '40': {
            class_type: 'UNETLoader',
            inputs: { unet_name: 'trellis_2_int8_convrot.safetensors', weight_dtype: 'default' },
          },
          '299': {
            class_type: 'Trellis2Conditioning',
            inputs: { clip_vision_model: ['15', 0], image: ['312', 0] },
          },
        }
      : {
          '15': {
            class_type: 'CLIPVisionLoader',
            inputs: { clip_name: 'dino_v3_L_naf_fp32.safetensors' },
          },
          '40': {
            class_type: 'UNETLoader',
            inputs: { unet_name: 'pixal3d_int8_convrot.safetensors', weight_dtype: 'default' },
          },
          '55': {
            class_type: 'LoadMoGeModel',
            inputs: { model_name: 'moge_2_vitl_normal_fp16.safetensors' },
          },
          '56': {
            class_type: 'MoGeInference',
            inputs: {
              moge_model: ['55', 0],
              image: ['312', 0],
              resolution_level: 9,
              fov_x_degrees: 0,
              batch_size: 4,
              force_projection: true,
              apply_mask: true,
            },
          },
          '242': {
            class_type: 'MoGeGeometryToFOV',
            inputs: { moge_geometry: ['56', 0], axis: 'horizontal', unit: 'degrees' },
          },
          '298': {
            class_type: 'Pixal3DConditioning',
            inputs: { clip_vision_model: ['15', 0], image: ['312', 0], camera_angle_x: ['242', 0] },
          },
        };
  return {
    '122': { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: 'Input picture' } },
    '193': {
      class_type: 'LoadBackgroundRemovalModel',
      inputs: { bg_removal_name: 'birefnet.safetensors' },
    },
    '192': {
      class_type: 'RemoveBackground',
      inputs: { bg_removal_model: ['193', 0], image: ['122', 0] },
    },
    '312': {
      class_type: 'ImageCropToMask',
      inputs: {
        images: ['122', 0],
        masks: ['192', 0],
        width: 1024,
        height: 1024,
        pad_factor: engine === 'trellis2' ? 1.0 : 1.1,
        grow_mask: 0,
        background: '#000000',
      },
    },
    ...conditioning,
    '117': {
      class_type: 'VAELoader',
      inputs: { vae_name: 'trellis_2_shape_vae_bf16.safetensors' },
    },
    // Structure: guidance from two thirds in, rescaled, on a shift-5 schedule.
    '199': {
      class_type: 'CFGOverride',
      inputs: { model: ['40', 0], cfg: 1, start_percent: 0.667, end_percent: 1 },
    },
    '125': { class_type: 'RescaleCFG', inputs: { model: ['199', 0], multiplier: 0.7 } },
    '108': { class_type: 'ModelSamplingSD3', inputs: { model: ['125', 0], shift: 5 } },
    '87': { class_type: 'EmptyTrellis2LatentStructure', inputs: { batch_size: 1 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        model: ['108', 0],
        seed: 0,
        steps: 12,
        cfg: 7.5,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: [cond, 0],
        negative: [cond, 1],
        latent_image: ['87', 0],
        denoise: 1,
      },
    },
    '119': {
      class_type: 'VaeDecodeStructureTrellis2',
      inputs: { samples: ['3', 0], vae: ['117', 0], resolution: '32' },
    },
    // Shape at 512³.
    '279': {
      class_type: 'CFGOverride',
      inputs: { model: ['40', 0], cfg: 1, start_percent: 0.769, end_percent: 1 },
    },
    '126': { class_type: 'RescaleCFG', inputs: { model: ['279', 0], multiplier: 0.5 } },
    '91': {
      class_type: 'Trellis2ShapeStage',
      inputs: { positive: [cond, 0], negative: [cond, 1], voxel: ['119', 0] },
    },
    '18': {
      class_type: 'KSampler',
      inputs: {
        model: ['126', 0],
        seed: 0,
        steps: 20,
        cfg: 7.5,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['91', 0],
        negative: ['91', 1],
        latent_image: ['91', 2],
        denoise: 1,
      },
    },
    '92': { class_type: 'VaeDecodeShapeTrellis', inputs: { samples: ['18', 0], vae: ['117', 0] } },
    ...(finish === 'grey' ? {} : trellis2TextureNodes()),
    ...trellis2MeshNodes(finish),
  };
}

/** The texture sampler and its decode — everything a grey model skips. */
function trellis2TextureNodes(): ComfyGraph {
  return {
    '118': {
      class_type: 'VAELoader',
      inputs: { vae_name: 'trellis_2_texture_vae_bf16.safetensors' },
    },
    // Texture, guidance-free.
    '98': {
      class_type: 'Trellis2TextureStage',
      inputs: { positive: ['91', 0], negative: ['91', 1], shape_latent: ['18', 0] },
    },
    '12': {
      class_type: 'KSampler',
      inputs: {
        model: ['40', 0],
        seed: 0,
        steps: 12,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['98', 0],
        negative: ['98', 1],
        latent_image: ['98', 2],
        denoise: 1,
      },
    },
    '93': {
      class_type: 'VaeDecodeTextureTrellis',
      inputs: { samples: ['12', 0], vae: ['118', 0], shape_subdivides: ['92', 1] },
    },
  };
}

/**
 * The mesh, on the CPU (see the header) — remesh, decimate, and then as much
 * of unwrap + bake + apply as the finish asks for. The saved GLB is node '9'
 * for every finish so the runner finds it the same way.
 */
function trellis2MeshNodes(finish: ModelFinish): ComfyGraph {
  const remeshAndDecimate: ComfyGraph = {
    /*
     * Upstream's own post-processing, kept: REMESH the decoded surface first (512³ unsigned-distance dual
     * contouring, twenty Taubin passes), and only then decimate, unwrap and
     * bake from THAT. the user (2026-09-14), on a mug baked straight off the
     * decoded voxel surface: "this cup shows a lot of artifacting … 100%
     * fixable as trellis and pixal both produce much higher quality models
     * than that". LOOKED AT in the studio's own viewport, same mug: without
     * the remesh, the normal map is voxel noise and the textured view is
     * speckled; with it, a clean glaze, a clean rim, clean normals. 100k
     * faces on a 2048² sheet (21 texels a face) — 200k on 1024² put chart
     * gutters under every other texel. MEASURED standalone: remesh 27s,
     * decimate 83s, bakes ~90s.
     */
    '241': {
      class_type: 'RemeshMesh',
      inputs: {
        mesh: ['92', 0],
        resolution: 512,
        sign_mode: 'udf',
        'sign_mode.qef': false,
        'sign_mode.drop_inverted_components': false,
        'sign_mode.drop_enclosed_components': false,
        band: 1,
        project_back: 0,
        fix_poles: false,
        smooth_iters: 20,
        drop_small_components: 0.01,
        precluster_max_verts: 20000000,
      },
    },
    '186': {
      class_type: 'DecimateMesh',
      inputs: { mesh: ['241', 0], target_face_count: 100000, placement_mode: 'midpoint' },
    },
    '238': { class_type: 'MeshSmoothNormals', inputs: { mesh: ['186', 0], crease_angle: 180 } },
  };
  if (finish === 'grey') {
    return {
      ...remeshAndDecimate,
      '9': { class_type: 'SaveGLB', inputs: { mesh: ['238', 0], filename_prefix: 'pi-model' } },
    };
  }
  const unwrapAndBake: ComfyGraph = {
    '196': {
      class_type: 'UnwrapMesh',
      inputs: {
        mesh: ['238', 0],
        segmenter: 'pec',
        resolution: 2048,
        padding: 1,
        weld_distance: 0.0002,
      },
    },
    '147': {
      class_type: 'BakeTextureFromVoxel',
      inputs: {
        mesh: ['196', 0],
        voxel_colors: ['93', 0],
        reference_mesh: ['92', 0],
        texture_size: 2048,
      },
    },
  };
  if (finish === 'color') {
    return {
      ...remeshAndDecimate,
      ...unwrapAndBake,
      // Base colour only: the painted look, lit like clay.
      '210': {
        class_type: 'ApplyTextureToMesh',
        inputs: { mesh: ['196', 0], base_color: ['147', 0] },
      },
      '260': { class_type: 'MeshSmoothNormals', inputs: { mesh: ['210', 0], crease_angle: 180 } },
      '9': { class_type: 'SaveGLB', inputs: { mesh: ['260', 0], filename_prefix: 'pi-model' } },
    };
  }
  return {
    ...remeshAndDecimate,
    ...unwrapAndBake,
    '224': {
      class_type: 'BakeNormalMapFromMesh',
      inputs: {
        low_poly: ['196', 0],
        high_poly: ['241', 0],
        resolution: 2048,
        cage_distance: 0.05,
        ignore_backfaces: true,
      },
    },
    '233': {
      class_type: 'BakeAmbientOcclusion',
      inputs: {
        low_poly: ['196', 0],
        high_poly: ['241', 0],
        resolution: 1024,
        samples: 64,
        max_distance: 0.71,
        strength: 1,
        bias: 0.01,
      },
    },
    '210': {
      class_type: 'ApplyTextureToMesh',
      inputs: {
        mesh: ['196', 0],
        base_color: ['147', 0],
        metallic: ['147', 1],
        roughness: ['147', 2],
        occlusion: ['233', 0],
        normal_map: ['224', 0],
      },
    },
    '260': { class_type: 'MeshSmoothNormals', inputs: { mesh: ['210', 0], crease_angle: 180 } },
    '9': { class_type: 'SaveGLB', inputs: { mesh: ['260', 0], filename_prefix: 'pi-model' } },
  };
}

/**
 * The 3D splice points. One seed reaches all three samplers; the texture size
 * is the atlas AND the bakes AND the unwrap's texel-density target, which have
 * to agree or the charts are packed for a sheet that is not the one painted.
 */
const IMAGE_TO_3D_PARAM_MAP = {
  image: '122.inputs.image',
  seed: ['3.inputs.seed', '18.inputs.seed', '12.inputs.seed'],
  faces: '186.inputs.target_face_count',
  textureSize: ['196.inputs.resolution', '147.inputs.texture_size', '224.inputs.resolution'],
} as const;
/** Colour: no normal bake to size. */
const IMAGE_TO_3D_COLOR_PARAM_MAP = {
  image: '122.inputs.image',
  seed: ['3.inputs.seed', '18.inputs.seed', '12.inputs.seed'],
  faces: '186.inputs.target_face_count',
  textureSize: ['196.inputs.resolution', '147.inputs.texture_size'],
} as const;
/** Grey: two samplers, no atlas at all. */
const IMAGE_TO_3D_GREY_PARAM_MAP = {
  image: '122.inputs.image',
  seed: ['3.inputs.seed', '18.inputs.seed'],
  faces: '186.inputs.target_face_count',
} as const;

/**
 * The template a 3D catalog entry's `workflowTemplate` becomes for a finish:
 * the entry names the PBR graph; colour and grey are its siblings.
 */
export function imageTo3dTemplateFor(workflowTemplate: string, finish: ModelFinish): string {
  return finish === 'pbr' ? workflowTemplate : `${workflowTemplate}-${finish}`;
}

const FLUX_GGUF_PARAM_MAP = {
  prompt: '6.inputs.text',
  width: '5.inputs.width',
  height: '5.inputs.height',
  steps: '17.inputs.steps',
  guidance: '26.inputs.guidance',
  seed: '25.inputs.noise_seed',
} as const;

/**
 * The template registry, keyed by template id. Every id here is referenced by a
 * `comfyui`-backed catalog entry's `comfy.workflowTemplate`; the three LTX rows
 * share one graph shape (they differ only by which GGUF weights get downloaded,
 * not by graph topology).
 */
export const WORKFLOW_TEMPLATES: Readonly<Record<string, WorkflowTemplate>> = {
  'ltx-video-2b-distilled-gguf': {
    id: 'ltx-video-2b-distilled-gguf',
    graph: ltxVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'ltx-2-distilled-gguf': {
    id: 'ltx-2-distilled-gguf',
    graph: ltxVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'ltx-2-22b-gguf': {
    id: 'ltx-2-22b-gguf',
    graph: ltxVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'wan2.1-t2v-1.3b': {
    id: 'wan2.1-t2v-1.3b',
    graph: wanVideoGraph(),
    paramMap: WAN_PARAM_MAP,
  },
  'ltx-2.5-distilled-gguf': {
    id: 'ltx-2.5-distilled-gguf',
    graph: ltx25Graph(),
    paramMap: LTX_25_PARAM_MAP,
  },
  'minimax-h3-t2v-gguf': {
    id: 'minimax-h3-t2v-gguf',
    graph: minimaxH3Graph(),
    paramMap: MINIMAX_H3_PARAM_MAP,
  },
  'ace-step-music': {
    id: 'ace-step-music',
    graph: aceStepGraph(),
    paramMap: ACE_STEP_PARAM_MAP,
  },
  'stable-audio-open': {
    id: 'stable-audio-open',
    graph: stableAudioGraph(),
    paramMap: STABLE_AUDIO_PARAM_MAP,
  },
  'stable-audio-open-small': {
    id: 'stable-audio-open-small',
    graph: stableAudioGraph(),
    paramMap: STABLE_AUDIO_PARAM_MAP,
  },
  'stable-audio-3-music': {
    id: 'stable-audio-3-music',
    graph: {
      ...stableAudio3Graph(),
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'stable_audio_3_small_music.safetensors' },
      },
    },
    paramMap: STABLE_AUDIO_3_PARAM_MAP,
  },
  'stable-audio-3-sfx': {
    id: 'stable-audio-3-sfx',
    graph: stableAudio3Graph(),
    paramMap: STABLE_AUDIO_3_PARAM_MAP,
  },
  'flux1-dev-gguf-q6k': {
    id: 'flux1-dev-gguf-q6k',
    graph: fluxGgufGraph(),
    paramMap: FLUX_GGUF_PARAM_MAP,
  },
  'trellis2-image-to-3d': {
    id: 'trellis2-image-to-3d',
    graph: trellis2ImageTo3dGraph('trellis2'),
    paramMap: IMAGE_TO_3D_PARAM_MAP,
  },
  'trellis2-image-to-3d-color': {
    id: 'trellis2-image-to-3d-color',
    graph: trellis2ImageTo3dGraph('trellis2', 'color'),
    paramMap: IMAGE_TO_3D_COLOR_PARAM_MAP,
  },
  'trellis2-image-to-3d-grey': {
    id: 'trellis2-image-to-3d-grey',
    graph: trellis2ImageTo3dGraph('trellis2', 'grey'),
    paramMap: IMAGE_TO_3D_GREY_PARAM_MAP,
  },
  'pixal3d-image-to-3d': {
    id: 'pixal3d-image-to-3d',
    graph: trellis2ImageTo3dGraph('pixal3d'),
    paramMap: IMAGE_TO_3D_PARAM_MAP,
  },
  'pixal3d-image-to-3d-color': {
    id: 'pixal3d-image-to-3d-color',
    graph: trellis2ImageTo3dGraph('pixal3d', 'color'),
    paramMap: IMAGE_TO_3D_COLOR_PARAM_MAP,
  },
  'pixal3d-image-to-3d-grey': {
    id: 'pixal3d-image-to-3d-grey',
    graph: trellis2ImageTo3dGraph('pixal3d', 'grey'),
    paramMap: IMAGE_TO_3D_GREY_PARAM_MAP,
  },
};

/** Look up a template by id. */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES[id];
}

/** Set a value at a dotted node-input path (e.g. `"6.inputs.text"`), creating gaps. */
function setAtPath(root: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segs = dottedPath.split('.');
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i];
    if (key === undefined) return;
    const next = cur[key];
    if (typeof next !== 'object' || next === null) {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  const last = segs[segs.length - 1];
  if (last !== undefined) cur[last] = value;
}

/**
 * Resolve a {@link ComfyJobSpec} + a single candidate seed into a concrete,
 * POST-able API-format graph: deep-clone the named template, splice each
 * `spec.inputs[param]` in at its `paramMap` path, then stamp THIS candidate's
 * `seed` at the template's seed path (the per-candidate seed always wins over any
 * `seed` in `inputs`). Pure — the adapter calls it once per seed.
 *
 * Throws on an unknown template id, or an input param the template has no binding
 * for (a catalog/template drift the caller should never produce).
 */
export function fillWorkflow(
  spec: ComfyJobSpec,
  seed: number,
  registry: Readonly<Record<string, WorkflowTemplate>> = WORKFLOW_TEMPLATES,
): ComfyGraph {
  const tmpl = registry[spec.workflowTemplate];
  if (tmpl === undefined) {
    throw new Error(`unknown ComfyUI workflow template: "${spec.workflowTemplate}"`);
  }
  const graph = structuredClone(tmpl.graph) as unknown as Record<string, unknown>;
  const spliceAll = (paths: string | readonly string[], value: unknown): void => {
    for (const p of typeof paths === 'string' ? [paths] : paths) setAtPath(graph, p, value);
  };
  for (const [param, value] of Object.entries(spec.inputs)) {
    const path = tmpl.paramMap[param];
    if (path === undefined) {
      throw new Error(`template "${tmpl.id}" has no paramMap binding for input "${param}"`);
    }
    spliceAll(path, value);
  }
  const seedPath = tmpl.paramMap.seed;
  if (seedPath !== undefined) spliceAll(seedPath, seed);
  return graph as unknown as ComfyGraph;
}
