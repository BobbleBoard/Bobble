/**
 * HOW LONG A 3D STAGE WILL TAKE, BEFORE IT IS STARTED.
 *
 * the user's requirement for the studio: it should "give reasonable accurate
 * estimates if long times for generation". Several of these stages run for
 * minutes with a progress bar that cannot know its own length — a segment run
 * is ten minutes of diffusion — and a button that says only "Segment Parts"
 * asks the user to gamble their afternoon on it.
 *
 * WHERE THE NUMBERS COME FROM. Every one is a MEASURED wall-clock time from
 * this machine (M5 Pro, 24 GB unified) rather than a guess, taken while
 * building and verifying each stage:
 *
 *   image (Mage-Flow, MLX 8-bit)         11 s
 *   generate 512  (geometry + texture)  204 s
 *   generate 1024 (geometry + texture)  462 s   (352 s geometry + 110 s bake)
 *   texture, re-bake from voxels        120 s   at a 4096 atlas
 *   texture, painted from an image      165 s   incl. ~31 s pipeline load
 *   retopo (QuadriFlow + bake)          180 s   at the adaptive ~91k quads
 *   rig, template                        60 s
 *   rig, SkinTokens                     150 s
 *   segment (CubePart)                  660 s   4 parts
 *   motion (ARDY)                        20 s   after its encoder is warm
 *
 * SCALING TO OTHER MACS. These stages are memory-bandwidth bound far more than
 * core-count bound, and the honest signal available to the renderer is the
 * machine's RAM, which tracks the tier closely on Apple Silicon (8/16 GB Air
 * and base Pro, 24-36 GB Pro, 48 GB+ Max and Ultra). So the estimate scales off
 * that, gently — a factor, not a model. It is deliberately conservative on
 * small machines, because an estimate that runs under is a broken promise while
 * one that runs over is a pleasant surprise.
 *
 * The point is a right ORDER OF MAGNITUDE, and the copy says "about" for the
 * same reason. Anyone who needs the real number watches the progress line.
 */

/** Seconds, measured on the reference machine — see the file docstring. */
const BASELINE_SECONDS: Readonly<Record<string, number>> = {
  image: 11,
  'generate:low': 204,
  'generate:medium': 462,
  'generate:high': 1800,
  'texture:rebake': 120,
  'texture:paint': 165,
  retopo: 180,
  'rig:template': 60,
  'rig:skintokens': 150,
  'rig:medial': 20,
  segment: 660,
  motion: 20,
};

/** The machine these numbers were taken on. */
const REFERENCE_MEMORY_GB = 24;

/**
 * How much slower than the reference machine this one is likely to be.
 *
 * Square-rooted on purpose: memory is a proxy for the whole tier (bandwidth,
 * GPU cores, cache), and those do not fall off as fast as the RAM number does.
 * A straight ratio would tell an 8 GB Air a segment takes half an hour, which
 * is further from the truth than saying twenty minutes. Clamped so no machine
 * is promised better than the reference or threatened with more than 3x.
 */
export function machineFactor(totalMemoryBytes: number): number {
  const gb = totalMemoryBytes / 1024 ** 3;
  if (!Number.isFinite(gb) || gb <= 0) return 1;
  return Math.min(3, Math.max(1, Math.sqrt(REFERENCE_MEMORY_GB / gb)));
}

export interface EstimateInput {
  readonly key: string;
  readonly totalMemoryBytes: number;
  /** Faces of the mesh going in, when the stage's cost scales with it. */
  readonly faces?: number;
}

/** Seconds this stage should take here, or null when there is no measurement. */
export function estimateSeconds({ key, totalMemoryBytes, faces }: EstimateInput): number | null {
  const base = BASELINE_SECONDS[key];
  if (base === undefined) return null;
  let seconds = base * machineFactor(totalMemoryBytes);
  // Retopo and the bakes walk the mesh, so a model well off the ~300k the
  // measurements used moves the number. Damped: the fixed costs (model load,
  // UV unwrap) do not scale with it.
  if (faces !== undefined && faces > 0 && (key.startsWith('texture') || key === 'retopo')) {
    seconds *= 0.5 + 0.5 * Math.min(3, faces / 300_000);
  }
  return Math.round(seconds);
}

/**
 * "about 3 min" — the phrasing the buttons and panels use.
 *
 * Rounded coarsely on purpose: "about 2 min" is a promise anyone can hold you
 * to, "about 1 min 47 s" pretends to a precision these stages do not have.
 */
export function formatEstimate(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  if (seconds < 45) return 'about 30 sec';
  if (seconds < 90) return 'about a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 10) return `about ${minutes} min`;
  return `about ${Math.round(minutes / 5) * 5} min`;
}

/** The estimate key for a stage, given how it is going to run. */
export function stageKey(
  op: 'segment' | 'retopo' | 'texture' | 'rig' | 'motion',
  opts: { readonly painting?: boolean; readonly rigger?: string } = {},
): string {
  if (op === 'texture') return opts.painting === true ? 'texture:paint' : 'texture:rebake';
  if (op === 'rig') return `rig:${opts.rigger ?? 'template'}`;
  return op;
}
