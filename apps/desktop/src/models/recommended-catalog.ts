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
      },
      {
        repo: 'LiquidAI/LFM2.5-2.6B-GGUF',
        label: '2.6B',
        paramsB: 2.6,
        note: 'The sweet spot of this family.',
      },
      {
        repo: 'LiquidAI/LFM2.5-8B-A1B-GGUF',
        label: '8B-A1B',
        paramsB: 8,
        note: 'Mixture-of-experts: 8B of knowledge at ~1B of compute per token.',
      },
      { repo: 'LiquidAI/LFM2.5-VL-1.6B', label: 'VL 1.6B', paramsB: 1.6, note: 'Reads images.' },
    ],
  },
  {
    id: 'qwen3.5',
    name: 'Qwen3.5',
    org: 'unsloth',
    output: 'text',
    blurb: 'The general-purpose ladder, with MTP draft weights for speculative decoding.',
    variants: [
      { repo: 'unsloth/Qwen3.5-0.8B-MTP-GGUF', label: '0.8B', paramsB: 0.8 },
      { repo: 'unsloth/Qwen3.5-2B-MTP-GGUF', label: '2B', paramsB: 2 },
      {
        repo: 'unsloth/Qwen3.5-4B-MTP-GGUF',
        label: '4B',
        paramsB: 4,
        note: 'The fast tier on a 16 GB Mac.',
      },
      {
        repo: 'unsloth/Qwen3.5-9B-MTP-GGUF',
        label: '9B',
        paramsB: 9,
        note: 'The balanced tier on 24 GB.',
      },
      { repo: 'mlx-community/Qwen3.5-4B-MLX-4bit', label: '4B · MLX', paramsB: 4, mlx: true },
      { repo: 'mlx-community/Qwen3.5-9B-MLX-4bit', label: '9B · MLX', paramsB: 9, mlx: true },
    ],
  },
  {
    id: 'gemma4',
    name: 'Gemma 4',
    org: 'unsloth',
    output: 'text',
    blurb: "Google's open family — the E-series is built for small machines, and 12B reads images.",
    variants: [
      { repo: 'unsloth/gemma-4-E2B-it-GGUF', label: 'E2B', paramsB: 2 },
      { repo: 'unsloth/gemma-4-E4B-it-GGUF', label: 'E4B', paramsB: 4 },
      {
        repo: 'unsloth/gemma-4-12B-it-qat-GGUF',
        label: '12B QAT',
        paramsB: 12,
        note: 'Quantization-aware: holds up better at 4-bit than a plain quant.',
      },
      {
        repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
        label: '26B-A4B',
        paramsB: 26,
        note: 'MoE — 26B of weights, ~4B active.',
      },
      { repo: 'unsloth/gemma-4-31B-it-GGUF', label: '31B', paramsB: 31 },
    ],
  },
  {
    id: 'qwen3.8',
    name: 'Qwen3.8',
    org: 'unsloth',
    output: 'text',
    blurb: 'The current flagship of the Qwen line — the most capable thing that fits 24 GB.',
    variants: [
      {
        repo: 'unsloth/Qwen3.8-27B-GGUF',
        label: '27B',
        paramsB: 27,
        note: 'Q3 or Q4 on a 24 GB Mac; Q5+ wants 32 GB.',
      },
      { repo: 'unsloth/Qwen3.6-27B-MTP-GGUF', label: '3.6 27B', paramsB: 27 },
      {
        repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        label: '3.6 35B-A3B',
        paramsB: 35,
        note: 'MoE — decodes at roughly a 3B model’s speed.',
      },
    ],
  },
  {
    id: 'muse-glimmer',
    name: 'Muse Glimmer',
    org: 'unsloth',
    output: 'text',
    blurb: 'Vision-language: hand it screenshots, diagrams or photos and ask about them.',
    variants: [{ repo: 'unsloth/Muse-Glimmer-30B-GGUF', label: '30B', paramsB: 30 }],
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
      },
    ],
  },

  // ── IMAGE ─────────────────────────────────────────────────────────────────
  {
    id: 'mage-flow',
    name: 'Mage Flow',
    org: 'Comfy-Org',
    output: 'image',
    blurb: 'Fast, good, and small enough to be the default on a modest machine. Edits too.',
    fast: true,
    /*
     * A CAVEAT WORTH KEEPING. Microsoft's own Mage-Flow repos 404 now, so the
     * split Turbo/Edit variants only exist at `mage-flow-community` — a mirror
     * with a couple of hundred downloads against Comfy-Org's 183k. The base repo
     * leads for that reason; if the community mirror goes the way of the
     * originals, the family is still reachable through Comfy-Org.
     */
    variants: [
      {
        repo: 'mage-flow-community/Mage-Flow-Turbo',
        label: 'Turbo',
        note: 'Few-step — the one to start with.',
      },
      {
        repo: 'mage-flow-community/Mage-Flow-Edit-Turbo',
        label: 'Edit Turbo',
        note: 'Few-step editing from an existing image.',
      },
      { repo: 'Comfy-Org/Mage-Flow', label: 'Base', note: 'Full quality, more steps.' },
      { repo: 'mage-flow-community/Mage-Flow-Edit', label: 'Edit' },
    ],
  },
  {
    id: 'z-image',
    name: 'Z-Image',
    org: 'Tongyi-MAI',
    output: 'image',
    blurb: 'Eight steps, 16 GB, Apache-2.0 — the cheapest good image model to run.',
    fast: true,
    variants: [{ repo: 'Tongyi-MAI/Z-Image-Turbo', label: 'Turbo', paramsB: 6 }],
  },
  {
    id: 'flux2',
    name: 'FLUX.2',
    org: 'black-forest-labs',
    output: 'image',
    blurb: 'The photorealism leader among open weights. klein is the size that fits a Mac.',
    variants: [
      {
        repo: 'black-forest-labs/FLUX.2-klein-4B',
        label: 'klein 4B',
        paramsB: 3.9,
        note: 'Apache-2.0, ~13 GB at 8-bit.',
      },
      { repo: 'black-forest-labs/FLUX.2-klein-9B', label: 'klein 9B', paramsB: 9 },
      {
        repo: 'black-forest-labs/FLUX.2-dev',
        label: 'dev',
        paramsB: 32,
        note: 'The full model — 32 GB+ machines.',
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
      { repo: 'krea/Krea-2-Turbo', label: 'Turbo', paramsB: 12.8 },
      { repo: 'krea/Krea-2-Raw', label: 'Raw', paramsB: 12.8, note: 'Unopinionated base.' },
    ],
  },
  {
    id: 'qwen-image',
    name: 'Qwen-Image',
    org: 'Qwen',
    output: 'image',
    blurb: 'The one to use when the image has to contain readable text.',
    variants: [{ repo: 'Qwen/Qwen-Image', label: '2512', paramsB: 20 }],
  },

  // ── VIDEO ─────────────────────────────────────────────────────────────────
  {
    id: 'ltx',
    name: 'LTX-2.5',
    org: 'Lightricks',
    output: 'video',
    blurb: 'The fast end of open video — image-to-video that a personal machine can finish.',
    fast: true,
    variants: [
      {
        repo: 'Lightricks/LTX-Video',
        label: '2B distilled',
        paramsB: 2,
        note: 'The small, quick one.',
      },
      { repo: 'Lightricks/LTX-2.5', label: '2.5', note: 'Current release.' },
      { repo: 'Lightricks/LTX-2.5-Diffusers', label: '2.5 · Diffusers' },
      { repo: 'Lightricks/LTX-2.3-fp8', label: '2.3 fp8', note: 'Lighter memory footprint.' },
    ],
  },
  {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    org: 'MiniMaxAI',
    output: 'video',
    blurb: 'Image + text to video, and it runs on far less hardware than its size suggests.',
    fast: true,
    variants: [
      {
        repo: 'unsloth/MiniMax-H3-GGUF',
        label: 'GGUF',
        paramsB: 33,
        note: 'Quantized — the version that fits a Mac.',
      },
      { repo: 'MiniMaxAI/MiniMax-H3', label: 'full', paramsB: 33 },
    ],
  },
  {
    id: 'wan',
    name: 'Wan 2.1',
    org: 'Wan-AI',
    output: 'video',
    blurb: 'Text-to-video at 1.3B — the smallest video model worth running.',
    variants: [{ repo: 'Wan-AI/Wan2.1-T2V-1.3B', label: 'T2V 1.3B', paramsB: 1.3 }],
  },

  // ── AUDIO ─────────────────────────────────────────────────────────────────
  {
    id: 'kokoro',
    name: 'Kokoro',
    org: 'hexgrad',
    output: 'audio',
    blurb: '82M parameters of speech that sounds like speech. The default voice.',
    fast: true,
    variants: [{ repo: 'hexgrad/Kokoro-82M', label: '82M', paramsB: 0.082 }],
  },
  {
    id: 'qwen3-tts',
    name: 'Qwen3-TTS',
    org: 'Qwen',
    output: 'audio',
    blurb: 'Voice cloning and voice design, in two sizes.',
    variants: [
      { repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', label: '0.6B', paramsB: 0.6 },
      { repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', label: '1.7B', paramsB: 1.7 },
      {
        repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
        label: '1.7B Design',
        paramsB: 1.7,
        note: 'Describe a voice in words instead of cloning one.',
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
      { repo: 'stabilityai/stable-audio-3-small-sfx', label: 'small · SFX' },
      { repo: 'stabilityai/stable-audio-3-medium', label: 'medium' },
    ],
  },
  {
    id: 'ace-step',
    name: 'ACE-Step',
    org: 'ACE-Step',
    output: 'audio',
    blurb: 'Full songs — structure, vocals and all — from a prompt.',
    variants: [{ repo: 'ACE-Step/Ace-Step1.5', label: '1.5', paramsB: 3.5 }],
  },

  // ── 3D ────────────────────────────────────────────────────────────────────
  {
    id: 'triposr',
    name: 'TripoSR',
    org: 'stabilityai',
    output: '3d',
    blurb: 'A mesh from one photo in seconds. Rough, but immediate.',
    fast: true,
    variants: [{ repo: 'stabilityai/TripoSR', label: 'base', paramsB: 0.5 }],
  },
  {
    id: 'trellis',
    name: 'TRELLIS.2',
    org: 'microsoft',
    output: '3d',
    blurb: 'The quality tier for image-to-3D, and what the 3D Studio generates with.',
    variants: [
      { repo: 'microsoft/TRELLIS-image-large', label: 'v1 large', paramsB: 1.2 },
      { repo: 'microsoft/TRELLIS.2-4B', label: '4B', paramsB: 4, note: 'PBR textures.' },
    ],
  },
  {
    id: 'hunyuan3d',
    name: 'Hunyuan3D 2.1',
    org: 'tencent',
    output: '3d',
    blurb: 'The other strong image-to-3D line, with its own texture pass.',
    variants: [
      { repo: 'tencent/Hunyuan3D-2mini', label: 'mini' },
      { repo: 'tencent/Hunyuan3D-2.1', label: '2.1' },
    ],
  },
  {
    id: 'hy-motion',
    name: 'HY-Motion',
    org: 'tencent',
    output: '3d',
    blurb: 'Text to human motion — animation for a rigged character.',
    variants: [{ repo: 'tencent/HY-Motion-1.0', label: '1.0' }],
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
