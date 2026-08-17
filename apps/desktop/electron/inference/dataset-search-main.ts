/**
 * DATASET SEARCH — the reference's sibling page to the model hub
 * ("Discover, download, and train on datasets locally").
 *
 * Its own channel rather than an `hf:` one for the same reason as the model
 * card: those proxy through the inference supervisor for its model registry,
 * and a dataset listing needs none of that. Main does the fetching because the
 * renderer's CSP forbids reaching huggingface.co.
 *
 * Deliberately read-only for now. Listing datasets is honest; offering a
 * "download" that the app cannot then train on would not be.
 */
import type { DatasetHitDTO } from '../ipc-contract';

interface RawDataset {
  id?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  lastModified?: string;
  createdAt?: string;
  private?: boolean;
  gated?: unknown;
  mainSize?: number;
}

const SORTS: Record<string, string> = {
  trending: 'trendingScore',
  downloads: 'downloads',
  likes: 'likes',
  recent: 'lastModified',
};

export async function searchDatasets(req: {
  query: string;
  sort?: string;
  limit?: number;
}): Promise<{ hits: DatasetHitDTO[]; error?: string; rateLimited?: boolean }> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(req.limit ?? 40, 1), 100)),
    direction: '-1',
    sort: SORTS[req.sort ?? 'trending'] ?? 'trendingScore',
  });
  /*
   * `mainSize` is the dataset's total bytes, and it only arrives via `expand[]`.
   *
   * expand[] IS ALL-OR-NOTHING: HF then returns ONLY the keys listed here, so
   * every field the mapper below reads has to be named or it silently becomes
   * undefined — which for `tags` and `likes` means blank pills and zeroed
   * counts while the field you added works fine.
   */
  for (const key of [
    'author',
    'createdAt',
    'downloads',
    'gated',
    'lastModified',
    'likes',
    'mainSize',
    'private',
    'tags',
  ]) {
    params.append('expand[]', key);
  }
  if (req.query.trim().length > 0) params.set('search', req.query.trim());

  try {
    const res = await fetch(`https://huggingface.co/api/datasets?${params.toString()}`, {
      signal: AbortSignal.timeout(12_000),
    });
    // 429 is worth naming: the UI can say "rate-limited" rather than "failed",
    // which is the difference between "wait a moment" and "something is broken".
    if (res.status === 429) return { hits: [], rateLimited: true };
    if (!res.ok) return { hits: [], error: `HTTP ${res.status}` };
    const raw = (await res.json()) as RawDataset[];
    return {
      hits: raw
        .filter((r) => typeof r.id === 'string' && r.private !== true)
        .map((r) => {
          const id = r.id as string;
          return {
            id,
            author: r.author ?? (id.includes('/') ? (id.split('/')[0] ?? '') : ''),
            name: id.includes('/') ? id.slice(id.indexOf('/') + 1) : id,
            downloads: r.downloads ?? 0,
            likes: r.likes ?? 0,
            tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string') : [],
            bytes: typeof r.mainSize === 'number' && r.mainSize > 0 ? r.mainSize : undefined,
            updatedAt: r.lastModified,
            createdAt: r.createdAt,
            gated: r.gated !== undefined && r.gated !== false,
          };
        }),
    };
  } catch (e) {
    return { hits: [], error: e instanceof Error ? e.message : 'dataset search failed' };
  }
}
