/**
 * The modality catalog — the verified, Apple-Silicon-filtered set of generation
 * models (round-13 research), typed so the model viewer + the pi generate tool
 * can enumerate what runs, on which backend, and under which license.
 *
 * Phase 1 ships the IMAGE entries as fully wired (mflux/MLX, verified on this M5
 * Pro). Audio / video / 3d entries are RESERVED — present so the catalog shape,
 * the license-gating, and the modality enumeration are complete and tested now,
 * but marked `{ reserved: true }` until their backends land in later phases.
 *
 * License gating is first-class: `commercialUse=false` marks NC / community-EULA
 * weights (Voxtral CC-BY-NC, LTX-2 Community, Tencent community, …) that the
 * installer must gate and never auto-enable for commercial use.
 */
import type { Backend, ComfyBackendConfig, Modality } from './protocol.js';

/** SPDX-ish license id (the ones the round-13 catalog actually uses). */
export type License =
  | 'apache-2.0'
  | 'mit'
  | 'cc-by-nc-4.0'
  // Use-restriction / community EULA families that still gate commercial use:
  | 'openrail' // cubepart (Roblox) — OpenRAIL use-restrictions
  | 'nvidia-nc' // LocateAnything (NVIDIA) — non-commercial
  | 'gemma' // EmbeddingGemma (Google) — Gemma terms EULA
  | 'ltx-2-community'
  | 'tencent-community'
  | 'minimax-community'
  | 'stability-community'
  | 'research-nc';

/** mflux console entrypoint per image family — the unified `mflux-generate` only
 * drives the FLUX pipeline, so Z-Image / FLUX.2 / Qwen need their DEDICATED
 * command (verified: `mflux-generate --model z-image-turbo` mis-routes to FLUX
 * weight loading and fails; `mflux-generate-z-image-turbo` is required). */
export interface MfluxBackendConfig {
  readonly kind: 'mflux';
  /** Console script to spawn (e.g. `mflux-generate-z-image-turbo`). */
  readonly command: string;
  /** `--model` arg when the command multiplexes families (flux2 variants, schnell/dev). */
  readonly model?: string;
  /**
   * `--base-model`: the built-in family a third-party repo or a local folder
   * is a checkpoint of (`qwen-image-2.1`), so mflux does not have to guess it
   * from the folder's name.
   */
  readonly baseModel?: string;
  /**
   * A BUNDLED mflux BUILD this model runs on instead of the pinned release:
   * the file name of a wheel in `python/wheels/` (packages/gen-service, shipped
   * beside worker.py), handed to `uv run --with` in place of `mflux==<pin>`.
   *
   * Qwen-Image 2.1 runs on the port that is still a pull request
   * (mflux-community/mflux#736) plus the one patch that lets its text encoder
   * be quantized — `python/mflux-qwen21/` holds the patch and the build script.
   * A wheel and not a git URL, so a picture never depends on GitHub, a fork
   * or a build backend being reachable, and the bytes are the tested ones.
   */
  readonly wheel?: string;
  /**
   * The weights are MADE ON THIS MAC, once: `mflux-save` quantizes the bf16
   * release into a folder in the library, and `--model` is that folder. For a
   * model nobody has published pre-quantized in mflux's own layout — every
   * "MLX 4-bit" Qwen-Image 2.1 repo on the hub is another runtime's tensor
   * naming, which mflux cannot read. Publishing ours makes this a plain
   * download (`model` = the repo); until then the conversion is the download.
   */
  readonly prepared?: PreparedWeights;
}

/** A local conversion: what is fetched, what it becomes, what each costs. */
export interface PreparedWeights {
  /** The bf16 Hugging Face repo the conversion reads (the official release). */
  readonly from: string;
  /** The repo files it needs — `*` globs, the store's `allow` (mflux's own download patterns). */
  readonly patterns: readonly string[];
  /** The folder the quantized model is saved to, under the modality's shelf. */
  readonly folder: string;
  /** mflux `-q` for the save. */
  readonly bits: 4 | 8;
  /** What is fetched, GB — gone again once the conversion has landed. */
  readonly downloadGB: number;
  /** What stays, GB. */
  readonly sizeGB: number;
}

/** A catalog entry for one generation model. */
/** One file a graph loads: the repo it is fetched from and its path there. */
export interface WeightFile {
  readonly repo: string;
  readonly path: string;
  /** Bytes, when the repo tree has been read (the download prompt's copy). */
  readonly bytes?: number;
  /**
   * The ComfyUI type folder a file with no folder of its own belongs in.
   * Comfy-Org lays a repo out as ComfyUI reads it (`vae/…`, `diffusion_models/…`);
   * the GGUF conversions are one file at the repo root, and ComfyUI finds a
   * loader's name only inside a type folder — so such a file is shelved as
   * `<org__repo>/<folder>/<name>` once it has landed.
   */
  readonly folder?: 'unet' | 'diffusion_models' | 'text_encoders' | 'clip' | 'vae';
}

export interface ModalityModel {
  /** Stable catalog id (what the tool/app references). */
  readonly id: string;
  readonly modality: Modality;
  readonly label: string;
  readonly backend: Backend;
  /** HuggingFace repo (provenance / download surfacing). */
  readonly repo?: string;
  /**
   * The RESOLVED HF repo id passed to mlx-audio `--model` when it differs from the
   * provenance {@link repo}. Kokoro's card is `hexgrad/Kokoro-82M` (provenance)
   * but mlx-audio loads `prince-canuma/Kokoro-82M`. When omitted, the app resolves
   * `--model` from `repo`. Only meaningful for `mlx-audio` backend entries.
   */
  readonly mlxAudioModel?: string;
  readonly license: License;
  /** Whether the license permits commercial use without a gate. Drives install-EULA gating. */
  readonly commercialUse: boolean;
  /** Approx on-disk size (GB) at the listed quantization. */
  readonly approxSizeGB: number;
  /**
   * Peak RESIDENT size (GB), MEASURED — whichever side of the download it lands.
   *
   * Below it for a staged pipeline: ComfyUI loads a text encoder, encodes,
   * frees it, and only then loads the transformer, so a 36GB download can peak
   * at 20GB. Above it for a single-pass image model, whose activations scale
   * with the picture: FLUX.2 klein is 4.3GB on disk and 12.4GB at 1024². For
   * image models it is the 1024² figure, and admission scales it by the pixels
   * actually asked for (`jobFootprintGB`).
   *
   * Set this ONLY from a measured run — it is what decides whether a job is
   * admitted right now (the guardian's `fits`) and what a machine is offered,
   * and guessing it low is exactly the swap-storm this exists to prevent.
   */
  readonly peakResidentGB?: number;
  /**
   * What the job costs BEFORE activations — weights, encoder, VAE and the
   * runtime, resident together — MEASURED as the OS's own free-memory drop.
   * With `peakResidentGB` (the 1024² figure) it fixes the line admission
   * scales along; absent, the download size stands in, which is too low for
   * any model that loads an encoder beside its weights.
   */
  readonly residentFloorGB?: number;
  /**
   * Minimum unified-memory (GB) hint to hold this entry at its listed quant
   * (≈ weights + ~1GB headroom). The model manager uses it to auto-prefer the
   * GGUF/MLX tier a machine can hold and to hide tiers it can't. Advisory, not a
   * hard gate.
   */
  readonly minUnifiedMemoryGB?: number;
  /** Runs locally on Apple Silicon (Metal/MLX). `false` → remote-GPU only. */
  readonly runsLocally: boolean;
  /**
   * Heavy = must hold the unified-memory budget mostly to itself; the JobQueue
   * serialises heavy jobs (one at a time). Light models may run alongside.
   */
  readonly heavy: boolean;
  /** Extra `uv --with` deps beyond the base backend package (e.g. codecs). */
  readonly auxDeps?: readonly string[];
  /** mflux wiring (image phase-1 models only). */
  readonly mflux?: MfluxBackendConfig;
  /** ComfyUI wiring (`comfyui`-backed video / music / advanced-image entries). */
  readonly comfy?: ComfyBackendConfig;
  /**
   * THE FILES THE GRAPH LOADS, and where an UNGATED copy of each lives.
   *
   * A ComfyUI graph names its weights by file name and finds them by type
   * folder; this is the list that puts them there. Every repo here can be
   * fetched with no Hugging Face account — a gated source is not "one click"
   * — so where the official release is gated (Lightricks/LTX-2.5) a mirror
   * that carries the same bytes is named instead. Each file lands on its
   * shelf as `<library>/<shelf>/<org__repo>/<path>`, the model store's own
   * layout, and ComfyUI is pointed at every such folder.
   */
  readonly weights?: readonly WeightFile[];
  /** Sensible default denoising steps for this model. */
  readonly defaultSteps?: number;
  /**
   * `false` ⇒ never ask the worker for per-step preview frames, whatever the
   * machine has. The frames are a VAE decode at every step, and for a 64-channel
   * VAE at 1024² that is not the ~4.5 GB klein's costs: MEASURED for Qwen-Image
   * 2.1 (2026-09-20), the same job with previews took 181 s instead of 97, the
   * MLX peak went 5.96 → 20.45 GB and the OS's free memory fell to 6% — a run
   * the guardian would shed for a card animation. The pending card plays the
   * mark instead, as it does for a ComfyUI graph. Absent means the admission
   * decides, as before.
   */
  readonly previews?: false;
  /** Default quantization to request (mflux `-q`). */
  readonly defaultQuantize?: 3 | 4 | 5 | 6 | 8;
  /** RESERVED entry: enumerated + gated now, backend lands in a later phase. */
  readonly reserved?: boolean;
  /**
   * Vetted first-class pick for its modality — renders the green "recommended"
   * sparkle and heads its category's Recommended-first grid in the model browser.
   * Explicit and independent of gating/reserved (a recommended pick can still be
   * gated or await its backend). The browser MAY also treat any
   * `!reserved && runsLocally` entry as implicitly recommended (see
   * {@link activeModels}); this flag is the explicit override.
   */
  readonly recommended?: boolean;
  readonly notes?: string;
}

/**
 * The catalog. Ordered image-first; the first image entry is the app default.
 * Newer/heavier variants and reserved modalities follow.
 */
export const MODALITY_CATALOG: readonly ModalityModel[] = [
  // ---- IMAGE (mflux fast-paths: active + verified) ----------------------
  // ---- IMAGE · THE DEFAULT: Qwen-Image 2.1 on MLX -------------------------
  {
    /*
     * THE DEFAULT PICTURE MODEL. The user (2026-09-20): "this is a really strong
     * new model … if possible to make this runnable at Q4 with
     * comparable/better quality to what currently runs at that speed, make
     * that the new normal/default." And, the same day: "it may be worth
     * attempting a dedicated mac inference engine since this will likely be
     * the top tier model for its weight class for consumer machines for quite
     * a while to come." This entry is that engine: the MLX port.
     *
     * Qwen-Image-2.1: a 7B single-stream DiT (32 layers) conditioned on the
     * full Qwen3-VL-8B, guidance-free (cfg 1), native 2K, text rendering the
     * fast models cannot match. It ran here first through ComfyUI with GGUFs
     * (comfy-workflow.ts still carries that graph): 94 s at 12 steps, but ~15
     * GB at the DiT load because MPS holds a GGUF dequantized — a 32 GB
     * machine's job, shed by the guardian on 24. MLX keeps the weights
     * quantized, and that is the whole difference:
     *
     * MEASURED 2026-09-20 (M5 Pro 24 GB, mflux port at 4 bits, DiT AND
     * encoder, `--low-ram`, no previews, a 4B chat model resident):
     *   1024²  24 steps   97 s   3.55 s/step   MLX peak 5.96 GB   OS free 57% → 26% (≈7.4 GB)
     *    768²  24 steps   49 s   1.8 s/step    MLX peak 5.86 GB
     *   1024²  24 steps   88 s   3.38 s/step   on an idle machine
     *   8 bits: 94 s, 3.6 s/step, 8.8 GB peak — no faster, so 4 bits is the
     *   shape that ships, with the recipe below.
     * Steps: 12 comes out garbled on this port (the schedule, not the
     * quantization — a bf16 encoder gave the same), 20 slightly broken, 24
     * clean; the card's own 40 is a quality knob, not a floor. On the same
     * seven prompts as the fast models: the poster's two lines of text and
     * the flowchart's three labels exact, portraits and the watch movement
     * photoreal, the flat fox clean — the pictures are in the memory notes.
     *
     * THE RECIPE — a 4-bit DiT, an 8-bit text encoder. Ten prompts with a
     * word in the picture at one seed, the app's own neon sign at three and
     * a poster at one: with everything at 4 bits the DiT rendered every
     * word it was conditioned on, but the 4-bit ENCODER flipped a letter in
     * about one in ten ("BOBBBLE"); protecting a few of its layers (the
     * token embeddings, mflux's img_mod-style modulation guard on the DiT)
     * moved the failure to another prompt ("VISIT" without its "KYOTO")
     * rather than removing it; the encoder at 8 bits beside the 4-bit DiT
     * rendered all of them, like the all-8-bit model. It costs disk only —
     * 13 GB instead of 9 — because the encoder is one pass, evicted before
     * the DiT loads (`--low-ram`), and its weights are file-backed pages the
     * OS drops freely: MLX peak 5.96 GB and the free-memory drop are the
     * uniform 4-bit model's. The wheel's predicate does this under `-q 4`;
     * a saved model records per-layer precision in its shapes, so the
     * loader needs nothing further.
     *
     * WHAT IT COSTS TO HAVE. Nobody has published this model pre-quantized in
     * mflux's layout (the hub's "MLX 4-bit" repos are another runtime's
     * tensor names), so the first use fetches the 31 GB bf16 release and
     * `mflux-save`s it to 13 GB here — MEASURED 18 s of conversion on this
     * Mac, the bf16 files removed after. Publishing our folder turns that
     * into a 13 GB download (`mflux.model` = the repo, `prepared` dropped).
     *
     * THE BUILD. The port is mflux-community/mflux#736, an open pull request,
     * and it keeps the encoder in bf16 (17.5 GB — the author measured on a
     * 64 GB machine). The wheel in python/wheels/ is that commit plus the
     * patch that lets the encoder quantize with the DiT and applies the
     * recipe; see python/mflux-qwen21/. Every other mflux model stays on the
     * pinned release.
     *
     * LICENSE: the Qwen Research License is NON-COMMERCIAL (research and
     * evaluation); a commercial licence is a separate request to Qwen. The
     * card says so, and klein below is the Apache pick for anyone who needs it.
     */
    id: 'qwen-image-2.1',
    modality: 'image',
    label: 'Qwen-Image 2.1',
    backend: 'mflux',
    repo: 'Qwen/Qwen-Image-2.1',
    license: 'research-nc',
    commercialUse: false,
    // What stays on disk after the conversion; the 31 GB fetched is transient.
    approxSizeGB: 13,
    minUnifiedMemoryGB: 16,
    // THE NUMBERS ADMISSION READS — the OS's own free-memory drop across a
    // 1024² run (above), not the MLX figure: a floor under the weights, the
    // encoder pass and the runtime, and the 1024² peak a little above the
    // measured 7.4 GB so a noisy sample does not admit a swap.
    residentFloorGB: 5,
    peakResidentGB: 7.5,
    runsLocally: true,
    heavy: true, // serial — see the klein entry
    recommended: true,
    mflux: {
      kind: 'mflux',
      command: 'mflux-generate-qwen-2.1',
      baseModel: 'qwen-image-2.1',
      wheel: 'mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl',
      prepared: {
        from: 'Qwen/Qwen-Image-2.1',
        // mflux's own download patterns for the family, plus the tokenizer.
        patterns: [
          'transformer/*',
          'text_encoder/*',
          'vae/*',
          'processor/*',
          'model_index.json',
          'scheduler/*',
        ],
        // The folder names the recipe (te8 = the 8-bit text encoder): a
        // plain `-4bit` save from before (2026-09-20) is not this model.
        folder: 'qwen-image-2.1-mflux-4bit-te8',
        bits: 4,
        downloadGB: 31,
        sizeGB: 13,
      },
    },
    defaultSteps: 24,
    // The 64-channel VAE decoded at every step: +14 GB and twice the time (see
    // ModalityModel.previews). The card plays the mark.
    previews: false,
    notes:
      'Default. Qwen-Image-2.1 (7B DiT at 4 bits, Qwen3-VL-8B encoder at 8) on MLX (mflux port): 97 s/1024² and 49 s/768² at 24 steps, ~6 GB MLX peak, ~7.4 GB of the machine (MEASURED 2026-09-20, M5 Pro 24GB); every words-in-picture prompt exact where a 4-bit encoder flipped one letter in ten. Converted on this Mac from the 31 GB bf16 release, once (18 s). Research licence: non-commercial.',
  },
  {
    id: 'flux2-klein-4b',
    modality: 'image',
    label: 'FLUX.2 klein (4B)',
    backend: 'mflux',
    repo: 'black-forest-labs/FLUX.2-klein-4B',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4.3,
    /*
     * MEASURED, not derived from the download size (2026-08-25, M5 Pro 24GB).
     * The 4-bit weights are 4.3GB on disk, but a job's PEAK is activations, and
     * activations scale with the picture:
     *
     *   512²   4 steps   3.6s   MLX peak  4.95 GB
     *   1024²  4 steps   8.4s   MLX peak 12.37 GB
     *
     * The old `6` described the weights sitting still. The app's default size is
     * 1024², so 12.4GB plus the OS and this app is the floor a machine actually
     * needs — and this number is what the model card's RAM verdict reads, so a
     * 6 here told someone with 8GB they were fine.
     *
     * …and 16 told someone with 16GB they were fine, from the same MLX figure.
     * The OS-level measurement below puts 1024² at ~19GB of the machine's own
     * free memory, so the honest hint for the default size is 24. A 16GB Mac
     * still has Z-Image at 3.5GB, which is why that one is recommended too.
     */
    minUnifiedMemoryGB: 24,
    /*
     * THE NUMBERS ADMISSION READS — and they are NOT the MLX peaks above.
     *
     * MEASURED 2026-09-11 (M5 Pro 24GB) as the drop in `kern.memorystatus_level`
     * — the OS's own free memory, the figure jetsam steers by — while the job
     * ran under a watchdog (tests: /tmp/measure-mflux.sh):
     *
     *   512²   RSS 3.65 GB   OS free 84% → 43%   ≈ 10.5 GB taken
     *   768²                 OS free 84% → 29%   ≥ 14 GB, still falling at the cut
     *
     * Twice that day the studio ran this model with 20 GB "available" and the
     * OS went critical (51,457 pages/s of swap) within ten seconds; the guardian
     * cancelled both. The MLX active-memory peaks (4.95 / 12.4 GB) are real but
     * measure the wrong thing: wired GPU allocations do not show in RSS and the
     * encoder and runtime sit beside them. Fitting the two points: a ~7.7 GB
     * floor plus ~10.7 GB per megapixel, so ~19 GB at 1024² — which is why 1024²
     * could not be admitted beside a 6 GB reserve on a 24 GB machine.
     *
     * THEN `--low-ram` (2026-09-12, same machine, same method, no previews):
     *
     *   512²   OS free 82% → 60%   ≈ 4.8 GB   10.4 s   (plain the same day: 9.1 GB, 11.8 s)
     *   768²             80% → 60%   ≈ 4.8 GB   12.9 s
     *   1024²            80% → 56%   ≈ 5.8 GB   16.7 s
     *
     * Identical pixels, no slower, a third of the memory at the default size —
     * so every job runs that way (ImageJobSpec.lowRam) and THESE are the
     * numbers admission reads: a ~4.5 GB floor plus ~1.5 GB per megapixel.
     * The user: "low can't stop image generation requests, it just has to lessen
     * compute intensivity in some way sacrificing speed to keep headroom" —
     * this is the memory half of that; the pace is the compute half.
     */
    residentFloorGB: 4.5,
    peakResidentGB: 6,
    runsLocally: true,
    /*
     * ONE AT A TIME. Image models were "light" from the days of the 4.95 GB MLX
     * peak; the OS-level cost is 5-8 GB even with --low-ram, and SEEN (the
     * children's book, eight pictures asked for at once): two klein jobs
     * admitted side by side took the machine to swapping at 16% free and both
     * were shed. On unified memory two pictures at once are not faster
     * anyway — they share one GPU — so every image model is heavy: serial.
     */
    heavy: true,
    recommended: true,
    // Correction #1: point --model at the PRE-QUANTIZED 4-bit mflux repo and do
    // NOT pass -q (mflux expects the pre-quant weights, not on-the-fly quantize).
    mflux: {
      kind: 'mflux',
      command: 'mflux-generate-flux2',
      model: 'RunPod/FLUX.2-klein-4B-mflux-4bit',
    },
    defaultSteps: 4,
    notes:
      'Fast pick, Apache (the commercial-use default). mflux auto-fetches text-enc+VAE (no manual aux). Pre-quantized 4-bit mflux repo (no on-the-fly -q). 3.6s/512² (4.95GB peak) · 8.4s/1024² (12.4GB peak) ALONE [measured 2026-08-25]. Alongside a resident 9B chat model on 24GB, 1024² swaps: ~2min/step.',
  },
  {
    id: 'z-image-turbo',
    modality: 'image',
    label: 'Z-Image Turbo',
    backend: 'mflux',
    repo: 'Tongyi-MAI/Z-Image-Turbo',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 3.5,
    /*
     * MEASURED 2026-09-11 (M5 Pro 24GB) as the drop in the OS's own free
     * memory under a watchdog, like FLUX.2 klein above:
     *
     *   512²    RSS 5.3 GB   OS free 85% → 44%   ≈ 10.5 GB taken, 9.2 s
     *   1024²                OS free 85% → 29%   ≥ 14.4 GB and still loading
     *                                            when the watchdog cut it
     *
     * The 1024² figure is a lower bound, so the peak here is set above it. The
     * old hint of 5 GB described the download; the job is three times that.
     */
    /*
     * …and with `--low-ram` (2026-09-12, same method, no previews): 512² took
     * 5.8 GB (80% → 56%), 1024² 3.8 GB (81% → 65%) — the drop is noisy to about
     * a gigabyte, so the larger figure is the floor and the peak sits just
     * above it. Every job runs low-RAM now (see the klein entry).
     */
    residentFloorGB: 6,
    peakResidentGB: 6.5,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true, // serial — see the klein entry
    recommended: true,
    // Correction #1: dedicated command REQUIRED (unified mflux-generate mis-routes
    // Z-Image → FLUX loader). --model points at the PRE-QUANTIZED 4-bit repo; no -q.
    mflux: {
      kind: 'mflux',
      command: 'mflux-generate-z-image-turbo',
      model: 'filipstrand/Z-Image-Turbo-mflux-4bit',
    },
    defaultSteps: 8,
    notes:
      'Fast / smoke model. Few-step turbo; seconds per 1024. Pre-quantized 4-bit mflux repo (no on-the-fly -q). Verified end-to-end on M5 Pro.',
  },
  {
    id: 'qwen-image-2512',
    modality: 'image',
    label: 'Qwen-Image 2512',
    backend: 'mflux',
    repo: 'Qwen/Qwen-Image',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 24,
    minUnifiedMemoryGB: 24,
    runsLocally: true,
    heavy: true,
    // Superseded by Qwen-Image 2.1 above (a third of the memory, better
    // pictures); on the user's Mac this 40 GB download never completed — 18 GB
    // of .incomplete blobs from 2026-09-11 were what was on disk.
    recommended: false,
    mflux: { kind: 'mflux', command: 'mflux-generate-qwen' },
    defaultSteps: 20,
    defaultQuantize: 4,
    notes: 'Quality tier. ~24GB 4-bit — tight on 24GB unified memory; runs one-at-a-time (heavy).',
  },
  {
    id: 'flux1-schnell',
    modality: 'image',
    label: 'FLUX.1 schnell',
    backend: 'mflux',
    repo: 'black-forest-labs/FLUX.1-schnell',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 8,
    minUnifiedMemoryGB: 10,
    runsLocally: true,
    heavy: true, // serial — see the klein entry
    mflux: { kind: 'mflux', command: 'mflux-generate', model: 'schnell' },
    defaultSteps: 4,
    defaultQuantize: 4,
    notes: 'Proven fallback (unified mflux-generate FLUX pipeline).',
  },
  {
    id: 'flux1-dev-gguf',
    modality: 'image',
    label: 'FLUX.1-dev GGUF Q6_K (advanced)',
    backend: 'comfyui',
    repo: 'city96/FLUX.1-dev-gguf',
    // Correction #8: FLUX.1 [dev] is NON-COMMERCIAL, not Apache. Gate it.
    license: 'cc-by-nc-4.0',
    commercialUse: false,
    approxSizeGB: 10,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'flux1-dev-gguf-q6k', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        width: '5.inputs.width',
        height: '5.inputs.height',
        steps: '17.inputs.steps',
        guidance: '26.inputs.guidance',
        seed: '25.inputs.noise_seed',
      },
    },
    notes:
      'Advanced ComfyUI graph (Q6_K + ControlNet/upscale) beyond what mflux one-shots. Q6_K sweet spot, <=6% loss [measured, community]. FLUX.1 [dev] weights are NON-COMMERCIAL (CC BY-NC) — gated, never auto-enabled for commercial use. fp8 checkpoints gated OFF on darwin. Reserved until the ComfyUI backend (Phase A/B) lands. Workflow id/node paths [fwd].',
  },

  // ---- AUDIO · TTS (mlx-audio fast-path: active, NOT ComfyUI) ------------
  {
    id: 'qwen3-tts-1.7b',
    modality: 'audio',
    label: 'Qwen3-TTS (1.7B)',
    backend: 'mlx-audio',
    repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4.5,
    minUnifiedMemoryGB: 6,
    runsLocally: true,
    heavy: false,
    recommended: true,
    notes:
      'Default TTS: Apache, self-contained codec, 3s zero-shot voice clone (--ref_audio). MLX fast-path (uv worker run_audio), NOT ComfyUI. Base uv --with is mlx-audio (per backend).',
  },
  {
    id: 'qwen3-tts-0.6b',
    modality: 'audio',
    label: 'Qwen3-TTS (0.6B, light)',
    backend: 'mlx-audio',
    repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 2.5,
    minUnifiedMemoryGB: 4,
    runsLocally: true,
    heavy: false,
    recommended: true,
    notes:
      'Lighter default TTS: Apache, self-contained codec, 3s zero-shot voice clone (--ref_audio). MLX fast-path (mlx-audio 0.4.5 run_audio), NOT ComfyUI.',
  },
  {
    id: 'kokoro-82m',
    modality: 'audio',
    label: 'Kokoro-82M',
    backend: 'mlx-audio',
    // Correction #7: provenance card is hexgrad/Kokoro-82M, but the resolved
    // mlx-audio --model must be prince-canuma/Kokoro-82M (+ the misaki[en] G2P
    // extra, without which the KokoroPipeline import fails).
    repo: 'hexgrad/Kokoro-82M',
    mlxAudioModel: 'prince-canuma/Kokoro-82M',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 0.3,
    minUnifiedMemoryGB: 2,
    runsLocally: true,
    heavy: false,
    recommended: true,
    auxDeps: ['misaki[en]'],
    notes:
      'Fast TTS: tiny (0.3GB) narration presets (no clone), ~1500 words <1min [measured]. Resolved --model = prince-canuma/Kokoro-82M (+ misaki[en] aux). MLX fast-path, NOT ComfyUI.',
  },
  {
    id: 'voxtral-4b-tts',
    modality: 'audio',
    label: 'Voxtral 4B TTS',
    backend: 'mlx-audio',
    repo: 'mistralai/Voxtral-4B-TTS-2603',
    license: 'cc-by-nc-4.0',
    commercialUse: false,
    approxSizeGB: 8,
    minUnifiedMemoryGB: 10,
    runsLocally: true,
    heavy: false,
    notes:
      'Quality TTS — NON-COMMERCIAL (CC BY-NC), gated. Audio encoder withheld → presets-only unless clone repo added. MLX fast-path, NOT ComfyUI.',
  },
  {
    id: 'moss-ttsd-8b',
    modality: 'audio',
    label: 'MOSS-TTSD (8B, dialogue)',
    backend: 'mlx-audio',
    repo: 'mlx-community/MOSS-TTS-8B-8bit',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 9,
    minUnifiedMemoryGB: 12,
    runsLocally: true,
    heavy: false,
    recommended: true,
    notes:
      'Dialogue / podcast TTS (multi-speaker), 20 langs, 3-10s zero-shot voice clone (--ref_audio). 8-bit; provenance OpenMOSS-Team/MOSS-TTSD. MLX fast-path (mlx-audio 0.4.5), NOT ComfyUI. [Re-confirm exact 8-bit repo id/version at build — v1.0 changelog vs v0.5 live-API.]',
  },
  {
    id: 'moss-tts-local-1.7b',
    modality: 'audio',
    label: 'MOSS-TTS Local (1.7B)',
    backend: 'mlx-audio',
    repo: 'OpenMOSS-Team/MOSS-TTS',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4,
    minUnifiedMemoryGB: 6,
    runsLocally: true,
    heavy: false,
    notes:
      'Light single-speaker MOSS (MossTTSLocal); mlx-audio quantizes on load. Apache, no gate. MLX fast-path, NOT ComfyUI.',
  },
  {
    id: 'dia-1.6b',
    modality: 'audio',
    label: 'Dia (1.6B, expressive)',
    backend: 'mlx-audio',
    repo: 'mlx-community/Dia-1.6B',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 3,
    minUnifiedMemoryGB: 5,
    runsLocally: true,
    heavy: false,
    recommended: true,
    notes:
      'Expressive dialogue TTS with zero-shot voice clone via --ref_audio (demo model). Provenance nari-labs/Dia-1.6B. MLX fast-path (mlx-audio 0.4.5), NOT ComfyUI.',
  },
  {
    id: 'chatterbox',
    modality: 'audio',
    label: 'Chatterbox (voice clone)',
    backend: 'torch-tts',
    repo: 'ResembleAI/chatterbox',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 1,
    minUnifiedMemoryGB: 3,
    runsLocally: true,
    heavy: false,
    reserved: true,
    notes:
      'Best-quality zero-shot clone tier, SLOWER: torch/MPS→CPU fork (NOT the mlx-audio CLI). Perth WATERMARK embedded in ALL output. MIT, no gate. Reserved until the torch-tts worker path lands.',
  },

  // ---- AUDIO · Music / SFX (ComfyUI native core nodes; reserved) --------
  {
    id: 'ace-step',
    modality: 'audio',
    label: 'ACE-Step (3.5B)',
    backend: 'comfyui',
    // Correction #3: ACE-Step/ACE-Step (org) is a 401 — the weights repo is
    // ACE-Step/ACE-Step-v1-3.5B.
    repo: 'ACE-Step/ACE-Step-v1-3.5B',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 7,
    minUnifiedMemoryGB: 8,
    runsLocally: true,
    heavy: true,
    reserved: true,
    recommended: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ace-step-music', // [fwd]
      paramMap: {
        prompt: '14.inputs.tags',
        lyrics: '14.inputs.lyrics',
        seconds: '17.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Default music/SFX via native ComfyUI nodes (EmptyAceStepLatentAudio / TextEncodeAceStepAudio / SaveAudio). Apache, no gate. Loader auto-selects MPS; functional, slower on Mac [measured, qualitative]. Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },
  {
    id: 'stable-audio-open',
    modality: 'audio',
    label: 'Stable Audio Open 1.0',
    backend: 'comfyui',
    repo: 'stabilityai/stable-audio-open-1.0',
    license: 'stability-community',
    commercialUse: false,
    approxSizeGB: 5,
    minUnifiedMemoryGB: 6,
    runsLocally: true,
    heavy: false,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'stable-audio-open', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        seconds: '11.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Quality/SFX music via native ComfyUI nodes (+t5_base). Correction #9: Stability Community license is NOT flat NC — free commercial UNDER $1M revenue, GATED above. commercialUse:false marks the gate (EULA on install). Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },
  {
    id: 'stable-audio-open-small',
    modality: 'audio',
    label: 'Stable Audio Open Small (SFX)',
    backend: 'comfyui',
    repo: 'stabilityai/stable-audio-open-small',
    license: 'stability-community',
    commercialUse: false,
    approxSizeGB: 1.5,
    minUnifiedMemoryGB: 3,
    runsLocally: true,
    heavy: false,
    reserved: true,
    recommended: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'stable-audio-open-small', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        seconds: '11.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Tiny SFX/audio: ARM/CPU-optimized, genuinely light (~1.5GB). Same Stability Community license as the 1.0 row — free commercial under $1M revenue, GATED above. Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },

  {
    /*
     * Stable Audio 3 small — MUSIC. MEASURED: a 12s stereo 44.1kHz clip in 6
     * seconds on an M5 Pro, from 2.1GB of weights plus a shared 1.1GB text
     * encoder. That makes it the only audio model here faster than the wait UI
     * it shows, which is why it is the recommended music pick over the much
     * larger ACE-Step.
     */
    id: 'stable-audio-3-music',
    modality: 'audio',
    label: 'Stable Audio 3 small (music)',
    backend: 'comfyui',
    repo: 'Comfy-Org/stable-audio-3',
    license: 'stability-community',
    commercialUse: false,
    approxSizeGB: 3.3,
    minUnifiedMemoryGB: 8,
    runsLocally: true,
    heavy: false,
    recommended: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'stable-audio-3-music',
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        seconds: '5.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Text→music. The checkpoint carries NO text encoder — t5gemma loads separately, and the conditioning goes through ConditioningStableAudio, without which the model is never told the clip length. Stability Community licence: non-commercial.',
  },
  {
    /** Stable Audio 3 small — SFX. Same stack, the SFX-tuned checkpoint;
     * MEASURED at 6s of audio in 6s wall. */
    id: 'stable-audio-3-sfx',
    modality: 'audio',
    label: 'Stable Audio 3 small (sound effects)',
    backend: 'comfyui',
    repo: 'Comfy-Org/stable-audio-3',
    license: 'stability-community',
    commercialUse: false,
    approxSizeGB: 3.3,
    minUnifiedMemoryGB: 8,
    runsLocally: true,
    heavy: false,
    recommended: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'stable-audio-3-sfx',
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        seconds: '5.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Text→sound effect. Shares the t5gemma encoder with the music row, so having both on disk costs 2.1GB more, not 3.3GB.',
  },

  // ---- VIDEO (LTX via ComfyUI + the Node/ffmpeg path; reserved) ---------
  {
    id: 'hyperframes',
    modality: 'video',
    label: 'HyperFrames (motion graphics)',
    backend: 'hyperframes',
    repo: 'heygen-com/hyperframes',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 0,
    minUnifiedMemoryGB: 2,
    runsLocally: true,
    heavy: false,
    /*
     * NO AUX DEPS, AND NO LONGER RESERVED. This entry was gated behind
     * `['ffmpeg', 'headless-chrome']` and `reserved: true`, which is why every
     * motion commission died on "the runner is not installed" — the catalog
     * refused before the runner was ever asked.
     *
     * Both deps were phantoms. Chromium is the process this app runs inside, so
     * headless Chrome was never missing; ffmpeg was only ever needed to ENCODE,
     * and the user cut encoding when the user asked for stills ("you can ignore video
     * generation … hyperframes has to be in, still renderer and all"). The
     * renderer now captures deterministic PNG frames through an offscreen
     * BrowserWindow — see apps/desktop/electron/gen/hyperframes-still.ts.
     */
    auxDeps: [],
    reserved: false,
    recommended: true,
    notes:
      'The genuinely-local, non-diffusion motion path: the agent authors HTML/CSS/JS, it is ' +
      "rendered frame by frame through the app's own Chromium, and the stills are joined into " +
      'one looping animated PNG — no weights, no network, no ffmpeg, same pixels every run. ' +
      'An animation, not a video file. Not photoreal.',
  },
  {
    id: 'wan2.1-t2v-1.3b',
    modality: 'video',
    label: 'Wan2.1 T2V (1.3B)',
    backend: 'comfyui',
    repo: 'Wan-AI/Wan2.1-T2V-1.3B',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 8,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    recommended: true,
    // The three files the graph names, from the repos ComfyUI's own template
    // points at (Comfy-Org's repackaging, city96's GGUF encoder) — none gated.
    weights: [
      {
        repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged',
        path: 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors',
        bytes: 2_840_000_000,
      },
      {
        repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged',
        path: 'split_files/vae/wan_2.1_vae.safetensors',
        bytes: 254_000_000,
      },
      {
        repo: 'city96/umt5-xxl-encoder-gguf',
        path: 'umt5-xxl-encoder-Q5_K_M.gguf',
        bytes: 4_150_000_000,
        folder: 'text_encoders',
      },
    ],
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'wan2.1-t2v-1.3b',
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '73.inputs.steps',
        seed: '73.inputs.seed',
      },
    },
    notes:
      'Most Mac-realistic diffusion text→video pick: Apache (commercial-clean, NO gate), ~1.3B, runs via native ComfyUI. MEASURED on an M5 Pro 24GB: 416x416, 33 frames (2.06s at 16fps), 20 steps, 178s wall — umt5-xxl fp16 (11GB) + a 2.6GB unet + a 242MB VAE, and fp8 is not an option because MPS refuses the cast. No longer reserved: this graph has run.',
  },
  {
    id: 'ltx-2.5-distilled',
    modality: 'video',
    label: 'LTX-2.5 22B distilled (video + audio)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-2.5',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 25,
    /*
     * The encoder (15.4GB) and the transformer (7.3GB at Q2_K) are never
     * resident together — ComfyUI frees the first before loading the second.
     * MEASURED 2026-09-14 on the M5 Pro 24GB as the OS's own free-memory drop
     * across a 640x352x49 job: 14.2 GB, with the process at 14.1 GB RSS and
     * the OS pushing 5.7 GB out to swap on the way — a ~20 GB working set. It
     * runs on 24 GB by swapping, which is what the guardian calls thrashing,
     * so 24 is not a machine this fits; 32 is.
     */
    peakResidentGB: 16,
    minUnifiedMemoryGB: 32,
    runsLocally: true,
    heavy: true,
    recommended: true,
    /*
     * Lightricks/LTX-2.5 is gated; comfyicu/LTX-2.5 mirrors the whole tree
     * (145k downloads) and is not, so the encoder and both VAEs come from
     * there. The Q2_K transformer is the ComfyUI-GGUF conversion several
     * accounts host identically (ruygar / agosh / courageaihub).
     */
    weights: [
      {
        repo: 'ruygar/LTX-2.5-Comfy-GGUF',
        path: 'ltx-2.5-22b-distilled-transformer-bf16-Q2_K.gguf',
        bytes: 7_325_780_064,
        folder: 'unet',
      },
      {
        repo: 'comfyicu/LTX-2.5',
        path: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
        bytes: 15_372_971_786,
      },
      {
        repo: 'comfyicu/LTX-2.5',
        path: 'vae/ltx-2.5-video-vae-bf16.safetensors',
        bytes: 1_472_223_346,
      },
      {
        repo: 'comfyicu/LTX-2.5',
        path: 'vae/ltx-2.5-audio-vae-bf16.safetensors',
        bytes: 364_866_540,
      },
    ],
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-2.5-distilled-gguf',
      paramMap: {
        prompt: '6.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: ['70.inputs.length', '71.inputs.frames_number'],
        steps: '73.inputs.steps',
        seed: '75.inputs.noise_seed',
      },
    },
    notes:
      "The best local video on this machine, and the only one that comes out with SOUND — the sampler runs on a joint audio+video latent and two decoders pull it apart. MEASURED on an M5 Pro 24GB: 640x352, 49 frames (2s at 24fps), 8 steps — 326s at Q4_K_M and 195s at Q2_K, with a real 48kHz track either way. Q2_K is soft and Q4_K_M is photographic, so the quant is the quality dial here, not the step count. The weights are a 22B transformer as GGUF plus a Gemma-4-12B encoder WITH a projection head: the only GGUF of that encoder is gated, so this uses the ungated int8+convrot safetensors, which falls to ComfyUI's eager quantised path on a machine with no CUDA and runs fine. Upstream adds a second latent-upscaler pass for sharpness; this template is stage one. LTX-2.x community EULA.",
  },
  {
    id: 'minimax-h3',
    modality: 'video',
    label: 'MiniMax H3 (pruned, Q3)',
    backend: 'comfyui',
    repo: 'Comfy-Org/MiniMax-H3',
    license: 'minimax-community',
    commercialUse: false,
    approxSizeGB: 36,
    // Peak is the text-encoder stage alone (19.8GB); the 8.9GB transformer
    // loads after it is freed. MEASURED: the whole job fits 24GB.
    peakResidentGB: 20,
    minUnifiedMemoryGB: 24,
    runsLocally: true,
    heavy: true,
    weights: [
      {
        repo: 'Abiray/MiniMax-H3-Pruned-GGUF',
        path: 'MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf',
        bytes: 8_900_000_000,
        folder: 'unet',
      },
      {
        repo: 'joeygambino/MiniMax-H3-encoder-GGUF',
        path: 'MiniMax-H3-encoder-Q4_K_M.gguf',
        bytes: 19_760_000_000,
        folder: 'text_encoders',
      },
      {
        repo: 'Comfy-Org/MiniMax-H3',
        path: 'vae/minimax_h3_video_vae_fp16.safetensors',
        bytes: 5_210_000_000,
      },
    ],
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'minimax-h3-t2v-gguf',
      paramMap: {
        prompt: '6.inputs.prompt',
        width: '6.inputs.width',
        height: '6.inputs.height',
        length: '6.inputs.length',
        steps: '73.inputs.steps',
        seed: '75.inputs.noise_seed',
      },
    },
    notes:
      "MEASURED on an M5 Pro 24GB: 608x352, 5 frames, 6 steps, 192s — a coherent scene, not quantisation soup. Runs at all only because of two size choices: the FL2VA transformer PRUNED and quantised to Q3_K_M (8.9GB against 66GB at bf16), and the Qwen3-VL-32B text encoder as a Q4_K_M GGUF (19.8GB against 27GB for the smallest official int8, which does not fit 24GB). That GGUF has no vision tower — llama.cpp splits it into a separate mmproj — and ComfyUI identifies this encoder BY a vision key, so recognising it needs the `bobble_comfy_fixes` shim the engine installs; text-to-video never uses the vision half. No negative prompt: H3 is guidance-distilled and its conditioning node emits one tower. MiniMax's own terms (HF `license: other`) — read them before commercial use.",
  },
  {
    id: 'ltx-video-2b-distilled',
    modality: 'video',
    label: 'LTX-Video 2B distilled (safetensors, fast)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-Video',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 8,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-video-2b-distilled-gguf', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '72.inputs.steps',
        seed: '73.inputs.noise_seed',
      },
    },
    notes:
      'Safe 16GB video pick: real LTX-Video 2B distilled. Correction #2: use the single-file ComfyUI-repackaged SAFETENSORS (not the diffusers layout / not GGUF). ~2-4s @480-512p, ~15min M1 / ~3-5min M3-M4 [measured]. LTX-2 Community EULA — gated. fp8 hard-excluded on darwin; Euler sampler + --force-upcast-attention. Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },
  {
    id: 'ltx-2',
    modality: 'video',
    label: 'LTX-2 distilled (safetensors, default)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-2',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 24,
    minUnifiedMemoryGB: 24,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-2-distilled-gguf', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '72.inputs.steps',
        seed: '73.inputs.noise_seed',
      },
    },
    notes:
      'Default video — flipped from mis-tagged remote-only hyperframes to local ComfyUI with tier gating. Correction #2: single-file ComfyUI-repackaged SAFETENSORS (not diffusers / not GGUF). ~24GB on disk [projected fwd]; 24GB needs ComfyUI weight-offload (a 24GB Mac addresses ~16-18GB on-GPU), 32GB+ comfortable. tech-demo, minutes/clip; Euler, fp8-excluded. LTX-2 Community EULA — gated. Reserved until the ComfyUI backend lands.',
  },
  {
    id: 'ltx-2-22b',
    modality: 'video',
    label: 'LTX-2 22B (quality · 64GB / remote)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-2',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 44,
    minUnifiedMemoryGB: 64,
    runsLocally: false,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-2-22b-gguf', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '72.inputs.steps',
        seed: '73.inputs.noise_seed',
      },
    },
    notes:
      'Quality tier: 22B bf16 / single-file ComfyUI-repackaged SAFETENSORS (correction #2: not diffusers / not GGUF). runsLocally:false below 64GB → routes to a remote ComfyUI (same adapter, http://host:port). 22B reliability is tech-demo (2-stage VAE decode hit NaN on analogue). LTX-2 Community EULA — gated.',
  },

  // ---- 3D on ComfyUI's own nodes (0.35+): image → PBR GLB, no git, no Xcode --
  {
    id: 'trellis2-comfy',
    modality: '3d',
    label: 'TRELLIS.2 (ComfyUI)',
    backend: 'comfyui',
    repo: 'Comfy-Org/TRELLIS.2',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 9,
    /*
     * MEASURED at 512³ on the M5 Pro 24GB, quiet machine, as the OS's own
     * free-memory drop across the whole job: 11.5 GB (the ComfyUI process
     * peaking at 9.7 GB RSS through the shape stage, the int8 DiT and both
     * VAEs resident, plus 2.2 GB the OS chose to swap). The guardian's own
     * headroom (15% + 1 GB) is what covers that spill; this is the drop.
     */
    peakResidentGB: 12,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    recommended: true,
    weights: [
      {
        repo: 'Comfy-Org/TRELLIS.2',
        path: 'diffusion_models/trellis_2_int8_convrot.safetensors',
        bytes: 5_253_048_192,
      },
      {
        repo: 'Comfy-Org/TRELLIS.2',
        path: 'clip_vision/dino_v3_vit_l.safetensors',
        bytes: 1_213_000_000,
      },
      {
        repo: 'Comfy-Org/TRELLIS.2',
        path: 'vae/trellis_2_shape_vae_bf16.safetensors',
        bytes: 1_100_000_000,
      },
      {
        repo: 'Comfy-Org/TRELLIS.2',
        path: 'vae/trellis_2_texture_vae_bf16.safetensors',
        bytes: 950_000_000,
      },
      {
        repo: 'Comfy-Org/BiRefNet',
        path: 'background_removal/birefnet.safetensors',
        bytes: 444_473_596,
      },
    ],
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'trellis2-image-to-3d',
      paramMap: {
        image: '122.inputs.image',
        seed: ['3.inputs.seed', '18.inputs.seed', '12.inputs.seed'],
        faces: '186.inputs.target_face_count',
        textureSize: ['196.inputs.resolution', '147.inputs.texture_size', '224.inputs.resolution'],
      },
    },
    notes:
      "Image → textured 3D on ComfyUI's native TRELLIS.2 nodes (0.35): the same Microsoft model as the Bobble 3D engine, repackaged by Comfy-Org as int8, with ComfyUI's own decimate / unwrap / bake behind it. MEASURED on an M5 Pro 24GB at 512³: about 6 minutes to a remeshed 100k-face GLB with base colour, metallic, roughness, normal and AO maps on a 2048² sheet. Slower than the MLX engine (117s), and it needs neither git nor Xcode — one click, any Apple Silicon Mac. 1024³ is deliberately not offered here: measured 28 minutes on this path. MIT weights.",
  },
  {
    id: 'pixal3d-comfy',
    modality: '3d',
    label: 'Pixal3D (ComfyUI)',
    backend: 'comfyui',
    repo: 'Comfy-Org/Pixal3D',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 10,
    // The same pipeline at the same size; TRELLIS.2's measured drop stands in
    // (the DiTs are within 0.3 GB of each other, the VAEs are shared).
    peakResidentGB: 12,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    weights: [
      {
        repo: 'Comfy-Org/Pixal3D',
        path: 'diffusion_models/pixal3d_int8_convrot.safetensors',
        bytes: 5_584_555_824,
      },
      {
        repo: 'Comfy-Org/Pixal3D',
        path: 'clip_vision/dino_v3_L_naf_fp32.safetensors',
        bytes: 1_215_214_176,
      },
      {
        repo: 'Comfy-Org/TRELLIS.2',
        path: 'vae/trellis_2_shape_vae_bf16.safetensors',
        bytes: 1_100_000_000,
      },
      {
        repo: 'Comfy-Org/TRELLIS.2',
        path: 'vae/trellis_2_texture_vae_bf16.safetensors',
        bytes: 950_000_000,
      },
      {
        repo: 'Comfy-Org/BiRefNet',
        path: 'background_removal/birefnet.safetensors',
        bytes: 444_473_596,
      },
      {
        repo: 'Comfy-Org/MoGe',
        path: 'geometry_estimation/moge_2_vitl_normal_fp16.safetensors',
        bytes: 661_859_924,
      },
    ],
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'pixal3d-image-to-3d',
      paramMap: {
        image: '122.inputs.image',
        seed: ['3.inputs.seed', '18.inputs.seed', '12.inputs.seed'],
        faces: '186.inputs.target_face_count',
        textureSize: ['196.inputs.resolution', '147.inputs.texture_size', '224.inputs.resolution'],
      },
    },
    notes:
      "Pixal3D on the same native pipeline, with MoGe reading the photo's field of view so the model keeps the camera's perspective. MEASURED on an M5 Pro 24GB at 512³: 260s to a textured GLB — the faster of the two, and the more photographic on a real object. MIT weights.",
  },

  // ---- 3D (direct MLX/uv workers, NOT ComfyUI on Mac; reserved) ---------
  {
    id: 'triposr',
    modality: '3d',
    label: 'TripoSR',
    backend: 'triposr',
    repo: 'stabilityai/TripoSR',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 1.6,
    minUnifiedMemoryGB: 4,
    runsLocally: true,
    heavy: false,
    reserved: true,
    recommended: true,
    notes:
      'Fast / 16GB fallback: image→geometry, vertex colors, no PBR. uv worker one-shot (correction #4: transformers==4.35.0 pin + PYTORCH_ENABLE_MPS_FALLBACK=1). Seconds-to-low-minutes on Mac [unverified — MPS-fallback].',
  },
  {
    id: 'trellis-2-4b',
    modality: '3d',
    label: 'TRELLIS.2 (4B)',
    backend: 'trellis',
    // Correction #6: microsoft/TRELLIS (401) → microsoft/TRELLIS.2-4B (MIT
    // weights); the MLX runner is xocialize/trellis2-mlx (the pedronaugusto/*
    // 401 and gtrg55/* 404 ports are dead).
    repo: 'microsoft/TRELLIS.2-4B',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 15,
    minUnifiedMemoryGB: 24,
    runsLocally: true,
    heavy: true,
    reserved: true,
    recommended: true,
    notes:
      'Default/quality image→textured GLB with full PBR. DIRECT MLX worker (xocialize/trellis2-mlx over MIT weights microsoft/TRELLIS.2-4B), NOT ComfyUI — the community ComfyUI TRELLIS nodes are CUDA-bound. ~15GB weights, persistent worker. Resolution knob: 512³ ≤24GB, 1024³ ≥32GB. 16GB unvalidated → use TripoSR. Perf UNPINNED until re-measured against the resolvable port. Experimental (sparse-MPS texture sampling; Fast Repair not guaranteed watertight). [fwd slug]',
  },
];

/** Index by id for O(1) lookup. */
const BY_ID: ReadonlyMap<string, ModalityModel> = new Map(MODALITY_CATALOG.map((m) => [m.id, m]));

/** Look up a model by catalog id. */
export function getModel(id: string): ModalityModel | undefined {
  return BY_ID.get(id);
}

/** All models for a modality (in catalog order). */
export function modelsForModality(modality: Modality): ModalityModel[] {
  return MODALITY_CATALOG.filter((m) => m.modality === modality);
}

/** Models that are actually wired + runnable now (not reserved, run locally). */
export function activeModels(): ModalityModel[] {
  return MODALITY_CATALOG.filter((m) => m.reserved !== true && m.runsLocally);
}

/** The 3D model a picture goes to when none is named: the first recommended
 * ComfyUI-backed 3D entry (TRELLIS.2), else the first ComfyUI-backed one. */
export function default3dModel(): ModalityModel {
  const threeD = modelsForModality('3d').filter(
    (m) => m.backend === 'comfyui' && m.reserved !== true,
  );
  const pick = threeD.find((m) => m.recommended === true) ?? threeD[0];
  if (pick === undefined) throw new Error('catalog has no ComfyUI 3D model');
  return pick;
}

/** The default image model (the first image entry). */
export function defaultImageModel(): ModalityModel {
  const first = modelsForModality('image')[0];
  if (first === undefined) throw new Error('catalog has no image model');
  return first;
}

/**
 * The default VIDEO model the `generate_video` tool picks when the caller names
 * none AND the prompt is not motion-graphics: the first RECOMMENDED, commercial-
 * clean photoreal (ComfyUI) text→video entry — currently Wan2.1-T2V-1.3B (Apache,
 * "most Mac-realistic"). Motion-graphics prompts route to the `hyperframes` entry
 * instead (the tool special-cases that by backend). Falls back to any recommended
 * video model, then the first video entry.
 */
export function defaultVideoModel(): ModalityModel {
  const videos = modelsForModality('video');
  /*
   * PREFER SOMETHING THAT CAN ACTUALLY RUN.
   *
   * This picked the first RECOMMENDED comfyui entry — Wan2.1-T2V-1.3B — which is
   * `reserved: true`, i.e. its backend is not installed and the job cannot
   * execute. So every `generate_video` call whose prompt missed a narrow keyword
   * regex was routed to a dead model and failed, while the one video backend that
   * genuinely works on this machine (HyperFrames, no weights, no network) sat
   * unreachable behind that regex. Measured: a motion request reached the motion
   * specialist with `generate_video` in its kit and still rendered nothing.
   *
   * A default that cannot run is not a default. Reserved entries are now the LAST
   * resort rather than the first choice, so the fallback chain degrades toward
   * something usable instead of away from it.
   */
  const usable = videos.filter((m) => m.reserved !== true);
  const first =
    usable.find((m) => m.recommended === true) ??
    usable[0] ??
    videos.find((m) => m.recommended === true) ??
    videos[0];
  if (first === undefined) throw new Error('catalog has no video model');
  return first;
}

/** Whether a model needs an install-EULA / commercial gate before use. */
export function requiresLicenseGate(model: ModalityModel): boolean {
  return model.commercialUse === false;
}

/**
 * WHAT A JOB WILL ACTUALLY HOLD, for admission — scaled by the picture.
 *
 * A model's weights sit still; its activations scale with the pixels. So the
 * footprint is a floor plus a slope: what the job costs before it draws
 * anything (`residentFloorGB`, or the download size when nothing better was
 * measured) plus the measured 1024² excess in proportion to the pixels asked
 * for.
 *
 * MEASURED for FLUX.2 klein as the OS's own free-memory drop: ~10.5 GB at 512²,
 * ≥14 GB at 768² — a 7.7 GB floor and ~10.7 GB per megapixel, ~19 GB at 1024².
 * From the download size alone (4.3 GB) admission let it onto a machine with
 * 20 GB spare and the OS went critical; the floor is what was missing. A model
 * without a measured peak is admitted on its size, which is the best number
 * there is and what the guardian's shed is behind.
 */
export function jobFootprintGB(
  model: Pick<ModalityModel, 'approxSizeGB' | 'peakResidentGB' | 'residentFloorGB'>,
  pixels?: number,
): number {
  const floor = model.residentFloorGB ?? model.approxSizeGB;
  const peak = model.peakResidentGB;
  if (peak === undefined) return floor;
  if (pixels === undefined || !(pixels > 0) || peak <= floor) return Math.max(peak, floor);
  return floor + (peak - floor) * (pixels / (1024 * 1024));
}

/**
 * What per-step previews add to a job's peak, GB, scaled by the picture.
 *
 * MEASURED (FLUX.2 klein, 512², M5 Pro 24GB), plain: the same job troughs at
 * 43% of the machine's memory without `--stepwise-image-output-dir` and at 26%
 * with it — ~4.5 GB, because the VAE decodes a full frame at every step while
 * the transformer's activations are still live.
 *
 * Under `--low-ram` (2026-09-12, every job now) the VAE decodes in tiles and
 * the cost all but goes: 512² 4.8 GB with previews and without; 1024² 7.2 GB
 * with, 5.8 without — ~1.4 GB at a megapixel. What previews still cost at
 * 1024² is TIME (30.1 s against 16.7 s), which is the power policy's reason
 * for dropping them under 'low', not the guardian's.
 */
export const PREVIEW_GB_PER_MEGAPIXEL = 1.5;
export function previewCostGB(pixels: number): number {
  return PREVIEW_GB_PER_MEGAPIXEL * (Math.max(pixels, 1) / (1024 * 1024));
}
