/**
 * THE CURATED RECOMMENDED LIST — one card per FAMILY, every output modality.
 *
 * the user: "we need to curate for now, dropping the newest in favor of
 * 'recommended'. I notice you added bartowski (good pick) for reliable people,
 * but the newest is just clogged immediately with 10 bartowski ornith 1.5 quants
 * from the different model sizes, we don't want that there really. we need to
 * have reccomended section and then have that by default that has good
 * organization and such (we can easily bundle draft models, have model families
 * grouped together and such) but we let people do from hf and deal with the
 * messy default search if they want."
 *
 * WHY A HAND-WRITTEN LIST AND NOT A SMARTER FILTER. The clog is not a sorting
 * problem. "Reputable publisher" is true of all ten Ornith quant repos, and any
 * rule that demotes them ("one per family", "prefer the biggest") is a guess
 * about which of the ten a person wants. A curated list answers the question the
 * hub is actually being asked on first open — *what should I get?* — and the
 * unfiltered Hugging Face firehose stays one toggle away for anyone who would
 * rather browse.
 *
 * WHAT IS IN IT, AND HOW IT WAS PICKED. Every repo here was checked against the
 * Hugging Face API on 2026-08-20 rather than recalled: it exists, it is the
 * current version of its family, and the download counts are the ones that made
 * it a default. Two things follow from that:
 *
 *   - This list HAS an expiry. A family whose newest member has been superseded
 *     is worse than no recommendation, because it is a recommendation. The date
 *     above is the audit stamp; re-run the checks rather than trusting the names.
 *   - The Microsoft Mage-Flow repos our roadmap linked are GONE (404 on the API).
 *     The family lives at Comfy-Org and mage-flow-community now, which is what
 *     these entries point at.
 *
 * ORDER IS SMALL → LARGE, per the user, and it is the parameter count that orders
 * them — the same axis the hub's Size column uses, because bytes belong to a
 * specific quant and a family spans several.
 *
 * DRAFT MODELS RIDE WITH THEIR PARENT. A speculative-decoding draft is not a
 * model anyone browses for; it is an accessory to the one above it. They carry
 * `draftFor` and are never counted as a family of their own.
 */

/** What a model MAKES. The axis the user asked to filter on. */
export type OutputModality = 'text' | 'image' | 'video' | 'audio' | '3d';

export const OUTPUT_LABEL: Record<OutputModality, string> = {
  text: 'Text',
  image: 'Images',
  video: 'Video',
  audio: 'Audio',
  '3d': '3D',
};

/**
 * AN IN→OUT JOB. the user: "ltx 2.5 and minimax I think have a lot of sub models or
 * something complicated where you download one per like in-out you want eg.
 * video+text-video or image-video or start+endframe-video or text-video etc. so
 * these need good handling and communication to the user however you choose."
 *
 * He is right, and MiniMax-H3 is the clearest case: its repo has an `FL2VA`
 * tree (First+Last frame → Video+Audio) and a `Ref2VA` tree (Reference image →
 * Video+Audio), each published at eight quants, plus a shared text encoder and
 * VAE. "Do I have MiniMax-H3?" is therefore not a yes/no question, and a single
 * Download button for the family would be a lie in both directions — it would
 * either fetch 350 GB or fetch one tree and imply the rest.
 *
 * So a variant names the jobs its files can do, and the card says so in words.
 */
export type ModelTask =
  | 'text-to-video'
  | 'image-to-video'
  | 'keyframes-to-video'
  | 'video-to-video'
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-text'
  | 'image-text-to-text'
  | 'text-to-speech'
  | 'text-to-audio'
  | 'image-to-3d'
  | 'text-to-3d'
  | 'text-to-motion';

/** How a task reads on a card. Plain words, not the Hugging Face spelling. */
export const TASK_LABEL: Record<ModelTask, string> = {
  'text-to-video': 'text → video',
  'image-to-video': 'image → video',
  'keyframes-to-video': 'first + last frame → video',
  'video-to-video': 'video → video',
  'text-to-image': 'text → image',
  'image-to-image': 'image → image',
  'text-to-text': 'chat',
  'image-text-to-text': 'reads images',
  'text-to-speech': 'text → speech',
  'text-to-audio': 'text → audio',
  'image-to-3d': 'image → 3D',
  'text-to-3d': 'text → 3D',
  'text-to-motion': 'text → motion',
};

/** One member of a family — a size, a speed variant, or a task variant. */
export interface RecommendedVariant {
  /** Hugging Face repo id. Verified to exist — see the file docstring. */
  readonly repo: string;
  /** What distinguishes it within the family: "2.6B", "Turbo", "Edit". */
  readonly label: string;
  /** Parameters in billions, for ordering and the size column. */
  readonly paramsB?: number;
  /** One clause on when to reach for THIS one rather than its siblings. */
  readonly note?: string;
  /**
   * This is a speculative-decoding draft for the named variant, not a model to
   * pick. Bundled under its parent and never shown as a choice.
   */
  readonly draftFor?: string;
  /** Runs on Apple Silicon today (MLX or GGUF). Advisory. */
  readonly mlx?: boolean;
  /**
   * The SUBSET of the repo this variant is, as `*` globs.
   *
   * A big generation repo is not one model — LTX-2.5 publishes five transformers
   * at different precisions, two text encoders and three VAEs in one tree, and
   * taking all of it would be ~200 GB to run one configuration. These globs are
   * the recipe: which transformer, which encoder, which VAE. Omitted means the
   * whole repo, which is the right answer for a small one.
   */
  readonly allow?: readonly string[];
  /** What these particular files can do. See {@link ModelTask}. */
  readonly tasks?: readonly ModelTask[];
  /**
   * EXTRA REPOS this recipe needs, when one is not enough.
   *
   * A ComfyUI video graph wants three things — a transformer, a text encoder and
   * a VAE — and the quantized community builds publish them SEPARATELY: the
   * transformer at `city96/LTX-Video-0.9.6-distilled-gguf`, the T5 encoder at
   * `city96/t5-v1_1-xxl-encoder-gguf`. One `repo` + `allow` cannot express that,
   * and asking the user to notice they also need an encoder is how someone ends
   * up with 1.3 GB of weights that cannot run.
   *
   * `repo`/`allow` above stay the PRIMARY part (what the row is named after);
   * these are fetched alongside it and counted into `approxBytes`.
   */
  readonly parts?: readonly { readonly repo: string; readonly allow?: readonly string[] }[];
  /** Real download size of THIS selection, in bytes. Measured from the repo tree. */
  readonly approxBytes?: number;
  /**
   * Unified memory needed to actually RUN it, in GB.
   *
   * the user: "of course all of these are vram dependent, show a not recommended for
   * this machine if it can't run". Deliberately separate from download size:
   * weights on disk are not weights resident, and a 21 GB transformer needs room
   * for activations beside it.
   */
  readonly minMemoryGB?: number;
}

/** The verdict a card shows for this machine. */
export type FitVerdict = 'fits' | 'tight' | 'too-big' | 'unknown';

/**
 * Can this machine run it?
 *
 * `tight` is the honest middle: a model whose weights fit but leave no room for
 * the rest of the system will run, slowly, by swapping — telling someone it does
 * not fit would be wrong, and telling them it fits would be worse.
 */
export function fitFor(variant: RecommendedVariant, totalMemoryGB: number): FitVerdict {
  const need = variant.minMemoryGB;
  if (need === undefined || totalMemoryGB <= 0) return 'unknown';
  if (need <= totalMemoryGB * 0.75) return 'fits';
  if (need <= totalMemoryGB) return 'tight';
  return 'too-big';
}

export interface RecommendedFamily {
  readonly id: string;
  /** "LTX-2.5" — the family, not the repo. */
  readonly name: string;
  readonly org: string;
  readonly output: OutputModality;
  /** What it is for, in one sentence a newcomer can act on. */
  readonly blurb: string;
  /**
   * Unusually fast for its class, and the reason it is here at all on a modest
   * machine. the user on LTX-2.5 / MiniMax-H3 / Mage-Flow: "super reccomended (whole
   * family) for lower end devices because they're very fast and very good".
   */
  readonly fast?: boolean;
  /** Smallest first, always. */
  readonly variants: readonly RecommendedVariant[];
}

/**
 * The list.
 *
 * Grouped by output so the file reads the way the filter does, then sorted
 * small-to-large at the point of use (`recommendedFamilies`), so adding an entry
 * cannot get the order wrong.
 */
export const RECOMMENDED_FAMILIES: readonly RecommendedFamily[] = [
  // ── TEXT ──────────────────────────────────────────────────────────────────
  {
    id: 'lfm2.5',
    name: 'LFM 2.5',
    org: 'LiquidAI',
    output: 'text',
    blurb: 'The smallest models here that still hold a conversation — a laptop-class default.',
    fast: true,
    variants: [
      {
        repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
        label: '1.2B',
        paramsB: 1.2,
        note: 'Runs anywhere; good for routing and quick edits.',
        minMemoryGB: 3,
      },
      {
        repo: 'LiquidAI/LFM2.5-2.6B-GGUF',
        label: '2.6B',
        paramsB: 2.6,
        note: 'The sweet spot of this family.',
        minMemoryGB: 4,
      },
      {
        repo: 'LiquidAI/LFM2.5-8B-A1B-GGUF',
        label: '8B-A1B',
        paramsB: 8,
        note: 'Mixture-of-experts: 8B of knowledge at ~1B of compute per token.',
        minMemoryGB: 7,
      },
      {
        repo: 'LiquidAI/LFM2.5-VL-1.6B',
        label: 'VL 1.6B',
        paramsB: 1.6,
        note: 'Reads images.',
        minMemoryGB: 5,
      },
    ],
  },
  {
    id: 'qwen3.5',
    name: 'Qwen3.5',
    org: 'unsloth',
    output: 'text',
    blurb: 'The general-purpose ladder, with MTP draft weights for speculative decoding.',
    variants: [
      { repo: 'unsloth/Qwen3.5-0.8B-MTP-GGUF', label: '0.8B', paramsB: 0.8, minMemoryGB: 3 },
      { repo: 'unsloth/Qwen3.5-2B-MTP-GGUF', label: '2B', paramsB: 2, minMemoryGB: 4 },
      {
        repo: 'unsloth/Qwen3.5-4B-MTP-GGUF',
        label: '4B',
        paramsB: 4,
        note: 'The fast tier on a 16 GB machine.',
        minMemoryGB: 6,
      },
      {
        repo: 'unsloth/Qwen3.5-9B-MTP-GGUF',
        label: '9B',
        paramsB: 9,
        note: 'The balanced tier on 24 GB.',
        minMemoryGB: 9,
      },
      {
        repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
        label: '4B · MLX',
        paramsB: 4,
        mlx: true,
        minMemoryGB: 6,
      },
      {
        repo: 'mlx-community/Qwen3.5-9B-MLX-4bit',
        label: '9B · MLX',
        paramsB: 9,
        mlx: true,
        minMemoryGB: 9,
      },
    ],
  },
  {
    id: 'gemma4',
    name: 'Gemma 4',
    org: 'unsloth',
    output: 'text',
    blurb: "Google's open family — the E-series is built for small machines, and 12B reads images.",
    variants: [
      { repo: 'unsloth/gemma-4-E2B-it-GGUF', label: 'E2B', paramsB: 2, minMemoryGB: 4 },
      { repo: 'unsloth/gemma-4-E4B-it-GGUF', label: 'E4B', paramsB: 4, minMemoryGB: 6 },
      {
        repo: 'unsloth/gemma-4-12B-it-qat-GGUF',
        label: '12B QAT',
        paramsB: 12,
        note: 'Quantization-aware: holds up better at 4-bit than a plain quant.',
        minMemoryGB: 11,
      },
      {
        repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
        label: '26B-A4B',
        paramsB: 26,
        note: 'MoE — 26B of weights, ~4B active.',
        minMemoryGB: 19,
      },
      { repo: 'unsloth/gemma-4-31B-it-GGUF', label: '31B', paramsB: 31, minMemoryGB: 23 },
    ],
  },
  {
    id: 'qwen3.8',
    name: 'Qwen3.8',
    org: 'unsloth',
    output: 'text',
    blurb: 'The strongest open model that fits a personal machine. The default when it does.',
    /*
     * THE STANDING TOP PICK. the user: "qwen3.8 27b as the top choice always if the
     * user's machine can do it." Independently confirmed: Artificial Analysis
     * puts it first among open weights at an intelligence index of 52, ahead of
     * MiniMax-M3 (45) and Muse Glimmer (35) — and those two are 428B and 30B.
     *
     * ONE VARIANT ON PURPOSE. Qwen3.6's sizes used to live here, which made the
     * recommender hand a 4090 "Qwen3.8 3.6 35B-A3B" — a name that is two model
     * versions welded together, for a pick that is not the one the user asked for.
     * A family is a version now, and 3.6 is its own entry below.
     */
    variants: [
      {
        repo: 'unsloth/Qwen3.8-27B-GGUF',
        label: '27B',
        paramsB: 27,
        note: 'Q4 on a 32 GB machine, Q3 on 24 GB.',
        minMemoryGB: 20,
      },
    ],
  },
  {
    id: 'qwen3.6',
    name: 'Qwen3.6',
    org: 'unsloth',
    output: 'text',
    blurb: 'The previous generation — the 35B mixture-of-experts decodes like a 3B.',
    variants: [
      { repo: 'unsloth/Qwen3.6-27B-MTP-GGUF', label: '27B', paramsB: 27, minMemoryGB: 20 },
      {
        repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        label: '35B-A3B',
        paramsB: 35,
        note: 'MoE — decodes at roughly a 3B model\u2019s speed.',
        minMemoryGB: 25,
      },
    ],
  },
  {
    id: 'muse-glimmer',
    name: 'Muse Glimmer',
    org: 'unsloth',
    output: 'text',
    blurb: 'Vision-language: hand it screenshots, diagrams or photos and ask about them.',
    variants: [
      { repo: 'unsloth/Muse-Glimmer-30B-GGUF', label: '30B', paramsB: 30, minMemoryGB: 22 },
    ],
  },
  {
    id: 'nemotron3.5',
    name: 'Nemotron 3.5 Lightning',
    org: 'unsloth',
    output: 'text',
    blurb: "NVIDIA's throughput-tuned MoE — long context at speed.",
    variants: [
      {
        repo: 'unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF',
        label: '30B-A3B',
        paramsB: 30,
        minMemoryGB: 22,
      },
    ],
  },

  {
    id: 'qwen3-vl',
    name: 'Qwen3-VL',
    org: 'Qwen',
    output: 'text',
    blurb: 'Reads screenshots, diagrams and photographs, at sizes a laptop can hold.',
    variants: [
      { repo: 'Qwen/Qwen3-VL-2B-Instruct', label: '2B', paramsB: 2, minMemoryGB: 6 },
      { repo: 'Qwen/Qwen3-VL-4B-Instruct', label: '4B', paramsB: 4, minMemoryGB: 10 },
      {
        repo: 'Qwen/Qwen3-VL-8B-Instruct',
        label: '8B',
        paramsB: 8,
        note: 'The one worth running if it fits — 17.5 GB of weights.',
        minMemoryGB: 20,
      },
    ],
  },
  {
    id: 'qwen3-omni',
    name: 'Qwen3-Omni',
    org: 'Qwen',
    output: 'text',
    blurb: 'Text, images and audio in; text and speech out. One model for the lot.',
    variants: [
      {
        repo: 'Qwen/Qwen3-Omni-30B-A3B-Instruct',
        label: '30B-A3B',
        paramsB: 30,
        note: '70 GB of weights — a Max or Ultra, or a quantised community build.',
        minMemoryGB: 80,
      },
    ],
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    org: 'unsloth',
    output: 'text',
    blurb: 'A frontier-class open model. The small quants are the only ones that fit a laptop.',
    variants: [
      {
        repo: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
        label: 'DSpark Q8',
        note: 'The distilled DSpark build — 10.9 GB, and the way in on a normal machine.',
        allow: ['dspark-DeepSeek-V4-Flash-0731-Q8_0.gguf'],
        approxBytes: 10_900_000_000,
        minMemoryGB: 14,
      },
      {
        repo: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
        label: 'UD-IQ3_XXS',
        note: 'The full model at its smallest useful quant, in four shards.',
        allow: ['UD-IQ3_XXS/*'],
        approxBytes: 20_000_000_000,
        minMemoryGB: 32,
      },
      {
        repo: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
        label: 'UD-Q4_K_XL',
        note: 'Five shards. Workstation territory.',
        allow: ['UD-Q4_K_XL/*'],
        approxBytes: 36_000_000_000,
        minMemoryGB: 64,
      },
    ],
  },

  // ── IMAGE ─────────────────────────────────────────────────────────────────
  {
    id: 'mage-flow',
    name: 'Mage Flow',
    org: 'Comfy-Org',
    output: 'image',
    blurb: 'Few-step, so it stays quick on any machine. The default image model.',
    fast: true,
    /*
     * the user's top image pick, and the reason is speed rather than fidelity: "for
     * any generally 'slow' machine, mage flow models are inevitably going to be
     * like an order of magnitude faster than any flux 2 klien or even something
     * like z image is". Our own measurement points the same way — Mage-Flow-Turbo
     * 11s against FLUX.2 Klein 4B's 13s on MLX, and 71s for the same Mage Flow
     * on PyTorch — and a few-step model's advantage GROWS as the machine slows.
     *
     * SIZES ARE FILE SIZES, read from the Comfy-Org repo tree rather than
     * estimated: the transformer is 4.16 GB at int8 and 8.23 GB at bf16, the
     * Qwen3-VL text encoder is 8.88 GB, the VAE 0.35 GB. The encoder is most of
     * the download, which is why even the int8 kit is 13 GB and why this family
     * genuinely does not fit an 8 GB machine.
     */
    variants: [
      {
        repo: 'Comfy-Org/Mage-Flow',
        label: 'Turbo · int8',
        note: 'Few-step and quantized — the one to start with.',
        allow: [
          'diffusion_models/mage_flow_turbo_int8_convrot.safetensors',
          'text_encoders/qwen3vl_4b_bf16.safetensors',
          'vae/mage_flow_vae_bf16.safetensors',
        ],
        tasks: ['text-to-image'],
        approxBytes: 13_390_000_000,
        minMemoryGB: 12,
      },
      {
        repo: 'Comfy-Org/Mage-Flow',
        label: 'Edit Turbo · int8',
        note: 'Edits an existing image from an instruction.',
        allow: [
          'diffusion_models/mage_flow_edit_turbo_int8_convrot.safetensors',
          'text_encoders/qwen3vl_4b_bf16.safetensors',
          'vae/mage_flow_vae_bf16.safetensors',
        ],
        tasks: ['image-to-image'],
        approxBytes: 13_390_000_000,
        minMemoryGB: 12,
      },
      {
        repo: 'Comfy-Org/Mage-Flow',
        label: 'Turbo · bf16',
        note: 'Full precision, for machines with room.',
        allow: [
          'diffusion_models/mage_flow_turbo_bf16.safetensors',
          'text_encoders/qwen3vl_4b_bf16.safetensors',
          'vae/mage_flow_vae_bf16.safetensors',
        ],
        tasks: ['text-to-image'],
        approxBytes: 17_460_000_000,
        minMemoryGB: 20,
      },
    ],
  },
  {
    id: 'z-image',
    name: 'Z-Image',
    org: 'Tongyi-MAI',
    output: 'image',
    blurb: 'Eight steps, 16 GB, Apache-2.0 — the cheapest good image model to run.',
    fast: true,
    variants: [{ repo: 'Tongyi-MAI/Z-Image-Turbo', label: 'Turbo', paramsB: 6, minMemoryGB: 16 }],
  },
  {
    id: 'flux2',
    name: 'FLUX.2',
    org: 'black-forest-labs',
    output: 'image',
    blurb: 'The photorealism leader among open weights. klein is the size that fits a laptop.',
    variants: [
      {
        repo: 'black-forest-labs/FLUX.2-klein-4B',
        label: 'klein 4B',
        paramsB: 3.9,
        note: 'Apache-2.0, ~13 GB at 8-bit.',
        minMemoryGB: 14,
      },
      { repo: 'black-forest-labs/FLUX.2-klein-9B', label: 'klein 9B', paramsB: 9, minMemoryGB: 24 },
      {
        repo: 'black-forest-labs/FLUX.2-dev',
        label: 'dev',
        paramsB: 32,
        note: 'The full model — 32 GB+ machines.',
        minMemoryGB: 48,
      },
    ],
  },
  {
    id: 'krea2',
    name: 'Krea 2',
    org: 'krea',
    output: 'image',
    blurb: 'Aesthetic-tuned — less of the plastic AI look, with a Turbo for iteration.',
    variants: [
      { repo: 'krea/Krea-2-Turbo', label: 'Turbo', paramsB: 12.8, minMemoryGB: 24 },
      {
        repo: 'krea/Krea-2-Raw',
        label: 'Raw',
        paramsB: 12.8,
        note: 'Unopinionated base.',
        minMemoryGB: 24,
      },
    ],
  },
  {
    id: 'qwen-image',
    name: 'Qwen-Image',
    org: 'Qwen',
    output: 'image',
    blurb: 'The one to use when the image has to contain readable text.',
    variants: [{ repo: 'Qwen/Qwen-Image', label: '2512', paramsB: 20, minMemoryGB: 32 }],
  },

  // ── VIDEO ─────────────────────────────────────────────────────────────────
  {
    id: 'ltx',
    name: 'LTX-Video',
    org: 'Lightricks',
    output: 'video',
    blurb: 'The fast end of open video, in quants a laptop can actually hold.',
    fast: true,
    /*
     * QUANTS, NOT FULL PRECISION — and on a Mac that is not a preference, it is
     * the only thing that works. the user: "comfyui supports quants however right?
     * so we never have to actually do the full things, we can go for 8 bit or
     * lower depending on hardware/user preference."
     *
     * Right, with one Mac-specific catch worth writing down because it decided
     * every entry below. ComfyUI's own `model_management.supports_cast()` returns
     * FALSE for MPS before it ever reaches its fp8 branches — so an fp8
     * checkpoint on Apple Silicon is either silently upcast to bf16 (no memory
     * saved) or fails outright with "Trying to convert Float8_e4m3fn to the MPS
     * backend". GGUF is the quant path that works here, via ComfyUI-GGUF's
     * `UnetLoaderGGUF`, which is the node our workflow template already uses.
     *
     * The previous entries were bf16/fp8 recipes at 25-70 GB, all of them marked
     * "Too big for this Mac". These are 7-20 GB and run.
     */
    variants: [
      {
        repo: 'city96/LTX-Video-0.9.6-distilled-gguf',
        label: '2B distilled · Q4',
        paramsB: 2,
        note: 'The whole kit is under 7 GB. Start here.',
        allow: [
          'ltxv-2b-0.9.6-distilled-04-25-Q4_K_M.gguf',
          'LTX-Video-0.9.6-VAE-BF16.safetensors',
        ],
        parts: [
          { repo: 'city96/t5-v1_1-xxl-encoder-gguf', allow: ['t5-v1_1-xxl-encoder-Q4_K_M.gguf'] },
        ],
        tasks: ['text-to-video', 'image-to-video'],
        approxBytes: 6_720_000_000,
        minMemoryGB: 10,
      },
      {
        repo: 'city96/LTX-Video-0.9.6-distilled-gguf',
        label: '2B distilled · Q8',
        paramsB: 2,
        note: 'Better fidelity for about three more gigabytes.',
        allow: ['ltxv-2b-0.9.6-distilled-04-25-Q8_0.gguf', 'LTX-Video-0.9.6-VAE-BF16.safetensors'],
        parts: [
          { repo: 'city96/t5-v1_1-xxl-encoder-gguf', allow: ['t5-v1_1-xxl-encoder-Q8_0.gguf'] },
        ],
        tasks: ['text-to-video', 'image-to-video'],
        approxBytes: 9_800_000_000,
        minMemoryGB: 14,
      },
      {
        repo: 'Abiray/LTX-2.5-Distilled-GGUF',
        label: '2.5 22B · Q3',
        note: 'The current release, quantized far enough to fit 24 GB.',
        allow: ['LTX-2.5-Distilled-Q3_K_S.gguf'],
        parts: [
          { repo: 'city96/t5-v1_1-xxl-encoder-gguf', allow: ['t5-v1_1-xxl-encoder-Q4_K_M.gguf'] },
          {
            repo: 'Lightricks/LTX-2.5',
            allow: ['vae/ltx-2.5-video-vae-bf16.safetensors'],
          },
        ],
        tasks: ['text-to-video', 'image-to-video'],
        approxBytes: 17_020_000_000,
        minMemoryGB: 22,
      },
      {
        repo: 'Abiray/LTX-2.5-Distilled-GGUF',
        label: '2.5 22B · Q4',
        allow: ['LTX-2.5-Distilled-Q4_K_M.gguf'],
        parts: [
          { repo: 'city96/t5-v1_1-xxl-encoder-gguf', allow: ['t5-v1_1-xxl-encoder-Q4_K_M.gguf'] },
          {
            repo: 'Lightricks/LTX-2.5',
            allow: ['vae/ltx-2.5-video-vae-bf16.safetensors'],
          },
        ],
        tasks: ['text-to-video', 'image-to-video'],
        approxBytes: 20_060_000_000,
        minMemoryGB: 28,
      },
    ],
  },
  {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    org: 'MiniMaxAI',
    output: 'video',
    blurb: 'Video from keyframes or a reference image — one download per job you want.',
    fast: true,
    /*
     * THE CLEAREST CASE OF the user's "one per like in-out you want". The repo holds
     * an FL2VA tree (First+Last frame → Video+Audio) and a Ref2VA tree
     * (Reference image → Video+Audio), each at eight quants, plus a shared
     * Qwen3-VL text encoder and the VAEs. Downloading "MiniMax H3" is not a
     * thing you can do; downloading "first + last frame → video, at Q4" is.
     *
     * Every size below is the quant plus the VAEs it needs. The text encoder is
     * another 13-18 GB on top and is shared between them, so it is its own row
     * rather than double-counted into both.
     */
    variants: [
      {
        repo: 'unsloth/MiniMax-H3-GGUF',
        label: 'Keyframes → video · Q2',
        note: 'First and last frame in, video out. The smallest way to try it.',
        allow: ['minimax_h3_fl2va_pruned-Q2_K.gguf', 'vae/*'],
        tasks: ['keyframes-to-video'],
        approxBytes: 12_540_000_000,
        minMemoryGB: 16,
      },
      {
        repo: 'unsloth/MiniMax-H3-GGUF',
        label: 'Keyframes → video · Q4',
        allow: ['minimax_h3_fl2va_pruned-Q4_K.gguf', 'vae/*'],
        tasks: ['keyframes-to-video'],
        approxBytes: 17_240_000_000,
        minMemoryGB: 24,
      },
      {
        repo: 'unsloth/MiniMax-H3-GGUF',
        label: 'Reference image → video · Q2',
        note: 'One image in, video out.',
        allow: ['minimax_h3_ref2va_pruned-Q2_K.gguf', 'vae/*'],
        tasks: ['image-to-video'],
        approxBytes: 12_500_000_000,
        minMemoryGB: 16,
      },
      {
        repo: 'unsloth/MiniMax-H3-GGUF',
        label: 'Reference image → video · Q4',
        allow: ['minimax_h3_ref2va_pruned-Q4_K.gguf', 'vae/*'],
        tasks: ['image-to-video'],
        approxBytes: 17_200_000_000,
        minMemoryGB: 24,
      },
      {
        repo: 'unsloth/MiniMax-H3-GGUF',
        label: 'Text encoder · Q2',
        note: 'Shared by both jobs above — you need one of these as well.',
        allow: ['qwen3vl_32b_minimax_h3-Q2_K_M.gguf'],
        approxBytes: 13_100_000_000,
        minMemoryGB: 16,
      },
    ],
  },
  // ── AUDIO ─────────────────────────────────────────────────────────────────
  {
    id: 'kokoro',
    name: 'Kokoro',
    org: 'hexgrad',
    output: 'audio',
    blurb: '82M parameters of speech that sounds like speech. The default voice.',
    fast: true,
    variants: [{ repo: 'hexgrad/Kokoro-82M', label: '82M', paramsB: 0.082, minMemoryGB: 2 }],
  },
  {
    id: 'qwen3-tts',
    name: 'Qwen3-TTS',
    org: 'Qwen',
    output: 'audio',
    blurb: 'Voice cloning and voice design, in two sizes.',
    variants: [
      { repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', label: '0.6B', paramsB: 0.6, minMemoryGB: 3 },
      { repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', label: '1.7B', paramsB: 1.7, minMemoryGB: 5 },
      {
        repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
        label: '1.7B Design',
        paramsB: 1.7,
        note: 'Describe a voice in words instead of cloning one.',
        minMemoryGB: 5,
      },
    ],
  },
  {
    id: 'stable-audio',
    name: 'Stable Audio 3',
    org: 'stabilityai',
    output: 'audio',
    blurb: 'Sound effects and short music beds from a text description.',
    variants: [
      { repo: 'stabilityai/stable-audio-3-small-sfx', label: 'small · SFX', minMemoryGB: 8 },
      { repo: 'stabilityai/stable-audio-3-medium', label: 'medium', minMemoryGB: 16 },
    ],
  },
  {
    id: 'ace-step',
    name: 'ACE-Step',
    org: 'ACE-Step',
    output: 'audio',
    blurb: 'Full songs — structure, vocals and all — from a prompt.',
    variants: [{ repo: 'ACE-Step/Ace-Step1.5', label: '1.5', paramsB: 3.5, minMemoryGB: 12 }],
  },

  // ── 3D ────────────────────────────────────────────────────────────────────
  {
    id: 'triposr',
    name: 'TripoSR',
    org: 'stabilityai',
    output: '3d',
    blurb: 'A mesh from one photo in seconds. Rough, but immediate.',
    fast: true,
    variants: [{ repo: 'stabilityai/TripoSR', label: 'base', paramsB: 0.5, minMemoryGB: 6 }],
  },
  {
    id: 'pixal3d',
    name: 'Pixal3D',
    org: 'Comfy-Org',
    output: '3d',
    blurb: 'Image to 3D in one pass, small enough to be the everyday choice.',
    fast: true,
    variants: [
      {
        repo: 'Comfy-Org/Pixal3D',
        label: 'int8',
        note: '5.6 GB — the one to start with.',
        allow: ['diffusion_models/pixal3d_int8_convrot.safetensors'],
        approxBytes: 5_600_000_000,
        minMemoryGB: 10,
        tasks: ['image-to-3d'],
      },
      {
        repo: 'Comfy-Org/Pixal3D',
        label: 'bf16',
        allow: ['diffusion_models/pixal3d_bf16.safetensors'],
        approxBytes: 11_000_000_000,
        minMemoryGB: 18,
        tasks: ['image-to-3d'],
      },
      {
        repo: 'Aero-Ex/Pixal3D-GGUF',
        label: 'GGUF (all stages)',
        note: 'Sparse, shape and texture stages as separate GGUFs.',
        approxBytes: 30_300_000_000,
        minMemoryGB: 24,
        tasks: ['image-to-3d'],
      },
    ],
  },
  {
    id: 'trellis',
    name: 'TRELLIS',
    org: 'microsoft',
    output: '3d',
    blurb: 'The quality tier for image-to-3D, and what the 3D Studio generates with.',
    variants: [
      { repo: 'microsoft/TRELLIS-image-large', label: 'v1 large', paramsB: 1.2, minMemoryGB: 10 },
      {
        repo: 'microsoft/TRELLIS.2-4B',
        label: 'v2 · 4B',
        paramsB: 4,
        note: 'PBR textures.',
        minMemoryGB: 18,
      },
    ],
  },
  {
    id: 'hunyuan3d',
    name: 'Hunyuan3D 2.1',
    org: 'tencent',
    output: '3d',
    blurb: 'The other strong image-to-3D line, with its own texture pass.',
    variants: [
      { repo: 'tencent/Hunyuan3D-2mini', label: 'mini', minMemoryGB: 10 },
      { repo: 'tencent/Hunyuan3D-2.1', label: '2.1', minMemoryGB: 18 },
    ],
  },
  {
    id: 'hy-motion',
    name: 'HY-Motion',
    org: 'tencent',
    output: '3d',
    blurb: 'Text to human motion — animation for a rigged character.',
    variants: [{ repo: 'tencent/HY-Motion-1.0', label: '1.0', minMemoryGB: 10 }],
  },
];

/**
 * HOW A FAMILY GETS ONTO THE DISK, which is not the same question for all of them.
 *
 * A text model is GGUF: the app's own downloader fetches one file, and the
 * Download button means exactly what it says. An image / video / audio / 3D
 * model is diffusers or safetensors weights that a generation backend loads
 * through its own cache, and it fetches them the first time you use it in its
 * studio. Those two are not the same button, and drawing them the same way is
 * how a Download that cannot work ends up on screen.
 *
 * Derived from the OUTPUT rather than stored per entry, because that is what
 * actually decides it: the exception people reach for — "but there is a GGUF of
 * MiniMax-H3" — is a video model in a GGUF container, which llama.cpp still
 * cannot run. The container is not the installer.
 */
export function installKindOf(family: RecommendedFamily): 'gguf' | 'gen' {
  return family.output === 'text' ? 'gguf' : 'gen';
}

/** The smallest variant's parameter count — what a family sorts by. */
export function familySizeB(family: RecommendedFamily): number {
  const sizes = family.variants
    .filter((v) => v.draftFor === undefined)
    .map((v) => v.paramsB)
    .filter((n): n is number => n !== undefined);
  return sizes.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...sizes);
}

/**
 * The families to show, small → large, optionally narrowed to one output.
 *
 * Families with no size at all (several image and video repos publish no
 * parameter count) sort LAST rather than first: an unknown is not a small, and
 * putting them at the top of a list whose promise is "smallest first" would
 * break the one rule the order is making.
 */
export function recommendedFamilies(
  outputs: readonly OutputModality[] = [],
): readonly RecommendedFamily[] {
  const shown =
    outputs.length === 0
      ? RECOMMENDED_FAMILIES
      : RECOMMENDED_FAMILIES.filter((f) => outputs.includes(f.output));
  return [...shown].sort((a, b) => familySizeB(a) - familySizeB(b) || a.name.localeCompare(b.name));
}

/** Every repo the curated list names — what the hub matches "downloaded" against. */
export function recommendedRepos(): readonly string[] {
  return RECOMMENDED_FAMILIES.flatMap((f) => f.variants.map((v) => v.repo));
}

/** The outputs that actually appear, for building the filter without hardcoding it. */
export function availableOutputs(): readonly OutputModality[] {
  const seen = new Set<OutputModality>();
  for (const f of RECOMMENDED_FAMILIES) seen.add(f.output);
  return (['text', 'image', 'video', 'audio', '3d'] as const).filter((o) => seen.has(o));
}
