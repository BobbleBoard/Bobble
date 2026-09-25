/**
 * THE THREE THINGS YOU DO WITH A GENERATED FILE, in one place.
 *
 * Every media surface — the inline card, the expanded view, the studio results
 * — offers the same Export, Reveal and drag-to-Finder. They were being wired
 * separately at each call site, which is how one of them quietly ends up with a
 * hand-built `pd-file://` URL that 404s (it happened; see `pdFileUrl`).
 */
import { markSystemClipboard } from '../chat/composer/clipboard-epoch';

/** Ask main for a Save-As sheet. Never throws — a cancelled sheet is not an error. */
export function exportFile(path: string, suggestedName: string): void {
  void window.piDesktop.invoke('canvas:save-as', { path, suggestedName }).catch(() => undefined);
}

/**
 * Put it on the clipboard — a picture as pixels, anything else as the file.
 *
 * Pixels are what every paste target understands, OUR composer included now
 * (paste-files.ts). A successful copy also retires the composer's own chip
 * clipboard (clipboard-epoch.ts): this copy is newer, so it is what ⌘V pastes.
 */
export function copyFile(path: string): Promise<boolean> {
  return window.piDesktop
    .invoke('canvas:copy-file', { path })
    .then((r) => {
      const ok = (r as { ok?: boolean }).ok === true;
      if (ok) markSystemClipboard();
      return ok;
    })
    .catch(() => false);
}

/** Show it in Finder. */
export function revealFile(path: string): void {
  void window.piDesktop.invoke('canvas:reveal', { path }).catch(() => undefined);
}

/**
 * Start an OS drag carrying the real file.
 *
 * `preventDefault` stops the HTML5 drag (which would carry text) so the drag
 * started in main is the only one running. Callers must offer a keyboard path
 * to the same outcome — Export — because a drag is a pointer gesture by nature.
 */
export function startFileDrag(e: { preventDefault: () => void }, path: string): void {
  e.preventDefault();
  void window.piDesktop.invoke('canvas:start-drag', { path }).catch(() => undefined);
}
