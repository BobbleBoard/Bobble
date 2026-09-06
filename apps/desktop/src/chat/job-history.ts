/**
 * How long jobs actually take ON THIS MAC.
 *
 * The shipped estimate ranges are a guess about someone else's hardware. This
 * is the correction: every finished generation records its duration, and the
 * card quotes the middle of what this machine has really done as soon as it has
 * done it twice (see {@link estimateFor}).
 *
 * localStorage rather than the settings file on purpose. It is a per-machine
 * observation, it is worthless on another machine, nothing breaks when it is
 * missing, and it must never be able to fail a send — so every access is
 * wrapped and a throw means "no history", not an error.
 */
import type { JobKind } from './long-job';

const KEY = 'pd.jobDurations.v1';
/** Enough to be a distribution, few enough that a machine that got faster
 * (a lighter model, fewer apps open) is not haunted by last month. */
const KEEP = 12;

type Store = Partial<Record<JobKind, number[]>>;

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

/** Durations recorded for this kind, oldest first. Never throws. */
export function jobSamples(kind: JobKind): number[] {
  const v = read()[kind];
  return Array.isArray(v)
    ? v.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
}

/** Record a finished job. Absurd durations are dropped rather than stored — a
 * job that "took" a tenth of a second did not run, and one that took an hour
 * was almost certainly a machine that went to sleep. */
export function recordJobDuration(kind: JobKind, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) return;
  try {
    const store = read();
    const next = [...(store[kind] ?? []), Math.round(seconds)].slice(-KEEP);
    localStorage.setItem(KEY, JSON.stringify({ ...store, [kind]: next }));
  } catch {
    // A full or disabled localStorage costs us a better estimate, nothing more.
  }
}
