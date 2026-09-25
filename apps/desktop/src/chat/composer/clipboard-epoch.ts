/**
 * HAS THE SYSTEM CLIPBOARD MOVED ON SINCE THE COMPOSER'S OWN COPY?
 *
 * The composer keeps a clipboard of its own for attachment chips (select a chip,
 * ⌘C, ⌘V — the user's "allow for user to press ctrl c/x/v"), and its ⌘V used to
 * win outright whenever that clipboard held anything. So after copying a chip
 * once, every later ⌘V pasted that chip again — including the one meant to
 * paste a picture just copied from a card, which never reached the editor at
 * all. The chip copy is the NEWER copy only until something else is copied.
 *
 * This is the "something else was copied" counter. Anything that writes the
 * system clipboard from inside the app advances it (a card's Copy, a ⌘C on
 * selected text), and so does the window losing focus, because the next copy
 * may happen in another app entirely — where we cannot see it, and where
 * "prefer the system clipboard" is the only safe reading.
 */

let epoch = 0;

/** The system clipboard was (or may have been) written. */
export function markSystemClipboard(): void {
  epoch += 1;
}

/** The current count — stamp it on the composer's own copy, compare at paste. */
export function clipboardEpoch(): number {
  return epoch;
}

/*
 * Installed once, at import. A DOM `copy`/`cut` event fires for every real copy
 * in the page (text in a message, the editor's own selection); the chip copy
 * cancels its keydown and so never produces one, which is what keeps it from
 * invalidating itself.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('copy', markSystemClipboard, true);
  window.addEventListener('cut', markSystemClipboard, true);
  window.addEventListener('blur', markSystemClipboard);
}
