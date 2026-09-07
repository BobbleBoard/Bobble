/**
 * Is this the SAME system prompt, written in a different order?
 *
 * pi rebuilds its tool-usage guidance every time a session starts, and the
 * rebuild is not stable: the same lines come back in a different order. The
 * harness freezes the prompt for the life of a session precisely because a
 * prompt that churns re-prefills the whole conversation — but a session
 * boundary throws the frozen copy away, so opening a new chat adopts a
 * reordered prompt and every cached token behind it becomes worthless.
 *
 * MEASURED, and it is why this file exists: three new chats in one run each
 * built a 17,646-character prompt — the same length every time, so the same
 * lines — and each one re-warmed from cold, ~9.7k tokens of prefix thrown away
 * per chat.
 *
 * A session boundary IS where a genuinely different prompt belongs: a new day's
 * date, another working folder. Those change what the lines SAY. A reordering
 * changes nothing anyone can read, so it should not cost anything either.
 */

/** The lines of a prompt, trimmed, blanks dropped, in a stable order. */
function wording(prompt: string): string {
  return prompt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
}

/**
 * True when `a` and `b` differ only in the order of their lines — the same
 * words, so the same instructions, so no reason to re-read the prompt.
 *
 * The length check first is not just a fast path: a reordering cannot change
 * the character count, so a different length is proof that something was added,
 * removed or rewritten, and that is a prompt worth adopting. Pure.
 */
export function sameWording(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return wording(a) === wording(b);
}
