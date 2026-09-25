/**
 * WHICH HALF OF A PASTE IS THE THING BEING PASTED — its files, or its text.
 *
 * the user: "copy and then attempting pasting into our own apps input bar doesn't
 * work." The copy was fine — a card puts its picture on the clipboard as pixels
 * (media-actions.ts), which every other app pastes. The composer is a Lexical
 * PLAIN-TEXT editor, and its paste handler reads `text/plain` and nothing else,
 * so a picture arrived as an empty string and vanished without a word. The
 * composer's own paste hook even stepped aside on purpose the moment the
 * clipboard carried a file ("file/image pastes … are left untouched"), which
 * left them to the one handler that cannot hold them.
 *
 * A clipboard often carries BOTH halves, and which one is the content depends on
 * where it came from:
 *
 *   a card's Copy, a screenshot     pixels only                → the picture
 *   "Copy Image" in a browser       pixels + `<img>` markup     → the picture
 *   a file copied in Finder         the file + its NAME as text → the file
 *   cells from Numbers / Excel,     real text + a PICTURE OF    → the text
 *   a paragraph from Pages / Word   that text, for apps that
 *                                   cannot take text
 *
 * The last row is the trap: treat "has a file" as "is a file" and pasting a
 * spreadsheet attaches a screenshot of it instead of the numbers. So the files
 * win only when the text beside them says nothing of its own.
 */

/** The part of a `File` this decides on — so it can be tested without a DOM. */
export interface NamedFile {
  readonly name: string;
}

/**
 * The files to attach from a paste, or none when the text is the content.
 *
 * `text` is the clipboard's `text/plain`, `html` its `text/html` — both as the
 * browser hands them over (`''` when absent).
 */
export function pastedFiles<F extends NamedFile>(
  files: readonly F[],
  text: string,
  html: string,
): readonly F[] {
  if (files.length === 0) return [];
  const words = text.trim();
  // Pixels and nothing else — a card's Copy, a screenshot.
  if (words === '') return files;
  // The text is only the files' own names — what Finder puts beside a copied file.
  if (namesOnly(words, files)) return files;
  // Markup that is a picture and nothing else — a browser's "Copy Image".
  if (imageOnlyHtml(html)) return files;
  // Real words with a rendering of them attached: the words are the content.
  return [];
}

/** Every line of `text` is the name (or path) of one of the pasted files. */
function namesOnly(text: string, files: readonly NamedFile[]): boolean {
  const names = new Set(files.map((f) => f.name));
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.length > 0 && lines.every((l) => names.has(l.split('/').pop() ?? l));
}

/** `html` holds at least one `<img>` and no visible words of its own. */
function imageOnlyHtml(html: string): boolean {
  if (!/<img\b/i.test(html)) return false;
  const visible = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return visible === '';
}
