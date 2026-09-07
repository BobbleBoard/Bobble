/**
 * HOW FAST THIS MACHINE READS A PROMPT — measured, remembered, never guessed.
 *
 * The app has to be able to say "switching model here costs about 18 seconds",
 * and the only honest source for the 18 is this Mac's own prompt-processing rate
 * under the model that is loaded. llama-server reports it on every prefill
 * (`timings.prompt_n` / `prompt_ms`); this keeps a small rolling record of those
 * so the number quoted to the user is one the machine produced.
 *
 * Until it has a measurement it says NOTHING about seconds. A made-up estimate
 * on a warning is worse than no estimate: the warning exists to be trusted.
 *
 * Keyed by model id, because the rate is a property of the model as much as the
 * machine — a 27B reads a prompt several times slower than a 4B.
 */

const KEY = 'pd.prefillRate.v1';
/** Samples kept per model. Enough to shrug off one contended outlier. */
const KEEP = 7;
/** Below this the sample is noise — a handful of tokens, all overhead. */
const MIN_TOKENS = 200;

type Rates = Record<string, number[]>;

function read(): Rates {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Rates = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((n): n is number => typeof n === 'number' && n > 0);
    }
    return out;
  } catch {
    return {};
  }
}

/** Record one prompt-processing measurement. Ignores anything too small to mean
 * something, and anything the server did not actually have to read. */
export function recordPrefillRate(modelId: string, tokens: number, ms: number): void {
  if (modelId === '' || tokens < MIN_TOKENS || ms <= 0) return;
  try {
    const all = read();
    const next = [...(all[modelId] ?? []), tokens / (ms / 1000)].slice(-KEEP);
    localStorage.setItem(KEY, JSON.stringify({ ...all, [modelId]: next }));
  } catch {
    // A browsing context with storage blocked: the estimate simply stays absent.
  }
}

/** Tokens per second for this model, or null until it has been measured. */
export function prefillRate(modelId: string): number | null {
  const samples = read()[modelId];
  if (samples === undefined || samples.length === 0) return null;
  // The MEDIAN, not the mean: one prefill that landed while the GPU was busy
  // with something else would otherwise drag every quoted estimate down.
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Seconds to read `tokens` on this machine, or null if unmeasured. */
export function prefillSeconds(modelId: string, tokens: number): number | null {
  const rate = prefillRate(modelId);
  if (rate === null || rate <= 0) return null;
  return tokens / rate;
}

/** For tests. */
export function resetPrefillRates(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to clear */
  }
}
