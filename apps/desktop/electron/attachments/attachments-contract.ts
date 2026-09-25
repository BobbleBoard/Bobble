/**
 * IPC contract for the composer's attachments — what a pasted or dropped path
 * is, and a file for pixels that never had one. Composed into the app-wide maps
 * in ../ipc-contract.ts; the handlers are attachments-main.ts.
 */

/** One path, as main found it on disk. */
export interface InspectedPath {
  /** The path as it was asked about. */
  readonly path: string;
  /** Its last segment — the name a person knows it by. */
  readonly name: string;
  /** `missing`: not there, not readable, or neither a file nor a folder. */
  readonly kind: 'file' | 'folder' | 'missing';
  /** A file's size in bytes. */
  readonly bytes?: number;
  /** A folder's visible items, counted up to {@link FOLDER_COUNT_CAP}. */
  readonly entries?: number;
}

/** A folder's item count stops here, so a huge tree costs one bounded read. */
export const FOLDER_COUNT_CAP = 1000;

export type AttachmentsInvokeMap = {
  /**
   * Folder or file, and how big — for the paths of pasted and dropped Files.
   * A folder arrives in the renderer as a File like any other, and only a stat
   * tells it from an empty file.
   */
  'attachments:inspect': {
    request: { paths: readonly string[] };
    response: { items: InspectedPath[] };
  };
  /**
   * Pixels with no file behind them (a screenshot, a card's Copy, a browser's
   * "Copy Image"), written ONCE into ~/Bobble/attachments under their content
   * hash — so the same picture pasted twice is one file.
   */
  'attachments:save-image': {
    request: { dataUrl: string };
    response: { ok: boolean; path?: string; bytes?: number; error?: string };
  };
  /**
   * A picture about to open in the image viewer: its own file when it still
   * has one (handed to pd-file:// for this one file — see attachments-main), or
   * the pixels saved as above when it does not.
   */
  'attachments:view-image': {
    request: { path?: string; dataUrl?: string };
    response: { ok: boolean; path?: string; error?: string };
  };
};

export const ATTACHMENTS_INVOKE_CHANNELS = [
  'attachments:inspect',
  'attachments:save-image',
  'attachments:view-image',
] as const satisfies readonly (keyof AttachmentsInvokeMap)[];
