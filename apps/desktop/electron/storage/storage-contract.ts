/**
 * MANAGE STORAGE — the renderer's view of what is on disk, where, and how big.
 *
 * The user (2026-09-12): "a page in the model manager that says 'Manage Storage'
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
  /** Newest file inside, ms since the epoch — what "Recent" sorts on. */
  readonly mtime?: number;
  /** What the inspector says about a model, when the catalog or the repo knows. */
  readonly meta?: {
    readonly org?: string;
    readonly params?: string;
    readonly quant?: string;
    readonly modality?: string;
    readonly repo?: string;
    /** One line on what it is for, from whichever catalog knows it. */
    readonly blurb?: string;
    /** The in→out jobs, or the 3D engine's role. */
    readonly tasks?: readonly string[];
    /** A friendlier name than the folder's, when a catalog has one. */
    readonly label?: string;
  };
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
  /**
   * Rows a feature registered for its own data (storage-rows.ts) — what memory
   * learned, training runs, the studios' documents. Empty until one does.
   */
  readonly features: readonly StorageNode[];
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
  /** Free / total bytes on the library's volume — cheap (one statfs), for the hub's strip and download checks. */
  'storage:disk': {
    request: undefined;
    response: { free: number; total: number; root: string };
  };
  /**
   * "Would `bytes` more fit?" — the same answer the download handlers give
   * when they refuse, asked BEFORE a click queues anything, so the hub can say
   * so on the spot instead of a download that silently never starts. `refusal`
   * is the sentence to show, or null when there is room.
   */
  'storage:check-space': {
    request: { bytes: number };
    response: { ok: boolean; refusal: string | null; free: number };
  };
  /** Finder, with the item selected. */
  'storage:reveal': { request: { path: string }; response: { ok: boolean; error?: string } };
  /** To the Trash — recoverable, and each one's hub link (if any) removed with it. */
  'storage:trash': {
    request: { paths: readonly string[] };
    response: {
      ok: boolean;
      freed: number;
      failed: readonly { path: string; error: string }[];
    };
  };
  /**
   * Copy models or folders somewhere the user picks (a native folder dialog);
   * progress on `storage:export`. Nothing is removed.
   */
  'storage:export': {
    /** `dest` is a probe seam (honoured under PI_E2E only): the folder the picker would return. */
    request: { paths: readonly string[]; dest?: string };
    response: { ok: boolean; error?: string; dest?: string; cancelled?: boolean };
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

export interface StorageExportProgress {
  readonly phase: 'copying' | 'done' | 'failed';
  readonly copied: number;
  readonly total: number;
  /** What is being copied right now. */
  readonly current?: string;
  readonly error?: string;
}

export type StorageEventMap = {
  'storage:move': StorageMoveProgress;
  'storage:export': StorageExportProgress;
};

export const STORAGE_INVOKE_CHANNELS = [
  'storage:overview',
  'storage:disk',
  'storage:check-space',
  'storage:reveal',
  'storage:trash',
  'storage:export',
  'storage:pick-root',
  'storage:set-root',
] as const;

export const STORAGE_EVENT_CHANNELS = ['storage:move', 'storage:export'] as const;
