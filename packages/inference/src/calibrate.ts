/**
 * CALIBRATION — which engine and which speculative method is fastest for THIS
 * model on THIS machine, decided by measurement rather than by a table.
 *
 * the user: "clicking calibrate pauses anything running in the current chat, then
 * runs the calibration and swaps to the proper engine and speculative method,
 * ensure this doesn't require internet to run".
 *
 * The published numbers disagree with each other by machine and by workload
 * (MTP on llama.cpp's Metal path is a loss in one 2026 review and 2.6× in
 * MTPLX on the same model; DFlash is 2.1× on a math prompt and 1.37× on prose
 * — measured here), so the only number that counts is the one taken on the
 * user's Mac with the app's own prompt shapes. This module is the PURE half:
 * which configurations are worth trying (from what is on disk — nothing is
 * downloaded), how a measurement is summarised, and how a winner is picked.
 * Launching servers and timing requests is the supervisor's half.
 */

export type CalibEngine =
  | 'llamacpp'
  | 'mlx-lm'
  | 'rapid-mlx'
  | 'dflash-mlx'
  | 'mlx-dspark'
  | 'omlx'
  | 'vllm';

/** How the engine is asked to speculate. `auto` = the engine's own choice. */
export type CalibSpec = 'none' | 'mtp' | 'eagle3' | 'dflash' | 'dspark' | 'ngram' | 'auto';

/** A way to run the model: the thing calibration chooses between and persists. */
export interface LaunchProfile {
  readonly engine: CalibEngine;
  readonly spec: CalibSpec;
}

export interface CalibrationCandidate extends LaunchProfile {
  /** `${engine}/${spec}` — stable across runs, the key results are stored under. */
  readonly id: string;
  /** What the row says in the menu. */
  readonly label: string;
}

/** A candidate that exists in principle but cannot be measured right now, and why. */
export interface CalibrationSkip extends CalibrationCandidate {
  readonly reason: string;
}

/**
 * What the planner knows about the machine and the disk. Everything here is a
 * fact somebody already checked; the planner never touches the filesystem.
 */
export interface CalibrationInput {
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly appleSilicon: boolean;
  /** Engines whose install is complete on this machine. */
  readonly installedEngines: readonly CalibEngine[];
  /** The GGUF is on disk (llama.cpp can run it). */
  readonly ggufPresent: boolean;
  /** The model has multi-token-prediction heads llama.cpp can use (embedded or sibling on disk). */
  readonly mtpAvailable: boolean;
  /** Draft GGUFs on disk, by method. */
  readonly draftsPresent: readonly ('eagle3' | 'dflash' | 'dspark')[];
  /** The MLX weights (the model's MLX twin) are in the HF cache. */
  readonly mlxPresent: boolean;
  /** MLX drafters on disk, by method (DFlash adapters, DSpark heads). */
  readonly mlxDraftsPresent: readonly ('dflash' | 'dspark')[];
  /** MTP heads for the MLX twin are on disk — in the twin itself, or as the
   * separate sidecar the catalogue names. */
  readonly mlxMtpAvailable?: boolean;
}

const LABELS: Record<CalibEngine, string> = {
  llamacpp: 'llama.cpp',
  'mlx-lm': 'mlx-lm',
  'rapid-mlx': 'rapid-mlx',
  'dflash-mlx': 'DFlash (MLX)',
  'mlx-dspark': 'mlx-dspark',
  omlx: 'oMLX',
  vllm: 'vLLM',
};

const SPEC_LABEL: Record<CalibSpec, string> = {
  none: 'plain',
  mtp: 'MTP',
  eagle3: 'EAGLE-3',
  dflash: 'DFlash',
  dspark: 'DSpark',
  ngram: 'n-gram',
  auto: 'auto',
};

export function candidateOf(engine: CalibEngine, spec: CalibSpec): CalibrationCandidate {
  return {
    engine,
    spec,
    id: `${engine}/${spec}`,
    label: `${LABELS[engine]} · ${SPEC_LABEL[spec]}`,
  };
}

/**
 * Which configurations to measure, from what is on disk. Every candidate is
 * runnable offline by construction; things that WOULD be candidates with a
 * download are listed as skips so the menu can say what is missing.
 *
 * llama.cpp is always first and always present (the baseline everything is
 * compared against) — the user: "on any machine we always have llamacpp first and
 * foremost".
 */
export function planCandidates(input: CalibrationInput): {
  candidates: CalibrationCandidate[];
  skips: CalibrationSkip[];
} {
  const candidates: CalibrationCandidate[] = [];
  const skips: CalibrationSkip[] = [];
  const has = (e: CalibEngine): boolean => input.installedEngines.includes(e);

  if (input.ggufPresent) {
    candidates.push(candidateOf('llamacpp', 'none'));
    if (input.mtpAvailable) candidates.push(candidateOf('llamacpp', 'mtp'));
    for (const m of ['eagle3', 'dflash', 'dspark'] as const) {
      if (input.draftsPresent.includes(m)) candidates.push(candidateOf('llamacpp', m));
      else
        skips.push({ ...candidateOf('llamacpp', m), reason: `no ${SPEC_LABEL[m]} draft on disk` });
    }
    // Model-free: the server's own n-gram cache. Costs nothing to try, wins on
    // repetitive text (code, edits) and loses on prose — which is why it is
    // measured rather than assumed.
    candidates.push(candidateOf('llamacpp', 'ngram'));
  } else {
    skips.push({ ...candidateOf('llamacpp', 'none'), reason: 'GGUF not downloaded' });
  }

  const mlxEngines: CalibEngine[] = ['mlx-lm', 'rapid-mlx', 'dflash-mlx', 'mlx-dspark', 'omlx'];
  if (input.platform === 'darwin' && input.appleSilicon) {
    for (const e of mlxEngines) {
      if (!has(e)) {
        skips.push({ ...candidateOf(e, 'none'), reason: 'engine not installed' });
        continue;
      }
      if (!input.mlxPresent) {
        skips.push({ ...candidateOf(e, 'none'), reason: 'MLX weights not downloaded' });
        continue;
      }
      switch (e) {
        case 'mlx-lm':
          candidates.push(candidateOf('mlx-lm', 'none'));
          break;
        case 'rapid-mlx':
          candidates.push(candidateOf('rapid-mlx', 'none'));
          if (input.mlxMtpAvailable === true) candidates.push(candidateOf('rapid-mlx', 'mtp'));
          else skips.push({ ...candidateOf('rapid-mlx', 'mtp'), reason: 'no MTP head on disk' });
          // rapid-mlx's DFlash path is the dflash-mlx package underneath, so
          // it is a candidate exactly when that engine and the drafter are.
          if (has('dflash-mlx') && input.mlxDraftsPresent.includes('dflash'))
            candidates.push(candidateOf('rapid-mlx', 'dflash'));
          break;
        case 'dflash-mlx':
          if (input.mlxDraftsPresent.includes('dflash'))
            candidates.push(candidateOf('dflash-mlx', 'dflash'));
          else
            skips.push({
              ...candidateOf('dflash-mlx', 'dflash'),
              reason: 'no DFlash drafter on disk',
            });
          break;
        case 'mlx-dspark':
          // Drafter-free lookup runs on any repo; the drafted modes need their heads.
          candidates.push(candidateOf('mlx-dspark', 'ngram'));
          for (const m of ['dspark', 'dflash'] as const) {
            if (input.mlxDraftsPresent.includes(m)) candidates.push(candidateOf('mlx-dspark', m));
            else
              skips.push({
                ...candidateOf('mlx-dspark', m),
                reason: `no ${SPEC_LABEL[m]} drafter on disk`,
              });
          }
          break;
        case 'omlx':
          candidates.push(candidateOf('omlx', 'none'));
          break;
        default:
          break;
      }
    }
  }
  if (input.platform === 'linux' && has('vllm') && input.mlxPresent === false) {
    // vLLM serves safetensors; the GGUF twin is a different artifact. Measured
    // when a safetensors copy is present — reported through `mlxPresent`'s
    // sibling field is a follow-up; for now vLLM is planned only when installed.
    candidates.push(candidateOf('vllm', 'none'));
  }
  return { candidates, skips };
}

// ── measurement ──────────────────────────────────────────────────────────────

/** One timed request. */
export interface BenchSample {
  /** Prompt tokens per second: prompt size over time-to-first-token. */
  readonly prefillTps: number;
  /** Completion tokens per second after the first token. */
  readonly decodeTps: number;
  readonly ttftMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface CalibrationResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  /** Medians over the samples (0 when not ok). */
  readonly prefillTps: number;
  readonly decodeTps: number;
  readonly ttftMs: number;
  /** How long the server took to come up, ms — the cost of switching to it. */
  readonly startupMs: number;
  readonly samples: readonly BenchSample[];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function summarise(
  id: string,
  samples: readonly BenchSample[],
  startupMs: number,
  error?: string,
): CalibrationResult {
  if (error !== undefined || samples.length === 0) {
    return {
      id,
      ok: false,
      error: error ?? 'no samples',
      prefillTps: 0,
      decodeTps: 0,
      ttftMs: 0,
      startupMs,
      samples,
    };
  }
  return {
    id,
    ok: true,
    prefillTps: median(samples.map((s) => s.prefillTps)),
    decodeTps: median(samples.map((s) => s.decodeTps)),
    ttftMs: median(samples.map((s) => s.ttftMs)),
    startupMs,
    samples,
  };
}

/**
 * From a streamed request: when the first token arrived, when the last did,
 * how many of each. Pure so the timing math is tested without a server.
 */
export function sampleFromTimings(t: {
  readonly sentAt: number;
  readonly firstTokenAt: number;
  readonly lastTokenAt: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}): BenchSample {
  const ttftMs = Math.max(1, t.firstTokenAt - t.sentAt);
  const decodeMs = Math.max(1, t.lastTokenAt - t.firstTokenAt);
  return {
    prefillTps: (t.promptTokens / ttftMs) * 1000,
    decodeTps: (Math.max(0, t.completionTokens - 1) / decodeMs) * 1000,
    ttftMs,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
  };
}

/**
 * From llama.cpp's own `timings` block (the last SSE chunk), which is exact
 * where wall-clock is approximate: prompt and predicted token counts and the
 * milliseconds each phase took, measured inside the server.
 */
export function sampleFromServerTimings(t: {
  readonly prompt_n?: number;
  readonly prompt_ms?: number;
  readonly predicted_n?: number;
  readonly predicted_ms?: number;
}): BenchSample | null {
  const promptN = t.prompt_n ?? 0;
  const promptMs = t.prompt_ms ?? 0;
  const predN = t.predicted_n ?? 0;
  const predMs = t.predicted_ms ?? 0;
  if (promptN <= 0 || promptMs <= 0 || predN <= 0 || predMs <= 0) return null;
  return {
    prefillTps: (promptN / promptMs) * 1000,
    decodeTps: (predN / predMs) * 1000,
    ttftMs: promptMs,
    promptTokens: promptN,
    completionTokens: predN,
  };
}

/** What a running calibration reports, one message per step, in order. */
export type CalibrationProgress =
  | {
      readonly stage: 'planned';
      readonly candidates: CalibrationCandidate[];
      readonly skips: CalibrationSkip[];
    }
  | {
      readonly stage: 'starting';
      readonly id: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly stage: 'measuring';
      readonly id: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly stage: 'result';
      readonly result: CalibrationResult;
      readonly index: number;
      readonly total: number;
    }
  | { readonly stage: 'switching'; readonly chosen: LaunchProfile }
  | { readonly stage: 'done'; readonly record: CalibrationRecord }
  | { readonly stage: 'cancelled' }
  | { readonly stage: 'failed'; readonly error: string };

// ── choosing ─────────────────────────────────────────────────────────────────

export interface CalibrationWeights {
  /** Weight on decode speed (long answers). */
  readonly decode: number;
  /** Weight on prefill speed (long prompts, every follow-up's first token). */
  readonly prefill: number;
  /**
   * How much better than the baseline a config has to be before it is chosen
   * over it — measurement noise on a shared machine is a few percent, and a
   * switch that is not clearly a win costs a restart for nothing.
   */
  readonly minGain: number;
}

export const DEFAULT_WEIGHTS: CalibrationWeights = { decode: 0.6, prefill: 0.4, minGain: 1.05 };

export interface RankedResult extends CalibrationResult {
  /** Relative to the baseline: 1.0 is "the same as llama.cpp plain". */
  readonly score: number;
}

/**
 * Rank the results against the baseline (`llamacpp/none`, or the first ok
 * result when there is none) and pick the winner. A failed candidate ranks
 * last with its error kept, so the menu can say why.
 */
export function chooseProfile(
  results: readonly CalibrationResult[],
  weights: CalibrationWeights = DEFAULT_WEIGHTS,
): { ranked: RankedResult[]; chosen: RankedResult | null; baseline: CalibrationResult | null } {
  const ok = results.filter((r) => r.ok && r.decodeTps > 0);
  const baseline = ok.find((r) => r.id === 'llamacpp/none') ?? ok[0] ?? null;
  const scoreOf = (r: CalibrationResult): number => {
    if (!r.ok || baseline === null || baseline.decodeTps <= 0 || baseline.prefillTps <= 0) return 0;
    const d = r.decodeTps / baseline.decodeTps;
    const p = r.prefillTps / baseline.prefillTps;
    return weights.decode * d + weights.prefill * p;
  };
  const ranked = results
    .map((r) => ({ ...r, score: scoreOf(r) }))
    .sort((a, b) => b.score - a.score || Number(b.ok) - Number(a.ok));
  if (baseline === null) return { ranked, chosen: null, baseline };
  const best = ranked[0] ?? null;
  const baselineRanked = ranked.find((r) => r.id === baseline.id) ?? null;
  if (best === null || baselineRanked === null) return { ranked, chosen: baselineRanked, baseline };
  const chosen = best.id === baseline.id || best.score >= weights.minGain ? best : baselineRanked;
  return { ranked, chosen, baseline };
}

/** `llamacpp/mtp` → { engine, spec }. */
export function profileOf(id: string): LaunchProfile | null {
  const [engine, spec] = id.split('/') as [string, string];
  if (!(engine in LABELS) || !(spec in SPEC_LABEL)) return null;
  return { engine: engine as CalibEngine, spec: spec as CalibSpec };
}

/** What a calibration is keyed on: the same model on a different machine, or a different engine build, starts over. */
export function hardwareKey(hw: {
  readonly platform: string;
  readonly arch: string;
  readonly chip?: string;
  readonly totalRamGB: number;
}): string {
  return `${hw.platform}-${hw.arch}-${(hw.chip ?? 'cpu').replace(/\s+/g, '_')}-${Math.round(hw.totalRamGB)}GB`;
}

/** The record persisted per model. */
export interface CalibrationRecord {
  readonly modelId: string;
  readonly quant: string;
  readonly hardwareKey: string;
  /** The llama.cpp build the llama.cpp rows were measured with. */
  readonly engineBuild: string;
  readonly at: string;
  readonly ranked: readonly RankedResult[];
  readonly skips: readonly CalibrationSkip[];
  readonly chosen: LaunchProfile | null;
}

/**
 * The fixed prompts every calibration uses, so numbers compare across runs.
 *
 * TWO RULES, both learned by measuring the wrong thing first:
 *
 *  - THE ANSWER MUST NOT BE COPYABLE FROM THE PROMPT. The first version asked
 *    the model to summarise a repeated paragraph, and llama.cpp's n-gram
 *    speculation scored 114.8 tok/s against a 43.3 plain baseline — 2.65× —
 *    because the "summary" was the paragraph's own sentences, which an n-gram
 *    drafter predicts for free. Real chat answers are not in the prompt. So
 *    the context is there to be prefilled (that is what prefill measures) and
 *    the task is a short piece of new prose the model has to make up.
 *  - THE CONTEXT IS VARIED PROSE, not one paragraph repeated, for the same
 *    reason at the prefill/KV level: a drafter that keys on repetition should
 *    see what it would see in a conversation.
 *
 * Deterministic text of a known rough size; the same on every machine.
 */
export function benchPrompts(): {
  name: string;
  system: string;
  user: string;
  maxTokens: number;
}[] {
  const paragraphs = [
    'The harbour town keeps its records in a long building by the water, where the clerk writes each arrival in a ledger and the tide tables are pinned beside the door. Visitors ask about the ferries, the market days, and the road over the hill.',
    'Further inland the orchards begin, apple and pear in alternating rows, with a stone wall that follows the contour of the slope rather than the survey line. In autumn the pickers arrive from three villages and sleep in the long barn.',
    'The observatory on the ridge was built for a comet that never returned; its dome now houses a small radio telescope and a logbook in which the volunteers note the weather, the visitors, and the occasional fox on the path.',
    'A bakery on the square opens at five, sells out of rye by nine, and closes when the second batch is gone. The owner keeps a chalkboard of the day’s flour, the oven temperature, and a single sentence about the weather.',
    'The river changes its name twice before the sea: it is the Lesser Ash above the mill, the Ash below it, and the Ashmouth where the barges turn. Old maps disagree about exactly where each name begins.',
    'The school has one classroom for every two years of age and a library that doubles as the polling station. The children plant beans in March, measure them weekly, and argue every year about whether the north window gets more sun.',
    'On the far side of the estuary a lighthouse, automated since the seventies, still has a keeper’s cottage with a kettle and a chair. Walkers leave notes in a tin; the coastguard collects them in spring.',
    'The market on Thursdays sells cheese from two farms, honey from one, and fish from whichever boats came in that morning. Prices are written on slate and argued about in a friendly way for most of the morning.',
  ];
  const context = (n: number): string =>
    Array.from({ length: n }, (_, i) => `${i + 1}. ${paragraphs[i % paragraphs.length]}`).join(
      '\n',
    );
  return [
    /* The story topics share NOTHING with the notes above — the first draft
       asked for a lighthouse keeper beside a paragraph about a lighthouse, and
       the n-gram drafter copied the cottage, the kettle and the chair. */
    {
      name: 'chat',
      system: `You are a careful assistant. Background notes about the town:\n${context(6)}`,
      user: 'Write a short story of about 120 words about a robot learning to paint. Prose only, no preamble.',
      maxTokens: 96,
    },
    {
      name: 'long',
      system: `You are a careful assistant. Background notes about the town:\n${context(40)}`,
      user: 'Write a short story of about 120 words about an astronaut’s first morning on a space station. Prose only, no preamble.',
      maxTokens: 96,
    },
  ];
}
