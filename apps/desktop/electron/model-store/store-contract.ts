/**
 * IPC for the unified model store — "download anything, and know where it went".
 *
 * The GGUF channels (`llm:*`) stay exactly as they are: they own the one-file-
 * out-of-a-ladder case, the running server, and the quant maths. These channels
 * are for everything else — a whole Hugging Face repo, of any modality, fetched
 * into the store and described by a manifest. Two channels rather than one
 * generalised downloader because the two really are different jobs, and merging
 * them would mean a single call whose arguments only make sense half the time.
 */
import type { ModelKind, ModelTask, StoredModel } from '@pi-desktop/model-store';

export interface StoreDownloadRequest {
  readonly repo: string;
  readonly kind: ModelKind;
  readonly name: string;
  readonly family?: string;
  readonly tasks?: readonly ModelTask[];
  readonly backend?: string;
  readonly notes?: string;
  /** `*`-globs limiting what to fetch; omit for the whole repo. */
  readonly allow?: readonly string[];
}

export interface StoreDownloadUpdate {
  readonly repo: string;
  readonly received: number;
  readonly total: number;
  readonly fraction: number;
  /** Which file is moving — the caption under the bar. */
  readonly file: string;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly done: boolean;
  /** Set when the download ended badly; `cancelled` is not an error. */
  readonly error?: string;
  readonly cancelled?: boolean;
}

export type StoreInvokeMap = {
  /** Everything on this machine, across every source, with sizes and paths. */
  'store:list': {
    request: undefined;
    response: { readonly models: readonly StoredModel[]; readonly bytes: number };
  };
  /** Start fetching a repo. Progress arrives on the `store:download` event. */
  'store:download': {
    request: StoreDownloadRequest;
    response: { readonly ok: boolean; readonly error?: string };
  };
  /** Abort the transfer for a repo and throw away what arrived. */
  'store:cancel': {
    request: { readonly repo: string };
    response: { readonly ok: boolean };
  };
  /** Delete a stored model's weights. Refuses entries another component owns. */
  'store:delete': {
    request: { readonly id: string };
    response: { readonly ok: boolean; readonly error?: string };
  };
};

export type StoreEventMap = {
  'store:download': StoreDownloadUpdate;
};

export const STORE_INVOKE_CHANNELS = [
  'store:list',
  'store:download',
  'store:cancel',
  'store:delete',
] as const;

export const STORE_EVENT_CHANNELS = ['store:download'] as const;
