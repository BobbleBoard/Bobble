/**
 * THE DOWNLOAD TRAY'S NEWS: what finished and what could not start, kept
 * until the user has seen it.
 *
 * the user (2026-09-13): the downloads live in the top-left, "under a down arrow
 * with half square outline below it, with the progressbar and x inside it
 * shown on click, show a tiny ! on the top right of that icon when download
 * finished." The two downloaders (the inference supervisor for GGUFs, the
 * store for repos) both report here, so the tray is one list.
 */
import { create } from 'zustand';

export interface TrayNotice {
  /** `llm:<modelId>` or `store:<repo>` — one notice per thing, the newest wins. */
  readonly key: string;
  readonly name: string;
  readonly kind: 'finished' | 'failed';
  /** The refusal or failure, as a sentence. */
  readonly detail?: string;
  readonly at: number;
}

export interface DownloadTrayState {
  readonly notices: readonly TrayNotice[];
  /** A notice arrived since the tray was last opened — the "!" on the icon. */
  readonly unseen: boolean;
  note: (n: Omit<TrayNotice, 'at'>) => void;
  dismiss: (key: string) => void;
  markSeen: () => void;
}

export const useDownloadTray = create<DownloadTrayState>((set) => ({
  notices: [],
  unseen: false,
  note: (n) =>
    set((s) => ({
      notices: [{ ...n, at: Date.now() }, ...s.notices.filter((x) => x.key !== n.key)].slice(0, 12),
      unseen: true,
    })),
  dismiss: (key) =>
    set((s) => {
      const notices = s.notices.filter((x) => x.key !== key);
      return { notices, unseen: notices.length === 0 ? false : s.unseen };
    }),
  markSeen: () => set({ unseen: false }),
}));
