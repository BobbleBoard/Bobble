/**
 * CARRYING A PIECE OF MEDIA FROM WHERE IT IS TO WHERE YOU CAN WORK ON IT.
 *
 * The user, round 2: "all types of media handoff into studios and editing will also
 * be tested."
 *
 * Before this there was one handoff in the app and it did not carry anything: a
 * generated MESH offered "Open in studio", which switched the view and left the
 * mesh behind, so you arrived in an empty 3D studio next to the thing you had
 * just been looking at. Images, clips and audio offered nothing at all, and no
 * studio could send its result back to the conversation.
 *
 * The three moves are the same move, which is why they share one store:
 *
 *   chat → studio   a card in the transcript opens in the room that can edit it
 *   file → studio   a file dropped on a studio becomes its input
 *   studio → chat   a result goes back to the conversation as an attachment
 *
 * ## Why a store and not a prop
 *
 * The two ends are in different route trees — the transcript unmounts as the
 * studio mounts (they share the `contentOverride` slot), so there is no common
 * parent to thread a prop through, and no component alive at both moments. The
 * handoff is a one-shot message with a mounting boundary in the middle, and a
 * tiny store is the honest shape for that.
 *
 * ## Consumed exactly once
 *
 * `take()` reads and clears. A studio that mounts, is left, and is returned to
 * must not silently reload the thing you handed it twenty minutes ago — that
 * would quietly discard whatever you did in between.
 */
import { create } from 'zustand';
import type { MediaKind } from '../chat/thread-media';

/** The rooms a piece of media can be handed to. */
export type StudioTarget = 'image' | 'video' | 'audio' | '3d';

export interface StudioHandoff {
  /** Absolute path on disk. */
  readonly path: string;
  /** File name, for the card the receiving room draws. */
  readonly name: string;
  readonly kind: MediaKind;
  /**
   * The prompt that made it, when it is known.
   *
   * Carried because the first thing anyone does with a generated picture is ask
   * for it again slightly differently, and retyping the sentence is the whole
   * friction. Absent for a file that arrived from disk — it has no prompt.
   */
  readonly prompt?: string;
  /** The seed it came out of, so "same again but…" is actually the same again. */
  readonly seed?: number;
  /** The model that produced it, so the room can select it back. */
  readonly model?: string;
  /**
   * A URL to DRAW it with, when the path alone will not do.
   *
   * `pd-file://` is fenced to the app's working roots — a page can never stream
   * a file outside the folders the app operates in — which is right, and which
   * means a picture dragged in from ~/Downloads has no served URL at all. The
   * run itself is unaffected (the Python worker reads the path directly, with
   * no fence in between); it is only the "Working from" thumbnail that would
   * come back 403 and draw as a broken image.
   *
   * A drop already holds the bytes, so it hands over an object URL. A handoff
   * from the transcript omits this: that file came out of the app's own output
   * directory, which IS a served root.
   */
  readonly previewUrl?: string;
}

interface HandoffState {
  /** Pending handoffs by target room. At most one each — a second replaces it. */
  readonly pending: Partial<Record<StudioTarget, StudioHandoff>>;
  /** Offer media to a room. Does not navigate; the caller decides that. */
  readonly offer: (target: StudioTarget, media: StudioHandoff) => void;
  /** Take what is waiting for a room, clearing it. Null when nothing is. */
  readonly take: (target: StudioTarget) => StudioHandoff | null;
  /** Look without consuming — for a render that has not mounted the room yet. */
  readonly peek: (target: StudioTarget) => StudioHandoff | null;
  readonly clear: (target: StudioTarget) => void;
}

export const useStudioHandoff = create<HandoffState>((set, get) => ({
  pending: {},
  offer: (target, media) => set((s) => ({ pending: { ...s.pending, [target]: media } })),
  take: (target) => {
    const media = get().pending[target] ?? null;
    if (media !== null) {
      set((s) => {
        const next = { ...s.pending };
        delete next[target];
        return { pending: next };
      });
    }
    return media;
  },
  peek: (target) => get().pending[target] ?? null,
  clear: (target) =>
    set((s) => {
      const next = { ...s.pending };
      delete next[target];
      return { pending: next };
    }),
}));

/**
 * Which room can work on this kind of media.
 *
 * A mesh goes to 3D, a picture to Image, and so on — the obvious mapping, kept
 * in one place so the card, the drop target and any future caller agree. Video
 * and audio each have a room of their own, and neither can currently do anything
 * with an INPUT clip; the mapping is still right, and what the room does with
 * what it is handed is the room's business.
 */
export function studioFor(kind: MediaKind): StudioTarget {
  switch (kind) {
    case 'model':
      return '3d';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    default:
      return 'image';
  }
}

// E2E hook, on the same `?piE2E=1` opt-in as the other stores — a probe drives
// a handoff without having to synthesise a generation first.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __studio_handoff?: () => typeof useStudioHandoff }).__studio_handoff =
    () => useStudioHandoff;
}
