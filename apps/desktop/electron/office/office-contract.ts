/**
 * Office-editor (WebContentsView) IPC contract — the docx/xlsx/pptx/pdf/md
 * surfaces backed by the vendored GenOffice editors.
 *
 * Deliberately shaped like browser-contract.ts, because it is the same
 * mechanism: one WebContentsView per canvas tab, created / positioned /
 * destroyed in main, driven from the renderer over these channels. The canvas
 * already knows how to overlay a native view at a reported rect; an office tab
 * is that machinery pointed at a different kind of view.
 *
 * Pure types + a runtime channel list, no electron/node imports, so the
 * sandboxed preload and the renderer can both consume it.
 */

/** Which vendored editor backs a tab. Maps 1:1 to a create*View() in the seam. */
export type OfficeKind = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown';

/** Window-space rect for an office view (renderer client rect → window coords). */
export interface OfficeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extension → editor. The set the canvas will route into an office tab. */
export const OFFICE_KIND_BY_EXT: Readonly<Record<string, OfficeKind>> = {
  docx: 'docs',
  xlsx: 'sheets',
  xlsm: 'sheets',
  csv: 'sheets',
  pptx: 'slides',
  pdf: 'pdf',
};

export function officeKindForExt(ext: string): OfficeKind | null {
  return OFFICE_KIND_BY_EXT[ext.toLowerCase()] ?? null;
}

export type OfficeInvokeMap = {
  /** Create (idempotent) the tab's editor view and open `filePath` in it. */
  'office:create': {
    request: { tabId: string; kind: OfficeKind; filePath: string };
    response: { ok: boolean; created?: boolean; error?: string };
  };
  /** Destroy the tab's view and free its WebContents (tab closed). */
  'office:destroy': { request: { tabId: string }; response: { ok: boolean } };
  /** Position the view over the content slot and show/hide it (tab switch = hide). */
  'office:set-bounds': {
    request: { tabId: string; bounds: OfficeBounds; visible: boolean };
    response: { ok: boolean };
  };
  /** Whether the document has unsaved changes (close confirmation). */
  'office:dirty': { request: { tabId: string }; response: { dirty: boolean } };
  /** Screenshot the live editor — used by the automated acceptance checks. */
  'office:capture': {
    request: { tabId: string };
    response: { dataUrl: string | null; error?: string | null };
  };
  /** Synthesize a left click at view-relative coords — drives the acceptance
   * checks, which must click INSIDE the native view where Playwright cannot. */
  'office:click': {
    request: { tabId: string; x: number; y: number };
    response: { ok: boolean };
  };
  /** Push Bobble's resolved theme tokens into every editor view. */
  'office:set-theme': {
    request: { tokens: Record<string, string>; dark: boolean };
    response: { ok: boolean };
  };
  /** Is the vendored seam actually present in this build? */
  'office:available': { request: Record<string, never>; response: { available: boolean } };
  /**
   * Re-open the tab's file from disk — the LIVE half of "see the deck being
   * edited". The manager watches every open file itself (an `office edit`
   * replaces the file; the view swaps to a fresh editor once the new one has
   * painted), so this is only for a re-present: `force` reloads even when the
   * editor has focus or the stamp looks unchanged.
   */
  'office:reload': {
    request: { tabId: string; force?: boolean };
    response: { ok: boolean; reloaded: boolean; reason?: string };
  };
  /** The editor's own view state (slide / page / scroll / sheet, dirty, last
   * save) — what a reload carries over. With `state`, navigates the editor
   * there (`{ slide: 1 }`, `{ page: 2 }`) and answers the state afterwards;
   * the acceptance probes drive the editors with it. */
  'office:view-state': {
    request: { tabId: string; state?: Record<string, unknown> };
    response: { state: Record<string, unknown> | null };
  };
};

export type OfficeEventMap = {
  /** The tab's file changed on disk and its editor now shows the new bytes. */
  'office:reloaded': { tabId: string; filePath: string };
};

export const OFFICE_INVOKE_CHANNELS = [
  'office:create',
  'office:destroy',
  'office:set-bounds',
  'office:dirty',
  'office:capture',
  'office:click',
  'office:set-theme',
  'office:available',
  'office:reload',
  'office:view-state',
] as const satisfies readonly (keyof OfficeInvokeMap)[];
