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
  /** Is the vendored seam actually present in this build? */
  'office:available': { request: Record<string, never>; response: { available: boolean } };
};

export const OFFICE_INVOKE_CHANNELS = [
  'office:create',
  'office:destroy',
  'office:set-bounds',
  'office:dirty',
  'office:capture',
  'office:available',
] as const satisfies readonly (keyof OfficeInvokeMap)[];
