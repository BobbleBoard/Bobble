/**
 * A MESSAGE WAITING FOR A MODEL THAT DID NOT START.
 *
 * The send waited for the chat model and the wait ended without one
 * (auto-router `lastServerProblem`). Rather than go on to a server that is not
 * there — and come back as a red "fetch failed" — the message is held here,
 * exactly as pi would have received it, under the bubble that shows it; the
 * card under it (HeldSendCard) says why and sends it on Try again
 * (pi-connect `retryHeldSend`). One at a time: a later send carries a held
 * one with it (sendPrompt).
 */
import type { ImageContent } from '@pi-desktop/engine';
import { create } from 'zustand';
import type { ServerProblem } from '../chat/auto-router';

export interface HeldSend {
  /** The chat it belongs to. */
  readonly sessionFile: string | null;
  /** The bubble it stands under (its local echo). */
  readonly echoId: string;
  /** What pi receives. */
  readonly message: string;
  readonly images: readonly ImageContent[];
  readonly problem: ServerProblem;
  /** Try again is running: the model is being started. */
  readonly retrying: boolean;
}

export const useHeldSendStore = create<{
  readonly held: HeldSend | null;
  readonly hold: (held: HeldSend) => void;
  readonly setRetrying: (retrying: boolean) => void;
  readonly clear: () => void;
}>((set) => ({
  held: null,
  hold: (held) => set({ held }),
  setRetrying: (retrying) => set((s) => (s.held === null ? {} : { held: { ...s.held, retrying } })),
  clear: () => set({ held: null }),
}));

// E2E handle (the same opt-in as `__pi_store`): probes read and seed the held
// message to draw each reason without breaking a model on purpose.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __held_send?: unknown }).__held_send = () => useHeldSendStore;
}
