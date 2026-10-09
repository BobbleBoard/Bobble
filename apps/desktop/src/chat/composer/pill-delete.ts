/**
 * ONE KEYSTROKE REMOVES A PILL.
 *
 * The user: "at mentions should appear just the inline … deleted as if it's a single
 * character if the delete key is pressed next to it."
 *
 * Lexical's default for a keyboard-selectable decorator is a two-step: the first
 * Backspace SELECTS the node, the second removes it. That is the right default
 * for something big and destructive to lose — an image, an embed — and the wrong
 * one for a token standing in for a word. Nothing else in the sentence takes two
 * presses to delete, so the pill should not either.
 *
 * Kept as a pure function over the structural bits of a Lexical selection so the
 * three cases (caret in text, caret between block children, the node itself
 * selected) are stated once and tested without an editor.
 */

/** The minimum a node has to be for this decision. */
export interface DeletableNode {
  remove(): void;
}

export interface PillNeighbourhood {
  /** The pill immediately before the caret, if there is one. */
  readonly before?: DeletableNode | null;
  /** The pill immediately after the caret, if there is one. */
  readonly after?: DeletableNode | null;
  /** The pill the selection itself is on (Lexical's node-selection state). */
  readonly selected?: DeletableNode | null;
}

/**
 * Remove the pill this keystroke should remove, and say whether it did — the
 * return value is what Lexical wants back from a command handler, where `true`
 * means "handled, stop".
 *
 * A selected pill goes on either key: at that point the user has already aimed
 * at it, and leaving Delete to do nothing would be the odd behaviour.
 */
export function deleteAdjacentPill(
  where: PillNeighbourhood,
  direction: 'backward' | 'forward',
): boolean {
  const target =
    where.selected ?? (direction === 'backward' ? (where.before ?? null) : (where.after ?? null));
  if (target === null || target === undefined) return false;
  target.remove();
  return true;
}
