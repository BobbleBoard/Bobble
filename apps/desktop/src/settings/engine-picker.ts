/**
 * FOR ANY MODEL, THE BEST ENGINE THIS MACHINE CAN RUN IT WITH.
 *
 * the user: "you need to detect for each model we ever download, what the optimal
 * inference engine we have available out of the whole catalog, that works on the
 * user's machine, to run with, suggest that as the optimal, but we need a ranking
 * of between everything that can run it we have in the catalog… this is paramount
 * to the whole out of the box experience on any users machine… you get 99% of the
 * way there on 99% of models on 99% of hardware to a person who knows how to do
 * their stuff and manually configures stuff for maximum performance."
 *
 * THE ORDER OF THE QUESTIONS IS THE DESIGN. Three of them are hard gates and
 * only the fourth is a preference, and mixing them up is how these systems end
 * up recommending something that cannot run:
 *
 *   1. CAN IT LOAD THE FILE? A GGUF cannot run on vLLM and a diffusers repo
 *      cannot run on llama.cpp. Nothing about speed enters here.
 *   2. DOES IT MAKE THIS KIND OF THING? A text engine is not a slow image
 *      engine, it is not an image engine.
 *   3. DOES THE HARDWARE EXIST? CUDA kernels on an AMD card are absent, not
 *      slow. An Ampere-only runtime on a GTX 1080 is absent.
 *   4. ONLY THEN, WHICH IS FASTEST — and even that is broken by what is already
 *      installed, because a 200 MB download that starts now beats a 4 GB one
 *      that is 12% quicker afterwards.
 *
 * EVERY ANSWER CARRIES ITS REASON, in words, because this is the layer people
 * will not believe unless it explains itself. "Nunchaku — 4-bit on your RTX
 * 4090, about 8x" is checkable; a ranked list of names is a black box.
 *
 * WHAT IT REFUSES TO DO is route a job to an engine we have not integrated.
 * The catalogue runs ahead of the wiring on purpose, so `best` is always
 * something we can actually drive and `bestPossible` says what we are leaving
 * on the table. Hiding that gap would make the ranking a lie; deleting the
 * unwired entries would make the roadmap invisible.
 */
import type { GpuVendor } from '@pi-desktop/inference';
import {
  ENGINES,
  type EngineFormat,
  type EngineModality,
  type EnginePlatform,
  type EngineSpec,
} from './engine-catalog';

/** The machine, as the picker needs to see it. */
export interface PickerHost {
  readonly platform: EnginePlatform;
  readonly appleSilicon: boolean;
  readonly gpuVendor: GpuVendor;
  readonly cudaMajor?: number;
  readonly npu: boolean;
  /** What a model actually gets — VRAM on a discrete card, most of RAM otherwise. */
  readonly usableMemoryGB: number;
}

/** A model, as the picker needs to see it. Derivable from an HF repo. */
export interface PickerModel {
  readonly repo: string;
  readonly modality: EngineModality;
  readonly format: EngineFormat;
  readonly paramsB?: number;
  readonly quant?: string;
}

export interface EngineChoice {
  readonly spec: EngineSpec;
  /** Higher is better. Only meaningful against the other entries in one list. */
  readonly score: number;
  /** Why this one, in a clause a person can check. */
  readonly reason: string;
  readonly installed: boolean;
}

export interface EngineRejection {
  readonly spec: EngineSpec;
  /** Why it CANNOT be used here — a fact about the machine or the file. */
  readonly blocker: string;
}

export interface EnginePick {
  /** What to actually run it with: the best WIRED, supported engine. */
  readonly best?: EngineChoice;
  /** The best in the catalogue, wired or not — what we are aiming at. */
  readonly bestPossible?: EngineChoice;
  /** Everything usable, best first (includes `best`). */
  readonly ranked: readonly EngineChoice[];
  /** Everything that cannot run it here, each with the reason. */
  readonly rejected: readonly EngineRejection[];
}

/**
 * The weight format of a Hugging Face repo, from its id and file list.
 *
 * File evidence wins over the name: a repo called `…-GGUF` that publishes
 * safetensors is telling you what it is in the only way that matters. The name
 * is the fallback for the common case of not having listed the files yet.
 */
export function formatOfRepo(repo: string, files: readonly string[] = []): EngineFormat {
  if (files.some((f) => /\.gguf$/i.test(f))) return 'gguf';
  if (files.some((f) => /\.(safetensors|bin)$/i.test(f))) {
    return /mlx-community|[-_]mlx\b/i.test(repo) ? 'mlx' : 'safetensors';
  }
  if (/gguf/i.test(repo)) return 'gguf';
  if (/mlx/i.test(repo)) return 'mlx';
  if (/exl3|exllama/i.test(repo)) return 'exl3';
  if (/onnx/i.test(repo)) return 'onnx';
  return 'safetensors';
}

/** Why this engine cannot run here, or undefined when it can. */
function blockerFor(spec: EngineSpec, model: PickerModel, host: PickerHost): string | undefined {
  if (!spec.formats.includes(model.format)) {
    return `does not load ${model.format} weights`;
  }
  if (!spec.modalities.includes(model.modality)) {
    return `does not generate ${model.modality}`;
  }
  if (!spec.platforms.includes(host.platform)) {
    const names: Record<EnginePlatform, string> = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux',
    };
    return `${spec.platforms.map((p) => names[p]).join(' and ')} only`;
  }
  if (spec.requiresAppleSilicon === true && !host.appleSilicon) {
    return 'needs Apple Silicon';
  }
  if (spec.gpuVendors !== undefined && !spec.gpuVendors.includes(host.gpuVendor)) {
    const want = spec.gpuVendors.join('/');
    return `needs a ${want} GPU`;
  }
  if (spec.minCudaMajor !== undefined) {
    if (host.gpuVendor !== 'nvidia') return 'needs an NVIDIA GPU';
    if (host.cudaMajor !== undefined && host.cudaMajor < spec.minCudaMajor) {
      // Named by generation rather than by number: "compute capability 8.0" is
      // not something most people know about their own card.
      const gen: Record<number, string> = { 7: 'RTX 20-series', 8: 'RTX 30-series', 9: 'Hopper' };
      return `needs ${gen[spec.minCudaMajor] ?? `compute ${spec.minCudaMajor}.0`} or newer`;
    }
  }
  if (spec.requiresNpu === true && !host.npu) {
    return 'needs an NPU';
  }
  return undefined;
}

/** The clause that explains a pick. Specific beats flattering. */
function reasonFor(spec: EngineSpec, host: PickerHost, installed: boolean): string {
  const parts: string[] = [];
  if (spec.baseline === true) parts.push('runs everywhere');
  if (spec.gpuVendors?.includes('apple') === true) parts.push('Apple Silicon path');
  else if (spec.gpuVendors?.includes('nvidia') === true && host.gpuVendor === 'nvidia') {
    parts.push('uses your NVIDIA GPU');
  }
  if (spec.requiresNpu === true) parts.push('uses the NPU');
  if (installed) parts.push('already installed');
  if (spec.wired !== true) parts.push('not integrated yet');
  return parts.length > 0 ? parts.join(' · ') : spec.blurb;
}

export function pickEngine(
  model: PickerModel,
  host: PickerHost,
  installedIds: readonly string[] = [],
  engines: readonly EngineSpec[] = ENGINES,
): EnginePick {
  const usable: EngineChoice[] = [];
  const rejected: EngineRejection[] = [];

  for (const spec of engines) {
    const blocker = blockerFor(spec, model, host);
    if (blocker !== undefined) {
      rejected.push({ spec, blocker });
      continue;
    }
    const installed = installedIds.includes(spec.id);
    /*
     * ALREADY-INSTALLED IS WORTH A LOT, and the weight is a judgement rather
     * than a measurement: +5 is enough to beat one rank tier (the tiers are 10
     * apart) and not enough to beat two. So a marginally faster engine does not
     * trigger a multi-gigabyte download, and a genuinely faster one still does.
     */
    const score = (spec.rank ?? 0) + (installed ? 5 : 0);
    usable.push({ spec, score, reason: reasonFor(spec, host, installed), installed });
  }

  const ranked = usable.sort((a, b) => b.score - a.score);
  return {
    ranked,
    rejected,
    ...(ranked.find((c) => c.spec.wired === true) === undefined
      ? {}
      : { best: ranked.find((c) => c.spec.wired === true) }),
    ...(ranked[0] === undefined ? {} : { bestPossible: ranked[0] }),
  };
}

/**
 * One line for the UI: what will run this, and what would be better.
 *
 * Returns undefined when nothing can — which the caller must show rather than
 * swallow, because "you have downloaded something this machine cannot run" is
 * the most useful sentence in the whole system.
 */
export function summarisePick(pick: EnginePick): string | undefined {
  const best = pick.best;
  if (best === undefined) return undefined;
  const better = pick.bestPossible;
  if (better !== undefined && better.spec.id !== best.spec.id) {
    return `${best.spec.name}: ${best.reason}. ${better.spec.name} would be faster here, once we support it.`;
  }
  return `${best.spec.name}: ${best.reason}.`;
}
