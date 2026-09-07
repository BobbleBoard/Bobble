/**
 * Autocomplete trigger detection (ported logic from RemotePi's useAutocomplete):
 *  - `/foo` at the start of a line is a COMMAND (matches pi's TUI: a slash
 *    command owns the whole message, so it can only be the first thing in it).
 *  - `/foo` mid-sentence is a CONNECTOR reference — "check /gmail for the
 *    receipt". the user asked for `/gmail` to "just change to the blue thing with
 *    the icon", and a reference is a word in a sentence, not a command. It is a
 *    separate mode rather than a widened slash because the two offer different
 *    things: a command list mid-sentence would be a menu of things that cannot
 *    run from there.
 *  - `@foo` is a mention anywhere at a word boundary.
 * Operates on the text of the current line up to the caret; `tokenStart` is the
 * offset (within that text) of the trigger char, for in-place replacement.
 */
export type AcMode = 'mention' | 'slash' | 'connector' | null;

export interface AcToken {
  mode: AcMode;
  query: string;
  tokenStart: number;
}

export const EMPTY_TOKEN: AcToken = { mode: null, query: '', tokenStart: 0 };

export function detectToken(textUpToCaret: string): AcToken {
  const slash = textUpToCaret.match(/(?:^|\n)\/(\S*)$/);
  if (slash !== null) {
    const query = slash[1] ?? '';
    return { mode: 'slash', query, tokenStart: textUpToCaret.length - query.length - 1 };
  }
  const mention = textUpToCaret.match(/(?:^|\s)@([^\s]*)$/);
  if (mention !== null) {
    const query = mention[1] ?? '';
    return { mode: 'mention', query, tokenStart: textUpToCaret.length - query.length - 1 };
  }
  /*
   * A `/` after a space, anywhere in the line. Deliberately last: the two rules
   * above are more specific, and a `/` that could be a command already matched.
   * Not after a non-space (so `src/utils` and `and/or` are not triggers).
   */
  const connector = textUpToCaret.match(/(?:^|\s)\/([^\s/]*)$/);
  if (connector !== null) {
    const query = connector[1] ?? '';
    return { mode: 'connector', query, tokenStart: textUpToCaret.length - query.length - 1 };
  }
  return EMPTY_TOKEN;
}
