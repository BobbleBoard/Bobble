/**
 * THE MODEL-HUB LAYOUT RULES, separated from the rendering.
 *
 * the user asked to "totally copy the layout of unsloth studio and how they show
 * it", and supplied screenshots. The parts of that layout that are DECISIONS
 * rather than markup live here so they can be tested and so an adversarial
 * review has something concrete to check against the references:
 *
 *   - three view modes (split / detail / compact) with compact as a real table
 *   - a filter row: format, capability, sort, and a "only show models that fit"
 *     toggle that lives inside the sort menu
 *   - fit verdicts shown as a coloured dot + a tooltip that says WHY, e.g.
 *     "Exceeds combined VRAM and system RAM budget."
 *   - a hardware strip (Cache / Local / VRAM / RAM / CPU) in the header
 *
 * The fit maths is NOT re-implemented here — model-manager-logic.ts already owns
 * the Unsloth-style three-key quant sort and the RAM verdicts, and duplicating
 * it would give us two answers to "does this fit".
 */

export type ModelFormat = 'all' | 'gguf' | 'safetensors' | 'mlx' | 'finetune';
/**
 * Capabilities AND generation types in one axis. the user: "how about a filter by
 * generation type, generation: we have 3d video image text etc. maybe merge in
 * capabilities". They are the same question from the user's side — "what can
 * this thing do" — so two dropdowns asking it would be two places to look.
 */
export type ModelCapability =
  | 'reasoning'
  | 'vision'
  | 'audio'
  | 'embeddings'
  | 'text-generation'
  | 'image-generation'
  | 'video-generation'
  | '3d-generation';
export type ModelSort =
  | 'newest'
  | 'trending'
  | 'downloads'
  | 'updated'
  | 'likes'
  | 'size-asc'
  | 'size-desc';
export type ViewMode = 'split' | 'detail' | 'compact';

export const FORMAT_OPTIONS: Array<{ id: ModelFormat; label: string; dot?: string }> = [
  { id: 'all', label: 'All formats' },
  { id: 'gguf', label: 'GGUF', dot: 'var(--pd-accent-blue, #3b82f6)' },
  { id: 'safetensors', label: 'Safetensors', dot: 'var(--pd-accent-pink, #ec4899)' },
  { id: 'mlx', label: 'MLX', dot: 'var(--pd-accent-amber, #f59e0b)' },
  { id: 'finetune', label: 'Fine-tune ready' },
];

/** Grouped so the menu reads as "what it understands" then "what it makes". */
export const CAPABILITY_OPTIONS: Array<{
  id: ModelCapability;
  label: string;
  group: 'understands' | 'generates';
}> = [
  { id: 'reasoning', label: 'Reasoning', group: 'understands' },
  { id: 'vision', label: 'Vision', group: 'understands' },
  { id: 'audio', label: 'Audio', group: 'understands' },
  { id: 'embeddings', label: 'Embeddings', group: 'understands' },
  { id: 'text-generation', label: 'Text', group: 'generates' },
  { id: 'image-generation', label: 'Image', group: 'generates' },
  { id: 'video-generation', label: 'Video', group: 'generates' },
  { id: '3d-generation', label: '3D', group: 'generates' },
];

export const SORT_OPTIONS: Array<{ id: ModelSort; label: string }> = [
  { id: 'newest', label: 'Newest' },
  { id: 'trending', label: 'Trending' },
  { id: 'downloads', label: 'Most downloads' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'likes', label: 'Most likes' },
  { id: 'size-asc', label: 'Smallest first' },
  { id: 'size-desc', label: 'Largest first' },
];

/** A row as the hub needs it, independent of where the entry came from. */
export interface HubModel {
  readonly id: string;
  readonly name: string;
  /** Hugging Face org, for the avatar and the "unsloth ✓" line. */
  readonly org: string;
  readonly verified?: boolean;
  readonly params?: string;
  /** Parameter count in BILLIONS, when known — the numeric twin of `params`.
   * This is the size axis a Discover row actually has (see `maxSize`). */
  readonly paramsB?: number;
  readonly bytes?: number;
  readonly downloads?: number;
  readonly likes?: number;
  readonly updatedAt?: number;
  /** Repo creation time — what "Newest" actually means. */
  readonly createdAt?: number;
  readonly formats: readonly Exclude<ModelFormat, 'all' | 'finetune'>[];
  readonly capabilities: readonly ModelCapability[];
  readonly downloaded?: boolean;
  /** From model-manager-logic's fit verdict — this module never recomputes it. */
  readonly fits?: boolean;
  readonly fitReason?: string;
}

export interface HubFilters {
  readonly format: ModelFormat;
  /**
   * MULTI-SELECT. the user: "have that capabilities dropdown be a checkbox that
   * doesn't immediately close dropdown so you can select multiple." Empty means
   * no capability filter — which is different from a magic 'all' member, because
   * a set with an 'all' in it has two ways to say the same thing.
   */
  readonly capabilities: readonly ModelCapability[];
  readonly sort: ModelSort;
  readonly onlyFits: boolean;
  readonly query: string;
  /**
   * Upper bound in GB, or undefined for no cap. the user asked for "maybe a slider
   * for size" — a MAXIMUM is the useful end of that range: the question people
   * ask a hub is "what fits", never "what is at least this big".
   */
  /**
   * ONE upper size bound, judged against whichever size the row actually knows.
   *
   * Its unit depends on the row, and that is deliberate rather than sloppy:
   *   - a DATASET or an on-disk file has real bytes, so the cap is GB;
   *   - a Discover MODEL row is a repo holding every quant it publishes, so its
   *     total storage says nothing about what you would download. Its real size
   *     axis is parameters, which is also what the Size column shows.
   *
   * Bytes win when a row somehow knows both. A row that knows NEITHER is kept —
   * a cap cannot judge what it cannot see, and hiding unmeasured rows is how
   * "only show models that fit" ended up showing nothing at all.
   *
   * The label at the control has to name the unit it is applying; a bare number
   * over a slider is where this would turn into a lie.
   */
  readonly maxSize?: number;
}

export const DEFAULT_FILTERS: HubFilters = {
  format: 'gguf',
  capabilities: [],
  sort: 'newest',
  onlyFits: false,
  query: '',
};

/**
 * Datasets have no quant format and no inference capabilities, so they start
 * from a different baseline. Keeping the two sets SEPARATE is the fix for
 * the user's report: "searching for datasets seeming to not work because filters for
 * gguf vision etc persist and obviously those files don't exist in datasets,
 * save those for when the user swaps back to the models tab, don't reset their
 * filters".
 */
export const DEFAULT_DATASET_FILTERS: HubFilters = {
  format: 'all',
  capabilities: [],
  sort: 'downloads',
  onlyFits: false,
  query: '',
};

/**
 * Apply the filter row. Kept total and pure so the adversarial review can check
 * behaviour against the reference without launching anything.
 *
 * The judgement worth naming: `onlyFits` hides models whose fit is UNKNOWN as
 * well as models that don't fit. A user who ticks "only show models that fit"
 * is asking not to be shown things that will fail, and "we couldn't tell"
 * belongs on the wrong side of that promise.
 */
export function filterModels(models: readonly HubModel[], f: HubFilters): HubModel[] {
  const q = f.query.trim().toLowerCase();
  return models.filter((m) => {
    if (f.format === 'finetune') {
      // "Fine-tune ready" is a safetensors property, not a quantised-file one.
      if (!m.formats.includes('safetensors')) return false;
    } else if (f.format !== 'all' && !m.formats.includes(f.format)) {
      return false;
    }
    /* OR, not AND: ticking Vision and Audio means "show me either", which is
       how a browse filter reads. AND would return almost nothing. */
    if (f.capabilities.length > 0 && !f.capabilities.some((c) => m.capabilities.includes(c)))
      return false;
    if (f.onlyFits && m.fits !== true) return false;
    if (f.maxSize !== undefined) {
      if (m.bytes !== undefined) {
        if (m.bytes > f.maxSize * 1024 ** 3) return false;
      } else if (m.paramsB !== undefined && m.paramsB > f.maxSize) {
        return false;
      }
    }
    if (q.length > 0 && !`${m.name} ${m.org}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Unknown size sorts last ascending: absent is not "small". */
function sizeKey(m: HubModel): number {
  return m.bytes ?? Number.POSITIVE_INFINITY;
}
/** …and last descending too, hence a separate key rather than a negation. */
function sizeKeyDesc(m: HubModel): number {
  return m.bytes ?? Number.NEGATIVE_INFINITY;
}

/** Order for the chosen sort. Ties break on name so the list never jitters. */
export function sortModels(models: readonly HubModel[], sort: ModelSort): HubModel[] {
  const by = (n: number | undefined): number => n ?? -1;
  const cmp: Record<ModelSort, (a: HubModel, b: HubModel) => number> = {
    /* NEWEST IS NOT RECENTLY-UPDATED. These were the same comparator on the
       same field, so the two menu entries did the same thing. A 2023 model
       re-quantised yesterday is recently updated and not new; `createdAt`
       is the only field that separates them. Falls back to updatedAt only
       when creation is unknown, so a source without it still sorts sanely. */
    newest: (a, b) => by(b.createdAt ?? b.updatedAt) - by(a.createdAt ?? a.updatedAt),
    updated: (a, b) => by(b.updatedAt) - by(a.updatedAt),
    downloads: (a, b) => by(b.downloads) - by(a.downloads),
    likes: (a, b) => by(b.likes) - by(a.likes),
    // Trending has no server signal here, so it is downloads weighted by
    // recency rather than a second name for "most downloads".
    trending: (a, b) =>
      by(b.downloads) * 0.7 + by(b.likes) * 30 - (by(a.downloads) * 0.7 + by(a.likes) * 30),
    /*
     * Size sorts put UNKNOWN sizes last in both directions, rather than letting
     * them win "smallest". A model whose size we never learned is not small; it
     * is unmeasured, and sorting it to the top of "smallest first" would hand
     * someone on 8GB exactly the rows we cannot vouch for.
     */
    'size-asc': (a, b) => sizeKey(a) - sizeKey(b),
    'size-desc': (a, b) => sizeKeyDesc(b) - sizeKeyDesc(a),
  };
  return [...models].sort((a, b) => {
    const d = cmp[sort](a, b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}

/** Compact download/like counts, the way a hub shows them: 1.9M, 84.8K, 45. */
export function compactCount(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** "21 GB" / "850 GB" / "412 MB" — coarse, for a size chip. */
export function compactBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const tb = bytes / 1024 ** 4;
  // Datasets go up here — HF lists several over a petabyte — and "12856 GB" is
  // a number nobody can read at a glance.
  if (tb >= 1) return `${tb >= 100 ? Math.round(tb) : Number(tb.toFixed(tb >= 10 ? 0 : 1))} TB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** "1d ago" / "2mo ago" — the reference's relative stamps. */
export function relativeAge(at: number | undefined, now: number): string {
  if (at === undefined) return '—';
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
