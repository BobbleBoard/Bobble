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
 *
 * FILES AND FOLDERS FROM FINDER ARRIVE WITH THE PASTE ITSELF (2026-09-24).
 * the user: "why not handle this natively so that any image(s)/files/folders...
 * can be pasted into the input box". The native read already happens, inside
 * the person's own ⌘V: the Edit menu's paste (`role: 'paste'`) is AppKit's
 * `paste:` action, and during it Chromium reads the pasteboard for the paste
 * event (blink DataObject::CreateFromClipboard → ClipboardHostImpl::ReadFiles →
 * ui/base/clipboard ClipboardMac::ReadFilenames). What it hands over, per the
 * Chromium source:
 *
 *   - EVERY file URL on the pasteboard, one per item (clipboard_util_mac.mm
 *     FilesFromPasteboard) — so a multi-file copy is many Files;
 *   - folders included: nothing filters directories, so a folder is a File
 *     like the rest, and `webUtils.getPathForFile` gives its path;
 *   - and NOT Finder's icon: Finder puts the file's icon on the pasteboard
 *     beside it, and GetStandardFormats drops the picture whenever files are
 *     present (crbug.com/553686), so a copied PDF does not paste as a picture
 *     of a PDF.
 *
 * So nothing in main reads the pasteboard — deliberately. On this macOS a read
 * that is not part of the person's paste can put the "… would like to paste
 * from …" alert on their screen; the paste event's own Files never can. What
 * each File then becomes is incoming-files.ts.
 */

/** The part of a `File` this decides on — so it can be tested without a DOM. */
export interface NamedFile {
  readonly name: string;
}

/** What Chromium calls pasted pixels (blink DataObjectItem::GetAsFile). */
const PIXELS_NAME = 'image.png';

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

/**
 * Every line of `text` is the name (or path) of one of the pasted files — or
 * the name Finder SHOWS for it, which drops the extension when "Show all
 * filename extensions" is off (`Q3 report` for `Q3 report.pdf`).
 *
 * Not for Chromium's own name for pasted pixels: text reading "image" beside a
 * rendering of it is words with a picture of them — the trap above.
 */
function namesOnly(text: string, files: readonly NamedFile[]): boolean {
  const names = new Set<string>();
  for (const f of files) {
    names.add(f.name);
    const dot = f.name.lastIndexOf('.');
    if (dot > 0 && f.name !== PIXELS_NAME) names.add(f.name.slice(0, dot));
  }
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
