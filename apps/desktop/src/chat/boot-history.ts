/**
 * How long the two boot waits actually take ON THIS MAC.
 *
 * The tester's four were name, timer, estimate, cancel. The pill had the first
 * two and no estimate at all — and she is right that the estimate was never
 * supposed to be a percentage: "after my second launch, the app knows this Mac
 * takes about eight seconds. That's a ground truth the app can check, which by
 * my own rule means the app reports it."
 *
 * So the same shape as the long-job history and for the same reason: shipped
 * guesses are about somebody else's hardware, and this is per-machine, worthless
 * elsewhere, and must never be able to fail anything — every access is wrapped
 * and a throw means "no history".
 */
import { estimateFor } from './long-job';

export type BootWait = 'model-load' | 'prompt-load';

const KEY = 'pd.bootWaits.v1';
/** Enough to be a distribution, few enough that a machine that got faster is
 * not haunted by last month. */
const KEEP = 10;

type Store = Partial<Record<BootWait, number[]>>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/**
 * The typical duration of this wait on this machine, in seconds — or null until
 * it has happened twice, because one sample is an anecdote and quoting it as
 * "usually" would be the invented-number mistake in a new costume.
 */
export function typicalBootSeconds(wait: BootWait): number | null {
  const samples = read()[wait];
  const usable = Array.isArray(samples)
    ? samples.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  if (usable.length < 2) return null;
  const est = estimateFor('other', usable);
  if (!est.measured) return null;
  return (est.lowSec + est.highSec) / 2;
}

/** Record a finished wait. Absurd durations are dropped rather than stored — a
 * "wait" of a tenth of a second did not happen, and one of ten minutes was a
 * machine that went to sleep. */
export function recordBootWait(wait: BootWait, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 600) return;
  try {
    const store = read();
    const next = [...(store[wait] ?? []), Math.round(seconds * 10) / 10].slice(-KEEP);
    localStorage.setItem(KEY, JSON.stringify({ ...store, [wait]: next }));
  } catch {
    // A full or disabled localStorage costs a better estimate, nothing more.
  }
}
