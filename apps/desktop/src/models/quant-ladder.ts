/**
 * WHICH QUANT, GIVEN A BUDGET — and the floor beneath which we do not go.
 *
 * the user: "don't go below Q3 xs on any model <100b, I have 0 experience with
 * diffusion quants so that's for you to decide."
 *
 * THE FLOOR IS THE INTERESTING RULE, and it inverts what a naive recommender
 * does. Faced with 12 GB and a 27B model, the obvious move is Q2 — it fits, the
 * number is bigger, the user gets "the good model". It is also the wrong answer:
 * a 27B at Q2 is worse than a 9B at Q5 on every axis a person notices, and it is
 * slower. So when the floor is hit, the recommender steps down a MODEL SIZE
 * rather than down another quant.
 *
 * DIFFUSION QUANTS, which the user left to me. The evidence, such as it is:
 * ComfyUI-GGUF's own README says "transformer/DiT models such as flux seem less
 * affected by quantization" and that quantization "wasn't feasible for regular
 * UNET models (conv2d)" — so everything current (FLUX, LTX, Qwen-Image, all
 * DiTs) tolerates it, and the SD-era UNets do not. Community guidance lands on
 * Q8 being visually indistinguishable and Q4_K_M being the standard balance.
 *
 * So the diffusion ladder is the same shape as the text one with a higher floor:
 * Q4 rather than Q3. The reason for the difference is that a language model
 * degrades GRADUALLY and legibly — you can see it getting dumber — while a
 * diffusion model at too low a bit-depth produces artefacts that read as a
 * broken app rather than a cheaper setting.
 *
 * BYTES PER WEIGHT are the published GGUF ratios, and the memory estimate adds
 * an overhead factor for the KV cache, activations and the runtime itself.
 * Deliberately conservative: a recommendation that runs is worth more than one
 * that is 8% bigger and swaps.
 */

/** A rung, best first. `bpw` is bytes per parameter at that quant. */
export interface QuantRung {
  readonly quant: string;
  readonly bpw: number;
  /** Roughly how much of the original quality survives, for the copy. */
  readonly note?: string;
}

/** Text (LLM) rungs, best first. The floor is the last entry. */
export const TEXT_LADDER: readonly QuantRung[] = [
  { quant: 'Q8_0', bpw: 1.06, note: 'indistinguishable from full precision' },
  { quant: 'Q6_K', bpw: 0.82 },
  { quant: 'Q5_K_M', bpw: 0.73 },
  { quant: 'Q4_K_M', bpw: 0.63, note: 'the standard balance' },
  { quant: 'Q3_K_M', bpw: 0.51 },
  { quant: 'IQ3_XS', bpw: 0.44, note: 'the floor — below this, use a smaller model' },
];

/** Diffusion rungs. Same shape, higher floor — see the file docstring. */
export const DIFFUSION_LADDER: readonly QuantRung[] = [
  { quant: 'Q8_0', bpw: 1.06, note: 'visually indistinguishable' },
  { quant: 'Q6_K', bpw: 0.82 },
  { quant: 'Q5_K_M', bpw: 0.73 },
  { quant: 'Q4_K_M', bpw: 0.63, note: 'the floor for diffusion — artefacts below this' },
];

/**
 * Runtime overhead beyond the weights, as a multiplier.
 *
 * A language model carries a KV cache that grows with context; a diffusion
 * model carries activations that grow with resolution. 1.25 covers a working
 * context on the first and a 1024px render on the second, which is what these
 * recommendations are for.
 */
const OVERHEAD = 1.25;

/** Memory this many parameters need at this quant, in GB. */
export function memoryForQuant(paramsB: number, rung: QuantRung): number {
  return paramsB * rung.bpw * OVERHEAD;
}

export interface QuantChoice {
  readonly rung: QuantRung;
  readonly estimatedGB: number;
}

/**
 * The best quant of this ladder that fits the budget, or undefined when even
 * the floor does not.
 *
 * Undefined is the signal to step down a model size — it is not a failure, it
 * is the whole mechanism by which the floor is enforced.
 */
export function quantForBudget(
  paramsB: number,
  budgetGB: number,
  ladder: readonly QuantRung[] = TEXT_LADDER,
): QuantChoice | undefined {
  for (const rung of ladder) {
    const need = memoryForQuant(paramsB, rung);
    if (need <= budgetGB) return { rung, estimatedGB: Math.round(need * 10) / 10 };
  }
  return undefined;
}

/**
 * Does the floor rule apply to this model?
 *
 * the user's rule is scoped to models under 100B, and the exception is deliberate:
 * a 400B MoE at Q2 is still a far better model than anything that fits
 * otherwise, and refusing it would leave a 128 GB workstation running a 27B.
 */
export function floorApplies(paramsB: number): boolean {
  return paramsB < 100;
}
