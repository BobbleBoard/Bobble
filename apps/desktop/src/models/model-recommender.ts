/**
 * WHAT THIS MACHINE SHOULD RUN, PER MODALITY — the out-of-the-box decision.
 *
 * the user: "for each modaility based on hardware and OS select the optimal models
 * (rank from reccomended catalog)… this is the core of the entire idea… you get
 * 99% of the way there on 99% of models on 99% of hardware to a person who knows
 * how to do their stuff and manually configures stuff for maximum performance."
 *
 * THE RULES, and where each comes from. They are stated here rather than spread
 * through the code because they are judgements, and a judgement whose source is
 * invisible cannot be argued with later:
 *
 * TEXT — Qwen3.8 27B first whenever it fits. the user asked for it directly, and it
 * is independently the top open-weights model on Artificial Analysis
 * (intelligence 52, ahead of MiniMax-M3 at 45 and Muse Glimmer at 35). It wants
 * about 18 GB at Q4_K_M. Below that the ladder descends by MODEL SIZE, not by
 * quant, because of the floor:
 *
 * THE FLOOR — "don't go below Q3 xs on any model <100b". This inverts the naive
 * move. With 12 GB and a 27B model the obvious answer is Q2, and it is wrong: a
 * 27B at Q2 is worse than a 9B at Q5 on every axis anyone notices, and slower.
 * See quant-ladder.ts.
 *
 * IMAGE — Mage Flow first on anything modest. the user: "for any generally 'slow'
 * machine, mage flow models are inevitably going to be like an order of
 * magnitude faster than any flux 2 klien or even something like z image is, so
 * those are my top pick". Our own measurement agrees on the direction:
 * Mage-Flow-Turbo 11s against FLUX.2 Klein 4B's 13s on MLX, and 71s for the same
 * Mage Flow on the PyTorch path — the family is fast because it is few-step, and
 * that advantage grows as the machine gets slower.
 *
 * VIDEO — LTX over MiniMax-H3. the user: "ltx 2.5 is significantly faster however
 * and it's really a style choice in my opinion, I can tell virtually no quality
 * difference in general side by sides, so favor ltx". H3 stays in the list
 * because it does jobs LTX does not (first+last frame, reference image) and
 * reportedly runs down to a 3060 through ComfyUI.
 *
 * 3D — one model and an appropriate quant, per "don't stress about 3d at all".
 *
 * WHAT IT WILL NOT DO is recommend something that does not fit. Every return
 * carries the memory it expects to need, and a machine that cannot hold the
 * smallest entry in a modality gets `undefined` rather than a suggestion that
 * will OOM — which the UI must then say out loud.
 */
import { DIFFUSION_LADDER, type QuantChoice, quantForBudget, TEXT_LADDER } from './quant-ladder';
import {
  fitFor,
  type OutputModality,
  RECOMMENDED_FAMILIES,
  type RecommendedFamily,
  type RecommendedVariant,
} from './recommended-catalog';

export interface RecommenderHost {
  /** What a model actually gets: VRAM on a discrete card, most of RAM otherwise. */
  readonly usableMemoryGB: number;
  /** Total system memory, for the copy ("on your 24 GB machine"). */
  readonly totalRamGB: number;
}

/**
 * The host the hub recommends for, from the detected hardware — one place, so
 * Top Recommended, every family's Quick Download and the page that fetches the
 * text pick's file ask about the same machine. Without a detected budget, three
 * quarters of RAM.
 *
 * Not total RAM: that is 24 GB on a 24 GB Mac, where a model gets 18, and on a
 * discrete card it is not the model's memory at all.
 */
export function hostFor(hardware: {
  readonly totalRamGB: number;
  readonly usableMemoryGB?: number;
}): RecommenderHost {
  return {
    usableMemoryGB: hardware.usableMemoryGB ?? Math.max(1, Math.round(hardware.totalRamGB * 0.75)),
    totalRamGB: hardware.totalRamGB,
  };
}

export interface ModelRecommendation {
  readonly modality: OutputModality;
  readonly family: RecommendedFamily;
  readonly variant: RecommendedVariant;
  /** The quant to fetch, when the choice is a ladder rather than a fixed recipe. */
  readonly quant?: QuantChoice;
  /** Expected memory to RUN it, in GB. */
  readonly needsGB: number;
  /** Why this one, in a sentence the user can check. */
  readonly reason: string;
}

/** Explicit first choices, in order, per the user. Falls through when none fits. */
const PREFERENCE: Record<OutputModality, readonly string[]> = {
  // Qwen3.8 27B always when it fits; then the best of what does.
  text: ['qwen3.8', 'qwen3.6', 'gemma4', 'qwen3-vl', 'qwen3.5', 'lfm2.5'],
  // Mage Flow leads because few-step wins by more the slower the machine is.
  image: ['mage-flow', 'z-image', 'flux2', 'krea2', 'qwen-image'],
  // LTX over H3 — same quality to the eye, significantly faster.
  video: ['ltx', 'minimax-h3'],
  audio: ['kokoro', 'qwen3-tts', 'stable-audio', 'ace-step'],
  // TRELLIS first because it is what the 3D Studio actually runs — a
  // recommendation the app cannot then execute is not a recommendation.
  '3d': ['trellis', 'pixal3d', 'triposr', 'hunyuan3d'],
};

/** Families in preference order, then whatever else that modality has. */
function orderedFamilies(modality: OutputModality): RecommendedFamily[] {
  const wanted = PREFERENCE[modality];
  const inModality = RECOMMENDED_FAMILIES.filter((f) => f.output === modality);
  const ranked = wanted
    .map((id) => inModality.find((f) => f.id === id))
    .filter((f): f is RecommendedFamily => f !== undefined);
  const rest = inModality.filter((f) => !ranked.includes(f));
  return [...ranked, ...rest];
}

/**
 * The best variant of one family this budget can hold.
 *
 * Two shapes of variant exist and they are judged differently. A RECIPE (an
 * `allow` list, so a fixed set of files) already names its own memory
 * requirement — there is no quant to choose, it either fits or it does not. A
 * LADDER entry (a GGUF repo with a parameter count) has a quant still to pick,
 * and that is where the floor applies.
 */
/**
 * Is there actually a quant ladder to choose from?
 *
 * MEASURING THIS OFF THE REPO, not off the family, because the mistake it
 * prevents is specific and embarrassing: applying GGUF bytes-per-weight to a
 * safetensors repo produces a confident "Qwen3-VL 8B at Q3_K_M, 5.1 GB" for a
 * model that publishes no GGUF at all. The number is arithmetic on a file that
 * does not exist.
 */
function hasQuantLadder(variant: RecommendedVariant): boolean {
  return /gguf/i.test(variant.repo) || /\.gguf$/i.test((variant.allow ?? []).join(' '));
}

/**
 * How big a variant is, for "largest that fits" — in whatever currency it has.
 *
 * A text ladder entry has a parameter count; a generation recipe has measured
 * bytes and a memory requirement and no parameter count at all. Sorting on
 * `paramsB` alone put every LTX-2.5 recipe BELOW the 2B, so a 96 GB workstation
 * was recommended the small one.
 */
function sizeKey(v: RecommendedVariant): number {
  if (v.paramsB !== undefined) return v.paramsB;
  if (v.minMemoryGB !== undefined) return v.minMemoryGB;
  return (v.approxBytes ?? 0) / 1e9;
}

function bestVariant(
  family: RecommendedFamily,
  budgetGB: number,
): { variant: RecommendedVariant; quant?: QuantChoice; needsGB: number } | undefined {
  const ladder = family.output === 'text' ? TEXT_LADDER : DIFFUSION_LADDER;
  // Largest first: the best model that fits, not the first one that does.
  const candidates = [...family.variants]
    .filter((v) => v.draftFor === undefined)
    .sort((a, b) => sizeKey(b) - sizeKey(a));

  for (const variant of candidates) {
    // A RECIPE names its own requirement — fixed files, nothing to choose.
    if (variant.minMemoryGB !== undefined && !hasQuantLadder(variant)) {
      if (variant.minMemoryGB <= budgetGB) return { variant, needsGB: variant.minMemoryGB };
      continue;
    }
    // A quantized recipe: the files are fixed too, but it IS a quant already.
    if (variant.allow !== undefined && variant.minMemoryGB !== undefined) {
      if (variant.minMemoryGB <= budgetGB) return { variant, needsGB: variant.minMemoryGB };
      continue;
    }
    if (variant.paramsB !== undefined && hasQuantLadder(variant)) {
      const quant = quantForBudget(variant.paramsB, budgetGB, ladder);
      // No rung fits ABOVE the floor — step down a model SIZE, which is the next
      // iteration of this loop, rather than down another quant.
      if (quant === undefined) continue;
      return { variant, quant, needsGB: quant.estimatedGB };
    }
    if (variant.minMemoryGB !== undefined && variant.minMemoryGB <= budgetGB) {
      return { variant, needsGB: variant.minMemoryGB };
    }
  }
  return undefined;
}

function reasonFor(
  family: RecommendedFamily,
  choice: { variant: RecommendedVariant; quant?: QuantChoice; needsGB: number },
  host: RecommenderHost,
): string {
  const size = `${choice.needsGB.toFixed(0)} GB of your ${host.totalRamGB} GB`;
  const q = choice.quant === undefined ? '' : ` at ${choice.quant.rung.quant}`;
  if (family.id === 'qwen3.8') {
    return `The strongest open model that fits here. ${size}${q}.`;
  }
  if (family.id === 'mage-flow') {
    return `Few-step, so it stays quick on any machine. ${size}.`;
  }
  if (family.id === 'ltx') {
    return `The fastest good video model, and the difference is hard to see. ${size}.`;
  }
  if (family.fast === true) {
    return `Unusually fast for its class. ${size}${q}.`;
  }
  return `${family.blurb} ${size}${q}.`;
}

/**
 * The best variant of ONE family for this machine — what "Quick Download" gets.
 *
 * the user asked for a Quick Download beside every collection, and the word quick is
 * the specification: it must not open the family, it must not ask which quant,
 * and it must not fetch the biggest thing in there. It is the same judgement the
 * per-modality pick already makes, scoped to one family — so it must be handed
 * the same host (`hostFor`), or the two judge different machines.
 */
export function quickPickFor(
  family: RecommendedFamily,
  host: RecommenderHost,
): { variant: RecommendedVariant; quant?: QuantChoice; needsGB: number } | undefined {
  return bestVariant(family, host.usableMemoryGB);
}

/** The one model to recommend for this modality, or undefined if none fits. */
export function recommendFor(
  modality: OutputModality,
  host: RecommenderHost,
): ModelRecommendation | undefined {
  for (const family of orderedFamilies(modality)) {
    const choice = bestVariant(family, host.usableMemoryGB);
    if (choice === undefined) continue;
    return {
      modality,
      family,
      variant: choice.variant,
      ...(choice.quant === undefined ? {} : { quant: choice.quant }),
      needsGB: choice.needsGB,
      reason: reasonFor(family, choice, host),
    };
  }
  return undefined;
}

/** Every modality at once — what the hub shows at the top of Recommended. */
export function recommendAll(
  host: RecommenderHost,
): Partial<Record<OutputModality, ModelRecommendation>> {
  const out: Partial<Record<OutputModality, ModelRecommendation>> = {};
  for (const modality of ['text', 'image', 'video', 'audio', '3d'] as const) {
    const hit = recommendFor(modality, host);
    if (hit !== undefined) out[modality] = hit;
  }
  return out;
}

/** Re-exported so callers can show a fit verdict beside a recommendation. */
export { fitFor };
