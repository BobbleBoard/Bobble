/**
 * MANAGE STORAGE — the renderer's view of what is on disk, where, and how big.
 *
 * the user (2026-09-12): "a page in the model manager that says 'Manage Storage'
 * — this shows a UI that lets us visually navigate and see how much is being
 * taken up, and view and delete models, sorted the same way, always with a
 * 'Reveal' button easy to see and use if desired."
 */

/** One row of the tree: a shelf, a model folder, a loose weight, or a tool. */
export interface StorageNode {
  /** What to call it. A repo folder reads as its repo (`org/name`). */
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly kind: 'root' | 'modality' | 'shelf' | 'model' | 'file' | 'dir' | 'tool';
  /** One line under the name: what it is for, which engine reads it. */
  readonly note?: string;
  /** The folder is a Hugging Face repo dir the workers reach through a link. */
  readonly hubLinked?: boolean;
  /** Something is serving from here right now — deleting it would pull the rug. */
  readonly inUse?: boolean;
  readonly children?: readonly StorageNode[];
  /** Files directly inside, for a model folder (name + bytes), capped. */
  readonly fileCount?: number;
}

export interface StorageOverview {
  readonly libraryRoot: string;
  readonly defaultLibraryRoot: string;
  readonly supportRoot: string;
  /** Free / total bytes on the volume holding the library. */
  readonly disk: { readonly free: number; readonly total: number };
  readonly library: StorageNode;
  /** Engines, venvs, tool binaries, scratch — beside the library, not in it. */
  readonly support: readonly StorageNode[];
  /** What the last boot-time migration did, for the page to say. */
  readonly migration: {
    readonly ranAt: string | null;
    readonly moved: number;
    readonly skipped: readonly { readonly path: string; readonly why: string }[];
    readonly unsorted: readonly string[];
  } | null;
  /** How long the scan took, so a slow disk explains itself. */
  readonly scanMs: number;
}

export type StorageInvokeMap = {
  'storage:overview': { request: { fresh?: boolean } | undefined; response: StorageOverview };
  /** Finder, with the item selected. */
  'storage:reveal': { request: { path: string }; response: { ok: boolean; error?: string } };
  /** To the Trash — recoverable, and its hub link (if any) removed with it. */
  'storage:trash': {
    request: { path: string };
    response: { ok: boolean; error?: string; freed?: number };
  };
  /** A native folder picker for a new library location. */
  'storage:pick-root': { request: undefined; response: { path: string | null } };
  /**
   * Move the library to `path` (null = the default) and remember it. Same
   * volume: a rename. Another volume: copied with progress, then the old copy
   * removed. Refused while a model server is serving from it.
   */
  'storage:set-root': {
    request: { path: string | null };
    response: { ok: boolean; error?: string; root?: string };
  };
};

export interface StorageMoveProgress {
  readonly phase: 'copying' | 'removing' | 'done' | 'failed';
  readonly copied: number;
  readonly total: number;
  readonly error?: string;
}

export type StorageEventMap = {
  'storage:move': StorageMoveProgress;
};

export const STORAGE_INVOKE_CHANNELS = [
  'storage:overview',
  'storage:reveal',
  'storage:trash',
  'storage:pick-root',
  'storage:set-root',
] as const;

export const STORAGE_EVENT_CHANNELS = ['storage:move'] as const;
