/**
 * SENDING TAKES YOU TO THE BOTTOM.
 *
 * The user (2026-09-24): "pressing enter on a chat should take you to the bottom".
 *
 * The thread follows new output only while the reader is parked at its foot,
 * and the smallest scroll up releases it (ChatThread's stick — the user's own rule,
 * 2026-09-12). So a reader who had scrolled up to check something, then typed a
 * question and pressed Enter, sent it into a thread that stayed where they
 * were: their message and its reply arrived below the fold, out of sight.
 *
 * A send is the clearest statement of intent there is — "I am in this
 * conversation now" — so it re-arms the stick exactly as scrolling back down to
 * the bottom does, and the thread follows the reply from there. This is only
 * the signal; ChatThread owns the scroll and keeps its rule that anything the
 * reader does afterwards (a wheel tick up) releases it again.
 *
 * A signal and not a scroll call, because the composer does not own the thread
 * and should not reach into it; the bump is a counter so two sends in a row are
 * two requests.
 */
import { create } from 'zustand';

interface ThreadFollowState {
  /** Bumped once per send. ChatThread reacts to the change, not the value. */
  requests: number;
}

export const useThreadFollow = create<ThreadFollowState>(() => ({ requests: 0 }));

/** The user just sent something: bring the thread to its foot and follow it. */
export function followToLatest(): void {
  useThreadFollow.setState((s) => ({ requests: s.requests + 1 }));
}
