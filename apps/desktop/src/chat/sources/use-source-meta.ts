/**
 * A source page's name, icon and picture, as main resolves them
 * (electron/canvas/source-meta.ts) — cached here per URL and shared by every
 * chip, row and card that shows the page, so an answer citing one page six
 * times asks once.
 *
 * Nothing waits on it. A row renders at once from what the turn already has
 * (the search result's title and snippet, the host, a letter tile) and fills in
 * when this lands; with no network it simply never does. That is the whole
 * offline story, and why there is no error path here.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { SourceMetaDto } from '../../../electron/ipc-contract';

export type SourceMeta = SourceMetaDto;

const metas = new Map<string, SourceMeta | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function request(url: string): void {
  if (metas.has(url) || pending.has(url)) return;
  pending.add(url);
  void (async () => {
    try {
      const res = await window.piDesktop.invoke('canvas:source-meta', { url });
      metas.set(url, res?.meta ?? null);
    } catch {
      metas.set(url, null); // no main process (a test mount): the row keeps its fallbacks
    }
    pending.delete(url);
    notify();
  })();
}

function snapshot(): number {
  return version;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * What main knows about `url`, or undefined while it is still coming (and
 * always, when `enabled` is false — a row that is not on screen asks nothing).
 */
export function useSourceMeta(url: string | undefined, enabled = true): SourceMeta | undefined {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (url !== undefined && enabled) request(url);
  }, [url, enabled]);
  if (url === undefined) return undefined;
  return metas.get(url) ?? undefined;
}

/** Test seam. */
export function clearSourceMetas(): void {
  metas.clear();
  pending.clear();
}
