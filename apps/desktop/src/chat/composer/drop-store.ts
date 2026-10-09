/**
 * Bridge for the fullscreen drop-anywhere overlay (round-3 #A8b). The overlay
 * lives at the window level (so a file dropped ANYWHERE attaches, not just over
 * the composer), while the attachment state lives inside the composer — this
 * tiny store hands the dropped files across. The composer drains `files` into
 * its own attachment list and calls `clear()`, mirroring the `composerText`
 * hand-off pattern.
 *
 * A MESSAGE BEING EDITED TAKES PRECEDENCE. The user: "drag and drop needs to be able
 * to go into messages being edited." While an edit is open, that turn — not the
 * composer — is the message you are composing, and dropping a file into the box
 * you are typing in should attach it there. The claim is registered by whoever
 * opens the editor and released when it closes, so there is exactly one place
 * that decides where a drop lands rather than two components racing to drain the
 * same queue.
 */
import { create } from 'zustand';

/** Takes dropped files instead of the composer, while it is registered. */
export type DropClaim = (files: File[]) => void;

interface DropState {
  files: File[];
  /** Set while a message editor is open; null the rest of the time. */
  claim: DropClaim | null;
  push: (files: File[]) => void;
  clear: () => void;
  /** Register a claimant; returns the release, so it cannot be forgotten. */
  claimDrops: (claim: DropClaim) => () => void;
}

export const useDropStore = create<DropState>((set, get) => ({
  files: [],
  claim: null,
  push: (files) => {
    const { claim } = get();
    if (claim !== null) {
      claim(files);
      return;
    }
    set((s) => ({ files: [...s.files, ...files] }));
  },
  clear: () => set({ files: [] }),
  claimDrops: (claim) => {
    set({ claim });
    return () => set((s) => (s.claim === claim ? { claim: null } : {}));
  },
}));
