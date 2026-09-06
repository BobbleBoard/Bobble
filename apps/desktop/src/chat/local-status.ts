/**
 * "Running on your Mac" — the one sentence that says what this app IS, and the
 * model name reduced to what it should always have been: small grey text under
 * it.
 *
 * From the blind test. The tester's single hardest note was not about a feature:
 * "Nothing on screen says this never leaves my Mac. That's the entire reason to
 * pick it over ChatGPT and it's not mentioned once." Meanwhile "qwen3.5 9b
 * (mtp)" WAS on screen, as a headline, in a vocabulary she could not read.
 * the user's call: grey the model name, say the local thing.
 *
 * The second job is the wait. The same tester watched a progress bar park at 99%
 * and decided the app was lying to her — it wasn't, it was just badly built.
 * Her rule, adopted here: while a model loads, NO percentage. A named event and
 * an elapsed count instead, because "a number going up is more trustworthy than
 * a number that stops."
 *
 * Pure so it unit-tests without a store or a window.
 */

/** The live inputs — a subset of LlmStatus plus what the user has chosen. */
export interface LocalStatusInput {
  /** LlmStatus.phase. */
  phase: 'idle' | 'downloading' | 'starting' | 'ready' | 'error';
  /** Friendly name of the RESIDENT model, when one is loaded. */
  loadedName: string | null;
  /** Friendly name of the model that is coming up / was chosen, when known. */
  pendingName: string | null;
  /** Milliseconds since this phase began (drives the elapsed count). */
  elapsedMs: number | null;
}

export type LocalDot = 'ready' | 'working' | 'off' | 'error';

export interface LocalStatusView {
  /** The readable line. Never a model id, never a percentage. */
  headline: string;
  /** The grey line under it: the model, or null when there is nothing to name. */
  detail: string | null;
  dot: LocalDot;
}

/** 0 → null, 12_400 → "0:12", 95_000 → "1:35". Seconds only after the minute. */
export function elapsedClock(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 1000) return null;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The sidebar's local-model line.
 *
 * The headline stays a full sentence in every state, because it is the app's
 * claim about itself and a claim that flickers is worse than no claim. Only the
 * verb changes: running / starting / downloading.
 */
export function localStatusView(input: LocalStatusInput): LocalStatusView {
  const { phase, loadedName, pendingName, elapsedMs } = input;
  const name = loadedName ?? pendingName;
  const clock = elapsedClock(elapsedMs);
  const withClock = (s: string): string => (clock === null ? s : `${s} · ${clock}`);

  if (phase === 'ready' && loadedName !== null)
    return { headline: 'Running on your Mac', detail: loadedName, dot: 'ready' };
  if (phase === 'starting')
    return {
      headline: withClock('Starting on your Mac'),
      // The model is still the grey line — naming it here would make the
      // headline the thing that moves, and the headline is the promise.
      detail: name,
      dot: 'working',
    };
  if (phase === 'downloading')
    return { headline: withClock('Downloading to your Mac'), detail: name, dot: 'working' };
  if (phase === 'error') return { headline: 'Model could not start', detail: name, dot: 'error' };
  // idle, or ready with nothing resident: honest and quiet, still local.
  return {
    headline: 'Runs on your Mac',
    detail: name ?? 'No model loaded yet',
    dot: 'off',
  };
}
