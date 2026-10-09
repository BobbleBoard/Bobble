/**
 * THE THREE THINGS YOU DO WITH A GENERATED FILE, in one place.
 *
 * Every media surface — the inline card, the expanded view, the studio results
 * — offers the same Export, Reveal and drag-to-Finder. They were being wired
 * separately at each call site, which is how one of them quietly ends up with a
 * hand-built `pd-file://` URL that 404s (it happened; see `pdFileUrl`).
 */
import { plainError } from '@pi-desktop/shared';
import { reportOpen } from '../chat/canvas/open-outcome';
import { markSystemClipboard } from '../chat/composer/clipboard-epoch';
import { usePiStore } from '../state/pi-slice';

/**
 * A media action that did not work says so — these used to fail in silence
 * (a moved file, a full disk). The words come from main where it gave a
 * sentence, else from plainError; a moved file is looked for first.
 */
function sayFailed(what: string, error: unknown): void {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/cancel/i.test(raw)) return;
  usePiStore.setState((st) => ({
    notifications: [
      ...st.notifications.slice(-3),
      {
        id: `media-${Date.now()}`,
        level: 'error' as const,
        message: `Couldn't ${what}. ${plainError(raw, what.startsWith('save') ? 'save' : 'open')}`,
        timestamp: Date.now(),
      },
    ],
  }));
}

/** Ask main for a Save-As sheet. Never throws — a cancelled sheet is not an error. */
export function exportFile(path: string, suggestedName: string): void {
  void window.piDesktop
    .invoke('canvas:save-as', { path, suggestedName })
    .then((r) => {
      if (!r.ok && r.error !== undefined && r.error !== '') sayFailed('save a copy', r.error);
    })
    .catch((e: unknown) => sayFailed('save a copy', e));
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
      else sayFailed('copy it', (r as { error?: string }).error);
      return ok;
    })
    .catch((e: unknown) => {
      sayFailed('copy it', e);
      return false;
    });
}

/** Show it in Finder — looked for first if it moved (open-outcome). */
export function revealFile(path: string): void {
  void reportOpen(() => window.piDesktop.invoke('canvas:reveal', { path }), {
    verb: 'reveal',
    path,
    retryAt: (p) => window.piDesktop.invoke('canvas:reveal', { path: p }),
  });
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
