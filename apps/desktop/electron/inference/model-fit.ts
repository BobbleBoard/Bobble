/**
 * Will this model fit in this machine's memory?
 *
 * Pure arithmetic — no electron, no llama-server — so it unit-tests in plain
 * Node, exactly like `corp/concurrency.ts`. It lives outside supervisor-entry.ts
 * because that file is a worker entry: importing it runs `parentPort.on(...)`
 * and throws anywhere else.
 *
 * WHY IT EXISTS. The user, while a 27B was coming up on a 24GB Mac: "whole computer
 * now has lots of lag and purple flashes on parts of the screen, stuttering of
 * mouse cursor etc. not good, checkerboardings..." — then: "we should have
 * guards in place to ensure based on available memory we're not straining
 * anything to a dangerous point."
 *
 * A model that does not fit does not fail cleanly. It swaps, and the whole
 * desktop goes with it — the app is the least of what degrades. Refusing with a
 * readable reason is strictly better than delivering that.
 */

const GiB = 1024 ** 3;

/**
 * Held back for macOS **and this app** — as a FRACTION of the machine, not a
 * constant.
 *
 * MEASURED, and this is a correction twice over. It began at 2GiB ("the OS"),
 * which let a 17.1GB Qwen3.6-27B pass on a 24GB Mac. It does not fit: Electron,
 * the renderer, the pi child, the role sessions and the KV cache all want memory
 * too, and the app is the thing ASKING for the model. Swap climbed to 5.4GB,
 * free memory hit 17%, the turn produced nothing, and the user watched an empty
 * thread wondering what was going on.
 *
 * Raising it to a flat 7GiB then broke the other end: an 8GB machine would have
 * had 1GB left and been refused the 4.6GB model that IS its shipping default. A
 * constant cannot be right at both ends of a 16× range. 30% scales: it refuses
 * the 27B on 24GB (16.8GB usable vs 17.1GB needed) while leaving an 8GB machine
 * 5.6GB — comfortably enough for the 4B it is meant to run.
 */
export const RAM_RESERVE_FRACTION = 0.3;
/** Never reserve less than this, however small the machine claims to be. */
export const RAM_RESERVE_FLOOR_BYTES = 2 * GiB;

/*
 * NOTE the corp's 75% usable-fraction is deliberately NOT used here. That figure
 * answers a different question — how many EXTRA full-context KV slots fit on top
 * of weights already resident — and applying it to the weights themselves
 * refuses configurations the app actually ships: a 4.6GB Q8 4B on an 8GB machine
 * is the recommender's own 8GB tier, and 8 × 0.75 − 2 = 4GB would have blocked it.
 *
 * The honest question here is narrower: can this machine hold these weights AT
 * ALL, alongside the OS? One 27B on a 24GB Mac can, and did. TWO could not — and
 * two is what actually happened, from a start race that is fixed separately in
 * supervisor-entry. A guard sized to catch the race would have punished every
 * legitimate large-model user for a bug elsewhere.
 */

export type FitResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const gb = (b: number): string => `${(b / GiB).toFixed(1)}GB`;

/**
 * Deliberately GENEROUS. This catches only the case that takes the desktop down
 * with it, not every tight fit: a model that merely leaves little headroom still
 * starts. A guard that blocks work people could have done is its own failure.
 *
 * Unknown or nonsense inputs always pass — a guard that guesses is worse than no
 * guard, because it refuses things that would have worked and gives a reason
 * that is not true.
 */
export function modelFitsInRam(modelBytes: number, totalRamBytes: number): FitResult {
  if (!Number.isFinite(modelBytes) || modelBytes <= 0) return { ok: true };
  if (!Number.isFinite(totalRamBytes) || totalRamBytes <= 0) return { ok: true };
  const reserve = Math.max(RAM_RESERVE_FLOOR_BYTES, totalRamBytes * RAM_RESERVE_FRACTION);
  const budget = totalRamBytes - reserve;
  if (modelBytes <= budget) return { ok: true };
  return {
    ok: false,
    reason:
      `This model needs about ${gb(modelBytes)} of memory and this machine has ` +
      `${gb(totalRamBytes)} in total, leaving about ${gb(Math.max(0, budget))} once macOS ` +
      `and this app have their share. ` +
      `Running it would push the whole system into swap. Choose a smaller model.`,
  };
}
