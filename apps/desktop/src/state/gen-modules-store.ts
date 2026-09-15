/**
 * The generation MODULES, as the window knows them — the mirror of
 * electron/gen/gen-modules.ts. Main pushes every change on `gen:module`; the
 * card asks for a fresh probe when it mounts and sends the button presses.
 *
 * `wanted` is the reason the card appears in the chat on its own: a job the
 * model started is waiting at the gate for the module, and this is the person's
 * moment to press Download (the job continues) or close the card (the job ends
 * with a sentence the model can repeat).
 */

import { create } from 'zustand';
import type { GenModuleId, GenModuleState } from '../../electron/gen/gen-modules';

interface GenModulesStore {
  readonly modules: readonly GenModuleState[];
  readonly loaded: boolean;
  /** Modules whose card the person closed this session (not shown again unless wanted). */
  readonly closed: readonly GenModuleId[];
  refresh: () => Promise<void>;
  install: (id: GenModuleId) => Promise<void>;
  dismiss: (id: GenModuleId) => Promise<void>;
}

let wired = false;
function wire(set: (patch: Partial<GenModulesStore>) => void): void {
  if (wired) return;
  wired = true;
  if (typeof window === 'undefined' || window.piDesktop === undefined) return;
  window.piDesktop.onEvent('gen:module', (modules) => {
    set({ modules, loaded: true });
  });
}

export const useGenModulesStore = create<GenModulesStore>((set, get) => ({
  modules: [],
  loaded: false,
  closed: [],
  refresh: async () => {
    wire(set);
    try {
      const res = await window.piDesktop.invoke('gen:module-status', {});
      set({ modules: res.modules, loaded: true });
    } catch {
      // main without the modules wired (a test build): the cards stay hidden
    }
  },
  install: async (id) => {
    wire(set);
    const res = await window.piDesktop.invoke('gen:module-install', { id });
    set({ modules: res.modules, loaded: true });
  },
  dismiss: async (id) => {
    wire(set);
    set({ closed: [...get().closed.filter((c) => c !== id), id] });
    const res = await window.piDesktop.invoke('gen:module-dismiss', { id });
    set({ modules: res.modules, loaded: true });
  },
}));

/** One module's state, or undefined before the first push. */
export function useGenModule(id: GenModuleId): GenModuleState | undefined {
  return useGenModulesStore((s) => s.modules.find((m) => m.id === id));
}

// E2E hook (same ?piE2E=1 opt-in as __pi_store): lets a probe put the cards
// into any state without a multi-gigabyte download behind them.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (
    window as unknown as { __gen_modules_store: () => typeof useGenModulesStore }
  ).__gen_modules_store = () => useGenModulesStore;
}
