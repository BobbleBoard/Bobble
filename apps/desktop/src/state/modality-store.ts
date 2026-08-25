/**
 * Which top-level MODALITY the app is showing. Chat is the default; the studios
 * (3D, Image, Video, Audio) are full-window takeovers reached from the sidebar
 * "Modalities" dropdown, each with its own back-to-chat affordance. UI-only
 * routing — no persistence.
 */
import { create } from 'zustand';

/*
 * THREE STUDIOS, NOT ONE. `studio` was a single room with an image/video toggle
 * inside it; the user asked for an image, a video and an audio studio, and they are
 * genuinely different rooms — the audio one alone carries speech, cloning, music
 * and SFX with a different control set for each.
 */
export type Modality = 'chat' | '3d' | 'image' | 'video' | 'audio';

interface ModalityState {
  view: Modality;
  setView(view: Modality): void;
}

export const useModalityStore = create<ModalityState>()((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
}));

/** Leave the current modality and return to chat (the studios' back button). */
export function exitModality(): void {
  useModalityStore.getState().setView('chat');
}

/*
 * E2E hook, on the same `?piE2E` opt-in as the other stores: the studio visual
 * probe routes straight into a room rather than clicking through the sidebar,
 * which is covered by its own probe.
 */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __modality_store?: () => typeof useModalityStore }).__modality_store =
    () => useModalityStore;
}
