/**
 * THE SPINNER SURVIVES SEND.
 *
 * The user: "we also want loading on attachments as they are tokenized and prefilled
 * (while we are still typing our prompt) they stop loading maybe even after
 * sent, the loading spinner can still be on them, it disapears when they are
 * prefilled."
 *
 * The composer half was already there — a chip over the prefill threshold shows
 * a spinner where its token count goes while a prime is in flight. But the chips
 * LEAVE the composer with the message, and the copies rendered in the thread
 * carried no prefill state at all, so the spinner vanished at send even though
 * the model was very much still reading the file. Which is exactly the wrong way
 * round: before send the wait is speculative (the prime may finish before you
 * press enter), and after send it is the wait you are actually sitting through.
 *
 * ## Where "is it prefilled yet" comes from
 *
 * Not from anywhere new. The turn's own prompt-ingest phase is already tracked
 * for the thread — `buildActiveRunningChat` in state/running-chats.ts, whose
 * `status` is `'prefilling'` from the moment a send is dispatched until the turn
 * produces its first content, fed by llama-server's real `prompt_progress`
 * frames. That is the same phase the thread's processing ring draws. This module
 * only decides WHICH chips that phase belongs to.
 *
 * ## And why it cannot get stuck
 *
 * The user's other half of the rule is that an indicator which never clears is worse
 * than none. Two things bound it:
 *
 *  - the phase itself self-clears — the first token ends it, and so does the end
 *    of the turn, however it ends;
 *  - {@link sentAttachmentsPrefilling} additionally requires the turn to be
 *    UNANSWERED. `promptInFlight` has at least one path that does not clear (the
 *    model warm-up raises it and produces no agent_start/agent_end — see
 *    ThreadStatusIndicator), and without this a chat REOPENED from disk, whose
 *    last question carried a big file, would sit there spinning about a turn that
 *    was answered days ago.
 */
import { PREFILL_MIN_CHARS } from './composer/prefill-gate';

/** Just enough of a folded attachment to decide about it. */
export interface SentAttachment {
  readonly id: string;
  readonly text: string;
}

export interface SentPrefillInput {
  /** The attachments folded into the message being rendered. */
  readonly files: readonly SentAttachment[];
  /** Is this the newest user turn in the thread? Older turns are long since read. */
  readonly isLatestTurn: boolean;
  /**
   * Has nothing settled after it yet — no assistant reply, or one that is still
   * streaming? See the header: this is what stops a restored chat from spinning.
   */
  readonly awaitingReply: boolean;
  /**
   * Is the viewed conversation in its prompt-ingest phase right now?
   * `RunningChat.status === 'prefilling'` — state/running-chats.ts owns it.
   */
  readonly turnPrefilling: boolean;
  /** Defaults to the one threshold the prefill itself uses. */
  readonly minChars?: number;
}

/**
 * Which of a sent message's attachment chips still show a spinner.
 *
 * Empty — never a spinner — unless all three are true: this is the newest turn,
 * it has not been answered yet, and the model is still reading the prompt. The
 * size threshold is the prefill's own, so a chip that never showed a spinner in
 * the composer does not sprout one on the way into the thread.
 */
export function sentAttachmentsPrefilling(input: SentPrefillInput): ReadonlySet<string> {
  if (!input.isLatestTurn || !input.awaitingReply || !input.turnPrefilling) return EMPTY;
  const min = input.minChars ?? PREFILL_MIN_CHARS;
  const ids = new Set<string>();
  for (const file of input.files) if (file.text.length >= min) ids.add(file.id);
  return ids.size === 0 ? EMPTY : ids;
}

/** Shared empty set — the overwhelmingly common answer, and a stable identity. */
const EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Has the newest user turn been answered yet?
 *
 * "Answered" is deliberately weak: any assistant message after it that is NOT
 * still streaming. A live, empty, streaming assistant is the pre-first-token
 * window — the very thing the spinner is about — so it does not count as an
 * answer, while a settled reply (or an error row) does.
 *
 * Pure over the shape the thread already has: kind + whether it streams.
 */
export function awaitingReplyAfterLatestTurn(
  messages: readonly { readonly kind: string; readonly isStreaming?: boolean }[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.kind === 'user') return true;
    if (m.kind === 'assistant' && m.isStreaming !== true) return false;
  }
  // No user turn at all: nothing was sent, so nothing is being read for one.
  return false;
}
