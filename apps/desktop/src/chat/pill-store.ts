/**
 * THE PILL, AS A PLACE ANYTHING CAN SPEAK FROM.
 *
 * the user: "I like this floating pill idea and would like to extend it a bit. so
 * let's go for making this modular."
 *
 * It started as a component that knew about exactly three things — a model
 * loading, a prompt loading, and an image a model cannot read — with the
 * conditions for each written into its body. That is the shape that grows a
 * fourth `if` every week until nobody can say what the pill will show.
 *
 * So the pill is now a SLOT with one rule: whatever is most urgent, and only
 * one at a time. Anything in the app can publish into it —
 *
 *     const id = showPill({ text: 'Reconnecting…', tone: 'busy', spinner: true });
 *     dismissPill(id);
 *
 * — and the two waits that were hard-wired stay hard-wired only because they are
 * DERIVED from store state rather than announced by an event (a wait cannot
 * forget to dismiss itself if nobody had to remember to).
 */
import { create } from 'zustand';
import type { PillTone } from './composer-pill';

export interface PillSpec {
  readonly id: string;
  readonly text: string;
  readonly tone: PillTone;
  /** Show a spinner rather than an icon — for something still in progress. */
  readonly spinner?: boolean;
  /**
   * Higher wins when several want the slot. The derived waits sit at 100 (a
   * model that cannot answer outranks anything about a message it has not been
   * asked yet); ad-hoc entries default to 50.
   */
  readonly priority?: number;
  /** Auto-dismiss after this long. Omit for one that stays until dismissed. */
  readonly ttlMs?: number;
}

interface PillStore {
  pills: PillSpec[];
  show: (spec: PillSpec) => void;
  dismiss: (id: string) => void;
}

export const usePillStore = create<PillStore>((set) => ({
  pills: [],
  // Replacing by id rather than appending: a source that publishes on every tick
  // (a countdown, a retry) should update its pill, not stack a hundred of them.
  show: (spec) => set((s) => ({ pills: [...s.pills.filter((p) => p.id !== spec.id), spec] })),
  dismiss: (id) => set((s) => ({ pills: s.pills.filter((p) => p.id !== id) })),
}));

/* E2E hook, on the same `?piE2E=1` opt-in as the other store accessors: a probe
 * has to be able to publish into the slot to prove anything can. */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __pill: () => typeof usePillStore }).__pill = () => usePillStore;
}

let seq = 0;

/** Publish a pill. Returns its id, for {@link dismissPill}. */
export function showPill(spec: Omit<PillSpec, 'id'> & { id?: string }): string {
  const id = spec.id ?? `pill-${++seq}`;
  usePillStore.getState().show({ ...spec, id });
  if (spec.ttlMs !== undefined) {
    setTimeout(() => usePillStore.getState().dismiss(id), spec.ttlMs);
  }
  return id;
}

export function dismissPill(id: string): void {
  usePillStore.getState().dismiss(id);
}
