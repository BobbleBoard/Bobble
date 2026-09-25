/**
 * WHAT A FEATURE KEEPS ON DISK, ON THE MANAGE STORAGE PAGE — from its own file.
 *
 * Manage Storage shows the model library and the support root (engines, venvs,
 * tools). The push adds data that belongs to neither: what memory learned
 * (`~/.pi/desktop/memory`), training runs (`~/Bobble/Training`), the studios'
 * documents (`~/Bobble/studio`), Ming's weights and environment. Each feature
 * registers its rows here instead of editing storage-main.ts
 * (deliverables/research/PLAN.md §2.3; the memory, training, studio and Ming
 * rows are WP-M9, TR-10, ED-01 and MING-2).
 *
 * A provider says which folders are its own — Reveal, Trash and Export are
 * refused anywhere else, so registering the roots is what lets its rows be
 * acted on — and produces its rows on each scan. A support-root folder can
 * carry a one-line note the same way (`registerSupportNote`).
 *
 * Electron-free and IO-injected through the providers themselves.
 */
import type { StorageNode } from './storage-contract';

export interface StorageRowProvider {
  /** Stable, for the log and for replacing a registration: `memory`. */
  readonly id: string;
  /** The folders this feature owns (absolute). */
  readonly roots: () => readonly string[];
  /** Its top-level rows on the page, sizes included, read fresh on every scan. */
  readonly rows: () => Promise<readonly StorageNode[]> | readonly StorageNode[];
}

const providers = new Map<string, StorageRowProvider>();
const supportNotes = new Map<string, string>();

/** Register a feature's rows; the returned function removes them. Same id replaces. */
export function registerStorageRows(provider: StorageRowProvider): () => void {
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

/** A one-line note for a folder directly under the support root (`memory` → "…"). */
export function registerSupportNote(folder: string, note: string): () => void {
  supportNotes.set(folder, note);
  return () => {
    if (supportNotes.get(folder) === note) supportNotes.delete(folder);
  };
}

export function supportNoteFor(folder: string): string | undefined {
  return supportNotes.get(folder);
}

/**
 * Every provider's rows, in registration order. One that throws or rejects is
 * reported and left out — a feature's broken scan must not blank the page.
 */
export async function featureStorageRows(
  onError?: (id: string, error: unknown) => void,
): Promise<StorageNode[]> {
  if (providers.size === 0) return [];
  const list = [...providers.values()];
  const settled = await Promise.allSettled(list.map(async (p) => p.rows()));
  const out: StorageNode[] = [];
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') out.push(...res.value);
    else onError?.(list[i]?.id ?? '?', res.reason);
  });
  return out;
}

/** Every provider's own folders. */
export function featureStorageRoots(): string[] {
  const out: string[] = [];
  for (const p of providers.values()) {
    try {
      out.push(...p.roots().filter((r) => r.length > 1 && r.startsWith('/')));
    } catch {
      // A provider that cannot say where it lives owns nothing.
    }
  }
  return out;
}

/** Test seam. */
export function resetStorageRowsForTests(): void {
  providers.clear();
  supportNotes.clear();
}
