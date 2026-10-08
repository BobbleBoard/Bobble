/**
 * FIRST-USE INTROS — the design language's intro card (design/language,
 * "In the app"): it opens centred the first time a feature is used, with the
 * feature's demo on top, its name, what it does for you, and "Got it".
 *
 * Seen-ness is per Mac and per feature, kept in localStorage like the other
 * small UI memories here; an intro that has been dismissed never comes back on
 * its own. Under `?piE2E` (every probe) nothing opens by itself, because a scrim
 * appearing over a studio would swallow a probe's first click; a probe that
 * wants to photograph one asks for it through `window.__pi_intro(id)`.
 */
import { create } from 'zustand';

export type IntroId = 'studio3d' | 'computerUse';

const SEEN_KEY = 'pd-intro-seen-v1';

function readSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const list: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Whether an intro or a tip (`tip:<id>`) has been seen on this Mac. */
export function hasSeen(id: string): boolean {
  return readSeen().has(id);
}

/** Remember an intro or a tip (`tip:<id>`) as seen. */
export function markSeenId(id: string): void {
  try {
    const seen = readSeen();
    seen.add(id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* A Mac that will not store it shows it again next time; harmless. */
  }
}

const markSeen = (id: IntroId): void => markSeenId(id);

const underTest = (): boolean =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E');

interface IntroState {
  readonly open: IntroId | null;
  readonly show: (id: IntroId) => void;
  readonly dismiss: () => void;
}

export const useIntroStore = create<IntroState>((set, get) => ({
  open: null,
  show: (id) => set({ open: id }),
  dismiss: () => {
    const id = get().open;
    if (id !== null) markSeen(id);
    set({ open: null });
  },
}));

/** Open the intro for `id` if it has never been seen on this Mac. */
export function introduce(id: IntroId): void {
  if (underTest()) return;
  if (readSeen().has(id)) return;
  if (useIntroStore.getState().open !== null) return;
  useIntroStore.getState().show(id);
}

if (underTest()) {
  (window as unknown as { __pi_intro?: (id: IntroId) => void }).__pi_intro = (id) =>
    useIntroStore.getState().show(id);
}
