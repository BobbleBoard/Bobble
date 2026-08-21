/**
 * THE RENDERER'S VIEW OF THE MODEL STORE.
 *
 * `useLlmStore` owns the GGUF world — the running server, the quant ladder, the
 * one-file download. This owns everything else: whole Hugging Face repos of any
 * modality, fetched into `<cache>/store/<kind>/<slug>/`, plus the index that
 * answers "what is on this machine and where".
 *
 * ONE DOWNLOAD AT A TIME, mirroring the main process — which enforces it, so
 * this only has to REPORT it. Keying progress by repo rather than holding a
 * single record is deliberate anyway: a queue is a small change later, and a
 * shape that assumes one would have to be unpicked first.
 */

import type { StoredModel } from '@pi-desktop/model-store';
import { create } from 'zustand';
import type {
  StoreDownloadRequest,
  StoreDownloadUpdate,
} from '../../electron/model-store/store-contract';

export interface StoreModelsState {
  /** Everything on disk, across the store, the GGUF dir and the 3D cache. */
  readonly models: readonly StoredModel[];
  readonly bytes: number;
  /** Live transfers, keyed by repo. */
  readonly progress: Readonly<Record<string, StoreDownloadUpdate>>;
  readonly error: string | null;
  refresh: () => Promise<void>;
  download: (req: StoreDownloadRequest) => Promise<void>;
  cancel: (repo: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useStoreModels = create<StoreModelsState>((set, get) => ({
  models: [],
  bytes: 0,
  progress: {},
  error: null,

  refresh: async () => {
    const res = await window.piDesktop.invoke('store:list', undefined).catch(() => null);
    if (res === null) return;
    set({ models: res.models, bytes: res.bytes });
  },

  download: async (req) => {
    set({ error: null });
    // Paint the bar on the click rather than on the first progress event: the
    // repo tree has to be listed before a byte moves, and on a big repo that is
    // a second or two of a button that looks like it did nothing.
    set((s) => ({
      progress: {
        ...s.progress,
        [req.repo]: {
          repo: req.repo,
          received: 0,
          total: 0,
          fraction: 0,
          file: '',
          fileIndex: 0,
          fileCount: 0,
          done: false,
        },
      },
    }));
    const res = await window.piDesktop.invoke('store:download', req).catch(() => null);
    if (res === null || res.ok !== true) {
      set((s) => {
        const { [req.repo]: _dropped, ...rest } = s.progress;
        return { progress: rest, error: res?.error ?? 'the download could not start' };
      });
    }
  },

  /*
   * CANCEL IS ACKNOWLEDGED BEFORE IT IS OBEYED, for the same reason the GGUF
   * one is: the main process discards the partial tree on the abort path, so
   * the outcome is not in doubt and the UI should not sit there looking ignored
   * while a multi-gigabyte write finishes its current chunk.
   */
  cancel: async (repo) => {
    set((s) => {
      const { [repo]: _dropped, ...rest } = s.progress;
      return { progress: rest };
    });
    await window.piDesktop.invoke('store:cancel', { repo }).catch(() => null);
    await get().refresh();
  },

  remove: async (id) => {
    const res = await window.piDesktop.invoke('store:delete', { id }).catch(() => null);
    if (res !== null && res.ok !== true) set({ error: res.error ?? 'could not delete' });
    await get().refresh();
  },
}));

/** Subscribe to main's progress stream. Called once, beside the other connects. */
export function connectStoreModels(): void {
  window.piDesktop.onEvent('store:download', (p) => {
    useStoreModels.setState((s) => {
      if (p.done) {
        const { [p.repo]: _finished, ...rest } = s.progress;
        // A finished download changes what is on disk; a cancelled one changes
        // it back. Either way the index is now stale.
        void useStoreModels.getState().refresh();
        return {
          progress: rest,
          error: p.error ?? null,
        };
      }
      return { progress: { ...s.progress, [p.repo]: p } };
    });
  });
}

/** Is this repo already on disk (by repo id, which is what the hub knows)? */
export function hasRepo(models: readonly StoredModel[], repo: string): boolean {
  return models.some((m) => m.repo === repo && m.incomplete !== true);
}
