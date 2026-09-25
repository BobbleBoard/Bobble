/**
 * WHEN ⌘Z TAKES A MESSAGE BACK, AND WHEN IT IS JUST UNDO.
 *
 * the user (2026-09-24): "pressing cmd z within 3 seconds of sending a message and
 * before any text has been typed into the input box should unsend+rewind the
 * chat".
 *
 * ⌘Z already means something everywhere, so this claims the key only in the
 * narrow moment the spec names and gives it straight back otherwise. Every
 * condition below is a way ordinary undo must keep working:
 *
 *  - after the window — ⌘Z an idle minute later is text undo, as it always was;
 *  - once anything is in the box — the user has started the next message and
 *    ⌘Z is for THAT text (and the arm is dropped for good by then: typing
 *    disarms it, so deleting back to empty does not bring it back);
 *  - in some OTHER field — a message being edited, a settings input — whose
 *    own undo it is;
 *  - ⇧⌘Z / ⌥⌘Z — redo and friends are not undo.
 *
 * Pure, so the rule is testable without a keyboard.
 */

/** The regret window — long enough to see the typo in the bubble. */
export const UNSEND_WINDOW_MS = 3000;

export interface UndoKeyFacts {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** ⌘Z on a Mac, Ctrl+Z elsewhere — plain undo, no modifiers beyond it. */
export function isUndoKey(e: UndoKeyFacts): boolean {
  return e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
}

/** Should this ⌘Z take the last message back instead of undoing text? */
export function claimsUndoForUnsend(input: {
  /** When the message the composer can take back was sent; null = nothing armed. */
  readonly armedAt: number | null;
  readonly now: number;
  /** Nothing typed and nothing attached. */
  readonly draftEmpty: boolean;
  /** Focus is in an editable field that is not the composer. */
  readonly inOtherField: boolean;
}): boolean {
  if (input.armedAt === null) return false;
  if (input.now - input.armedAt > UNSEND_WINDOW_MS) return false;
  if (!input.draftEmpty) return false;
  return !input.inOtherField;
}
