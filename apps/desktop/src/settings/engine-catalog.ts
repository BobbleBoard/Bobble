/**
 * THE INFERENCE ENGINES WE CAN RUN, AND WHERE.
 *
 * the user: "in the settings area we need an engine panel that allows
 * downloading/uninstalling all available engines 1 click. with a short blurb
 * about what each is for and their disk size (we'll only show things that are
 * large enough to matter) we show everything greyed out at bottom are
 * unsupported, eg. vllm is linux only so that greyed out on win/mac."
 *
 * Three rules are encoded here rather than in the panel, so they can be tested
 * without a renderer and so the same answers drive onboarding's automatic pick:
 *
 *   1. SUPPORT IS A REASON, NOT A BOOLEAN. An engine the user cannot run must
 *      say why ("Linux only"), because a greyed row with no explanation reads as
 *      a bug in our app rather than a fact about theirs.
 *   2. SIZE IS OPTIONAL ON PURPOSE. `approxBytes: undefined` means "not big
 *      enough to matter" and renders nothing — the user asked for sizes only where
 *      they inform the decision, and a "1.8 MB" chip next to a 4 GB one is noise.
 *   3. RECOMMENDED IS PER-PLATFORM. The best engine on an M-series Mac is not
 *      the best on a Windows box, and onboarding has to pick without asking.
 *
 * The measurements behind the blurbs are ours, taken 2026-08-16 on an M5 Pro
 * with Qwen3.5-4B at 8-bit, 2048-token prompts (see the inference-bench notes):
 * rapid-mlx 2003 tok/s prefill and 259.7 aggregate TG at 16 streams; llama.cpp
 * 1616 / 48.4.
 *
 * DFlash's number is quoted CAREFULLY, because the first one we took was not
 * representative. `dflash benchmark` defaults to a short MATH prompt, where
 * acceptance is 84.5% and the speedup 2.10x (117.7 tok/s). On the workload this
 * app actually serves — 2048-token prose — acceptance falls to 68.9% and the
 * measured result is 56.1 -> 77.0 tok/s, about 1.37x. Both numbers are real;
 * only the second one describes a user's chat. Speculative decoding pays in
 * proportion to how predictable the text is, so any blurb quoting a single
 * multiplier has to quote the pessimistic one.
 */

import type { GpuVendor } from '@pi-desktop/inference';

export type EnginePlatform = 'darwin' | 'win32' | 'linux';

/**
 * WHAT AN ENGINE CAN MAKE. The second axis of the portability matrix.
 *
 * the user: "we target all major OS and all major hardware eventually in a modular
 * fashion such that we have a boatload of alternatives that we know of and can
 * get working quick to get max out of the box no setup fast inference for any
 * hardware on any OS."
 *
 * Platform alone was never enough to answer "what runs here": llama.cpp and
 * ComfyUI both run on all three platforms and have no overlap in what they DO.
 * A choice is only meaningful within one modality, so the matrix is
 * (platform x modality) -> an ordered list of engines, and this is the column.
 */
export type EngineModality = 'text' | 'image' | 'video' | 'audio' | '3d';

/** Weight formats an engine can load. */
export type EngineFormat = 'gguf' | 'safetensors' | 'mlx' | 'exl3' | 'onnx' | 'trt' | 'diffusers';

/** What an engine is good FOR — the panel groups and sorts on this. */
export type EngineRole = 'general' | 'single-user' | 'concurrency' | 'npu';

export interface EngineSpec {
  readonly id: string;
  readonly name: string;
  /** One line: what this is for. Shown under the name. */
  readonly blurb: string;
  readonly role: EngineRole;
  /** Platforms the engine actually runs on. */
  readonly platforms: readonly EnginePlatform[];
  /**
   * WHICH ACCELERATORS it can use. Undefined means "anything, including CPU" —
   * the property that makes an engine a candidate baseline.
   *
   * This is not a preference list. CUDA kernels on an AMD card are not slow,
   * they are absent, so an engine whose vendors do not include the one in the
   * machine is not a worse choice — it is not a choice.
   */
  readonly gpuVendors?: readonly GpuVendor[];
  /**
   * Minimum CUDA compute-capability major version, where one applies.
   * 7 = Turing (RTX 20), 8 = Ampere (RTX 30), 9 = Hopper, 12 = Blackwell.
   */
  readonly minCudaMajor?: number;
  /** Needs a dedicated NPU (Copilot+, Ryzen AI). */
  readonly requiresNpu?: boolean;
  /**
   * WEIGHT FORMATS it can load. The axis that answers the user's "for any model on
   * the hf hub, what is the optimal engine" — a GGUF cannot run on vLLM and a
   * safetensors diffusion repo cannot run on llama.cpp, and neither fact has
   * anything to do with which is faster.
   */
  readonly formats: readonly EngineFormat[];
  /**
   * WE HAVE ACTUALLY INTEGRATED THIS, versus catalogued it for later.
   *
   * the user asked for the catalogue to cover everything worth including, "not
   * installed on the users machine yet possibly but easily one click
   * downloadable" — which means the list will always be ahead of the wiring.
   * Saying which is which here keeps the ranking honest: an unwired engine can
   * top a theoretical ranking and must never be handed a job.
   */
  readonly wired?: boolean;
  /** What it can generate. An engine with none of a modality never competes for it. */
  readonly modalities: readonly EngineModality[];
  /**
   * THE PORTABLE BASELINE for its modalities — the one that runs everywhere,
   * on any GPU vendor, without a fast path having to exist first.
   *
   * There is at most one per modality and it is never the fastest anywhere;
   * that is the point. A fast path is an OPTIMISATION over a baseline that
   * already works, and an app whose only runtime for a modality is a fast path
   * is an app that does not support that modality on the hardware the fast path
   * was not written for.
   */
  readonly baseline?: boolean;
  /**
   * Ranking WITHIN a (platform, modality) cell, higher first. Purely relative —
   * it says "prefer this one here", never "this one is good".
   */
  readonly rank?: number;
  /**
   * Apple-Silicon only? MLX engines run on darwin but NOT on an Intel Mac, and
   * saying "macOS" to an Intel user who then watches it fail is worse than
   * greying it out with the real reason.
   */
  readonly requiresAppleSilicon?: boolean;
  /**
   * Roughly what it costs on disk once installed. `undefined` = too small to be
   * worth showing (rule 2 above).
   */
  readonly approxBytes?: number;
  /** Engines that must be installed first (e.g. an MLX runtime shared by both). */
  readonly requires?: readonly string[];
  /**
   * True when the engine arrives on its own the first time it is needed, so the
   * panel must NOT offer an Install button. llama.cpp is fetched by the model
   * launch path; showing a button that hands that job to a second downloader
   * would give us two of them able to disagree about which build is current.
   */
  readonly autoInstalls?: boolean;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const ENGINES: readonly EngineSpec[] = [
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    blurb: 'Runs GGUF models everywhere. The safe default — widest model support.',
    role: 'general',
    platforms: ['darwin', 'win32', 'linux'],
    formats: ['gguf'],
    wired: true,
    modalities: ['text'],
    baseline: true,
    rank: 10,
    approxBytes: 26 * MB,
    autoInstalls: true,
  },
  {
    id: 'rapid-mlx',
    name: 'rapid-mlx',
    blurb: 'Fastest with many agents at once. Batches requests; best prefill on Apple Silicon.',
    role: 'concurrency',
    platforms: ['darwin'],
    formats: ['mlx'],
    gpuVendors: ['apple'],
    wired: true,
    modalities: ['text'],
    rank: 30,
    requiresAppleSilicon: true,
    approxBytes: 771 * MB,
  },
  {
    id: 'dflash-mlx',
    name: 'MLX DFlash',
    blurb: 'Fastest for a single chat — around 1.4-1.6x. Needs a draft model.',
    role: 'single-user',
    platforms: ['darwin'],
    formats: ['mlx'],
    gpuVendors: ['apple'],
    wired: true,
    modalities: ['text'],
    rank: 40,
    requiresAppleSilicon: true,
    // The package is 1.8 MB; what actually costs disk is the drafter it needs.
    approxBytes: 1.2 * GB,
    requires: ['rapid-mlx'],
  },
  {
    /*
     * COMFYUI — the engine for everything that is not text.
     *
     * the user: "let's have comfy as a downloadable inference engine and then wire
     * up a primitive for now image/video studio) and have those run through it."
     *
     * It earns a row here because it is the same KIND of decision as the others:
     * a runtime you install once and every model of that sort then runs on. The
     * difference is which models — llama.cpp and the MLX engines run text, this
     * runs image, video and audio, so it is the only entry whose absence means a
     * whole modality is unavailable rather than slower.
     *
     * The size is the install itself (a clone plus a Torch venv); model weights
     * are the store's problem and are counted there.
     */
    id: 'comfyui',
    name: 'ComfyUI',
    blurb: 'Runs image, video and audio models — one runtime for every generation model.',
    role: 'general',
    platforms: ['darwin', 'win32', 'linux'],
    formats: ['gguf', 'safetensors', 'diffusers'],
    wired: true,
    modalities: ['image', 'video', 'audio'],
    baseline: true,
    rank: 10,
    approxBytes: 6 * GB,
  },
  {
    id: 'lemonade',
    name: 'Lemonade',
    blurb: 'Runs models on an AMD NPU/iGPU instead of the CPU, where one is present.',
    role: 'npu',
    platforms: ['win32', 'linux'],
    formats: ['onnx', 'gguf'],
    gpuVendors: ['amd'],
    requiresNpu: true,
    modalities: ['text'],
    rank: 20,
    approxBytes: 400 * MB,
  },
  {
    /*
     * ik_llama.cpp — a llama.cpp fork carrying quant types upstream has not
     * taken (IQ*_KS/KT and friends) plus CPU/GPU-split work. It matters for
     * exactly one situation, which is a common one: a large MoE that does not
     * fit in VRAM and has to run partly on the CPU.
     */
    id: 'ik-llama',
    name: 'ik_llama.cpp',
    blurb: 'A llama.cpp fork with extra quant types — better when a big model must spill to CPU.',
    role: 'general',
    platforms: ['darwin', 'win32', 'linux'],
    formats: ['gguf'],
    modalities: ['text'],
    rank: 15,
    approxBytes: 30 * MB,
  },
  {
    /*
     * SGLang: vLLM's rival for throughput, with RadixAttention prefix caching
     * that suits a chat app's repeated system prompt. Linux + NVIDIA, like vLLM.
     */
    id: 'sglang',
    name: 'SGLang',
    blurb: 'High-throughput server with prefix caching. Big NVIDIA GPUs, Linux.',
    role: 'concurrency',
    platforms: ['linux'],
    formats: ['safetensors'],
    gpuVendors: ['nvidia'],
    modalities: ['text'],
    rank: 22,
    approxBytes: 2 * GB,
  },
  {
    /*
     * TensorRT-LLM: NVIDIA's own compiler-based runtime. The fastest thing on
     * an NVIDIA card and the least convenient — it builds a per-GPU engine
     * before it serves anything, which is minutes of work the user pays once.
     */
    id: 'tensorrt-llm',
    name: 'TensorRT-LLM',
    blurb: "NVIDIA's own runtime — fastest on their cards, but compiles per GPU first.",
    role: 'concurrency',
    platforms: ['linux', 'win32'],
    formats: ['trt', 'safetensors'],
    gpuVendors: ['nvidia'],
    minCudaMajor: 8,
    modalities: ['text'],
    rank: 25,
    approxBytes: 4 * GB,
  },
  {
    /*
     * ExLlamaV3: EXL3 quantisation plus a very fast single-user CUDA runtime —
     * the NVIDIA counterpart to what DFlash/MLX is on a Mac. Ampere or newer.
     */
    id: 'exllamav3',
    name: 'ExLlamaV3',
    blurb: 'Fastest single chat on an NVIDIA card, with its own EXL3 quants. RTX 30-series up.',
    role: 'single-user',
    platforms: ['linux', 'win32'],
    formats: ['exl3', 'safetensors'],
    gpuVendors: ['nvidia'],
    minCudaMajor: 8,
    modalities: ['text'],
    rank: 35,
    approxBytes: 1 * GB,
  },
  {
    /*
     * ONNX Runtime GenAI: the path to a Windows NPU (Copilot+) and to DirectML,
     * which covers the Intel and AMD GPUs nothing else here targets on Windows.
     */
    id: 'onnx-genai',
    name: 'ONNX Runtime GenAI',
    blurb: 'Runs on a Windows NPU or any DirectML GPU — the Intel and AMD path on Windows.',
    role: 'npu',
    platforms: ['win32', 'linux'],
    formats: ['onnx'],
    gpuVendors: ['intel', 'amd', 'nvidia'],
    modalities: ['text'],
    rank: 18,
    approxBytes: 500 * MB,
  },
  {
    /*
     * stable-diffusion.cpp — the diffusion counterpart to llama.cpp, and the
     * most PORTABLE thing in this list by some distance: pure C/C++, GGUF, and
     * backends for CPU (AVX/AVX2/AVX512), CUDA, Vulkan, Metal, OpenCL and SYCL.
     * It covers SD/SDXL/FLUX 1-2/SD3.5/Qwen-Image/Z-Image AND video (Wan 2.1/
     * 2.2, MiniMax-H3, LTX-2.3, HunyuanVideo).
     *
     * NOT marked `baseline` yet, deliberately: baseline means "the one we
     * guarantee", and today that is ComfyUI because ComfyUI is the one actually
     * wired and verified here. This is the stronger portability story and the
     * obvious candidate to take that title once it is wired.
     */
    id: 'sdcpp',
    name: 'stable-diffusion.cpp',
    blurb: 'Image and video with no Python at all — CPU, CUDA, Vulkan, Metal or SYCL.',
    role: 'general',
    platforms: ['darwin', 'win32', 'linux'],
    formats: ['gguf', 'safetensors'],
    modalities: ['image', 'video'],
    rank: 12,
    approxBytes: 60 * MB,
  },
  {
    /*
     * Nunchaku (SVDQuant): 4-bit diffusion with real numbers behind it — 3.6x
     * memory reduction and 8.7x over BF16 for FLUX.1-dev on a 16 GB laptop
     * 4090, 3.1x on a 5090. NVIDIA 20-series and up only.
     */
    id: 'nunchaku',
    name: 'Nunchaku',
    blurb: '4-bit diffusion on NVIDIA — around 8x faster and a third of the memory for FLUX.',
    role: 'single-user',
    platforms: ['linux', 'win32'],
    formats: ['safetensors'],
    gpuVendors: ['nvidia'],
    minCudaMajor: 7,
    modalities: ['image'],
    rank: 30,
    approxBytes: 2 * GB,
  },
  {
    /*
     * mflux — MLX image generation on Apple Silicon. MEASURED here, on this
     * machine, against the PyTorch path: Mage-Flow-Turbo 71s -> 11s at 8-bit,
     * 14.69 GB peak. The largest single speedup anywhere in this catalogue that
     * we have taken ourselves.
     */
    id: 'mflux',
    name: 'mflux (MLX)',
    blurb: 'Apple Silicon image generation on MLX — MEASURED 6x faster than the PyTorch path.',
    role: 'single-user',
    platforms: ['darwin'],
    formats: ['mlx', 'safetensors'],
    gpuVendors: ['apple'],
    requiresAppleSilicon: true,
    modalities: ['image'],
    rank: 30,
    approxBytes: 400 * MB,
    wired: true,
  },
  {
    /*
     * Draw Things: its own Swift engine with hand-written Metal FlashAttention
     * kernels, a headless gRPC server, and GPL-3 — the same licence as this app,
     * so bundling is not a licence question. Their numbers: ~25% faster than
     * mflux per FLUX iteration, up to 50% less memory, and MFA v2.5 claims
     * 3.6-5.5x on M5 over M4. Ours: none yet, which is why it is not ranked
     * above mflux.
     */
    id: 'drawthings',
    name: 'Draw Things',
    blurb: 'Metal-native image and video on Apple Silicon, with its own kernels.',
    role: 'single-user',
    platforms: ['darwin'],
    formats: ['safetensors'],
    gpuVendors: ['apple'],
    requiresAppleSilicon: true,
    modalities: ['image', 'video'],
    rank: 28,
    approxBytes: 1 * GB,
  },
  {
    id: 'vllm',
    name: 'vLLM',
    blurb: 'High-throughput server for big GPUs. Linux only.',
    role: 'concurrency',
    platforms: ['linux'],
    formats: ['safetensors'],
    gpuVendors: ['nvidia', 'amd'],
    modalities: ['text'],
    rank: 20,
    approxBytes: 2 * GB,
  },
];

export interface HostCapabilities {
  readonly platform: EnginePlatform;
  /** arm64 on darwin means Apple Silicon. */
  readonly appleSilicon: boolean;
}

export type EngineSupport = { supported: true } | { supported: false; reason: string };

/**
 * Can this host run this engine, and if not, WHY. The reason is user-facing, so
 * it names the host's limitation rather than our implementation's.
 */
export function engineSupport(spec: EngineSpec, host: HostCapabilities): EngineSupport {
  if (!spec.platforms.includes(host.platform)) {
    const names: Record<EnginePlatform, string> = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux',
    };
    const where = spec.platforms.map((p) => names[p]).join(' and ');
    return { supported: false, reason: `${where} only` };
  }
  if (spec.requiresAppleSilicon === true && !host.appleSilicon) {
    return { supported: false, reason: 'Needs Apple Silicon' };
  }
  return { supported: true };
}

/**
 * THE PORTABILITY MATRIX: which engines can serve this modality on this host,
 * best first, baseline always present.
 *
 * This is the function the rest of the app should ask rather than naming an
 * engine. "Use Draw Things for images" is true on one platform and meaningless
 * on the other two; "give me the image engines for this host, in order" is the
 * same question phrased so that it still has an answer on a Windows box with an
 * Intel GPU.
 *
 * THE BASELINE IS NEVER DROPPED, even when a faster engine is present and
 * installed. It is what the app falls back to when the fast path does not
 * support a particular model, when its install is broken, and when someone
 * copies their settings onto different hardware. An ordered list with a
 * guaranteed last element is the shape that makes "no setup, it just runs" true.
 */
export function enginesFor(
  modality: EngineModality,
  host: HostCapabilities,
  engines: readonly EngineSpec[] = ENGINES,
): EngineSpec[] {
  return engines
    .filter((e) => e.modalities.includes(modality))
    .filter((e) => engineSupport(e, host).supported)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}

/**
 * The engine to actually USE for this modality here, or undefined if none runs.
 *
 * WIRED ONLY, and the distinction is the whole reason that flag exists: the
 * catalogue's ranking answers "what is best", this answers "what can we run
 * right now". They disagree today on an NVIDIA box — ExLlamaV3 and Nunchaku
 * both outrank what we have integrated — and pretending otherwise would route a
 * job to something that cannot take it. `enginesFor` still returns the full
 * ranking, so the gap is visible rather than hidden.
 */
export function preferredEngine(
  modality: EngineModality,
  host: HostCapabilities,
  engines: readonly EngineSpec[] = ENGINES,
): EngineSpec | undefined {
  return enginesFor(modality, host, engines).find((e) => e.wired === true);
}

/** The best engine in the CATALOGUE for this cell, wired or not — what we are aiming at. */
export function bestKnownEngine(
  modality: EngineModality,
  host: HostCapabilities,
  engines: readonly EngineSpec[] = ENGINES,
): EngineSpec | undefined {
  return enginesFor(modality, host, engines)[0];
}

/**
 * The portable last resort for a modality on this host.
 *
 * Separate from `enginesFor(...).at(-1)` on purpose: the last entry of a sorted
 * list is whatever happened to rank lowest, while THIS is the one we have
 * committed to keeping able to run everything. A modality with no baseline on a
 * platform is a gap in the matrix, and returning undefined says so rather than
 * quietly handing back a specialist that only covers half the models.
 */
export function baselineEngine(
  modality: EngineModality,
  host: HostCapabilities,
  engines: readonly EngineSpec[] = ENGINES,
): EngineSpec | undefined {
  return enginesFor(modality, host, engines).find((e) => e.baseline === true);
}

/**
 * Supported engines first (install order), unsupported last — the user asked for the
 * greyed-out ones "at bottom". Within each group the order in {@link ENGINES}
 * is kept, which puts the safe default first and the specialists after it.
 */
export function orderEnginesForDisplay(
  host: HostCapabilities,
  engines: readonly EngineSpec[] = ENGINES,
): Array<{ spec: EngineSpec; support: EngineSupport }> {
  const rows = engines.map((spec) => ({ spec, support: engineSupport(spec, host) }));
  return [...rows.filter((r) => r.support.supported), ...rows.filter((r) => !r.support.supported)];
}

/**
 * What onboarding installs when nobody has expressed a preference. Picks the
 * best SUPPORTED engine for the host: on Apple Silicon that is the fast
 * single-chat path, everywhere else the portable one. Never returns an
 * unsupported engine, and never returns undefined — llama.cpp runs everywhere.
 */
export function recommendedEngine(
  host: HostCapabilities,
  engines: readonly EngineSpec[] = ENGINES,
): EngineSpec {
  /*
   * ONBOARDING CAN ONLY INSTALL WHAT IS WIRED. The catalogue deliberately runs
   * ahead of the integration — the user asked for it to cover everything worth
   * including, installed or not — so a theoretical ranking will happily put
   * ExLlamaV3 at the top of an NVIDIA box we cannot yet drive. Handing that to
   * a first-run install is how a fresh machine ends up with an engine nothing
   * can talk to.
   */
  const supported = engines.filter((e) => e.wired === true && engineSupport(e, host).supported);
  const preference: EngineRole[] = ['single-user', 'general', 'concurrency', 'npu'];
  for (const role of preference) {
    const hit = supported.find((e) => e.role === role);
    if (hit !== undefined) return hit;
  }
  // Unreachable while llama.cpp is in the catalog, but a total function beats a
  // `!` here: a future catalog edit shouldn't be able to crash onboarding.
  const fallback = engines.find((e) => e.id === 'llamacpp');
  if (fallback === undefined) throw new Error('engine catalog has no portable fallback');
  return fallback;
}

/**
 * Human size for the chip, or null when the engine is too small to be worth
 * mentioning. Deliberately coarse: this is a "how much of my disk" signal, not
 * an accounting figure.
 */
export function formatEngineSize(spec: EngineSpec): string | null {
  if (spec.approxBytes === undefined) return null;
  if (spec.approxBytes >= GB) {
    const gb = spec.approxBytes / GB;
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }
  return `${Math.round(spec.approxBytes / MB)} MB`;
}

/** Everything `id` needs installed before it can run, in install order. */
export function installPrerequisites(
  id: string,
  engines: readonly EngineSpec[] = ENGINES,
): EngineSpec[] {
  const seen = new Set<string>();
  const out: EngineSpec[] = [];
  const walk = (target: string) => {
    if (seen.has(target)) return;
    seen.add(target);
    const spec = engines.find((e) => e.id === target);
    if (spec === undefined) return;
    for (const dep of spec.requires ?? []) walk(dep);
    if (target !== id) out.push(spec);
  };
  walk(id);
  return out;
}
