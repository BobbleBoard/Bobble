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
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Negative prompt' },
    },
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
  negativePrompt: '7.inputs.text',
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
