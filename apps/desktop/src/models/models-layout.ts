/**
 * THE MODEL-HUB LAYOUT RULES, separated from the rendering.
 *
 * The user asked to "totally copy the layout of unsloth studio and how they show
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
import { isReliablePublisher } from '@pi-desktop/inference/catalog';
import type { OutputModality } from './recommended-catalog';

export type ModelFormat = 'all' | 'gguf' | 'safetensors' | 'mlx' | 'finetune';
/**
 * Capabilities AND generation types in one axis. The user: "how about a filter by
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
/**
 * HF's pipeline tag, as a readable INPUT → OUTPUT badge.
 *
 * The user: "see at a glance the hf label that is in-out eg. image-text-text or
 * whatever". HF's tags already encode the modalities on each side — `text-to-
 * image`, `image-text-to-text`, `automatic-speech-recognition` — but the raw
 * string is jargon. This turns it into "text → image", "image + text → text",
 * "audio → text": same information, legible at a glance.
 *
 * Returns undefined for a tag we cannot confidently read, so a row shows nothing
 * rather than a wrong or cryptic badge.
 */
const MODALITY_WORD: Record<string, string> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  speech: 'audio',
  '3d': '3D',
  multimodal: 'any',
  any: 'any',
};

/** Tags that do not follow the `X-to-Y` shape but still have a clear in→out. */
const PIPELINE_SPECIAL: Record<string, string> = {
  'text-generation': 'text → text',
  conversational: 'text → text',
  'fill-mask': 'text → text',
  summarization: 'text → text',
  translation: 'text → text',
  'question-answering': 'text → text',
  'automatic-speech-recognition': 'audio → text',
  'text-to-speech': 'text → audio',
  'audio-classification': 'audio → label',
  'voice-activity-detection': 'audio → label',
  'feature-extraction': 'embeddings',
  'sentence-similarity': 'embeddings',
  'text-classification': 'text → label',
  'token-classification': 'text → labels',
  'zero-shot-classification': 'text → label',
  'image-classification': 'image → label',
  'object-detection': 'image → boxes',
  'image-segmentation': 'image → mask',
  'visual-question-answering': 'image + text → text',
  'document-question-answering': 'image + text → text',
  'depth-estimation': 'image → depth',
  'any-to-any': 'any → any',
};

export function formatPipelineTag(tag: string | undefined): string | undefined {
  if (tag === undefined || tag.length === 0) return undefined;
  const t = tag.toLowerCase();
  const special = PIPELINE_SPECIAL[t];
  if (special !== undefined) return special;
  const m = /^(.+?)-to-(.+)$/.exec(t);
  if (m === null) return undefined;
  const side = (part: string): string => {
    const words = part.split('-').map((w) => MODALITY_WORD[w] ?? w);
    // Dedupe ("image-image") and join the input side with " + ".
    return [...new Set(words)].join(' + ');
  };
  return `${side(m[1] ?? '')} → ${side(m[2] ?? '')}`;
}

/**
 * WHAT A MODEL MAKES, from its pipeline tag.
 *
 * The user: "everything filterable by output also". The output side of the tag is
 * the axis — it is the question someone actually arrives with ("I want to make a
 * video"), where `capabilities` mixes what a model understands with what it
 * produces.
 *
 * Returns undefined when the tag names no generative output (a classifier, an
 * embedder, a detector). Those are not hidden by a filter that is not set; they
 * simply cannot answer "shows me things that make video", and pretending
 * otherwise would put a depth estimator in the image results.
 */
export function outputOfPipelineTag(tag: string | undefined): OutputModality | undefined {
  if (tag === undefined || tag.length === 0) return undefined;
  const t = tag.toLowerCase();
  const direct: Record<string, OutputModality> = {
    'text-generation': 'text',
    conversational: 'text',
    summarization: 'text',
    translation: 'text',
    'question-answering': 'text',
    'image-text-to-text': 'text',
    'visual-question-answering': 'text',
    'document-question-answering': 'text',
    'automatic-speech-recognition': 'text',
    'text-to-speech': 'audio',
    'text-to-audio': 'audio',
  };
  const hit = direct[t];
  if (hit !== undefined) return hit;
  const m = /^(?:.+?)-to-(.+)$/.exec(t);
  if (m === null) return undefined;
  const out = m[1] ?? '';
  if (out.includes('3d')) return '3d';
  if (out.includes('video')) return 'video';
  if (out.includes('image')) return 'image';
  if (out.includes('audio') || out.includes('speech')) return 'audio';
  if (out.includes('text')) return 'text';
  return undefined;
}

/**
 * Capabilities whose models do not come as GGUF — image/video/3D generators and
 * audio models are diffusers/safetensors, run by a different engine. The hub
 * defaults its FORMAT filter to gguf (how a text model is run here), so without
 * this a user who ticks "Image" while format is still gguf would see nothing:
 * the format gate and the `filter=gguf` search would both drop every diffuser.
 * These capabilities exempt a model from the gguf format requirement.
 */
export const NON_GGUF_CAPABILITIES: ReadonlySet<ModelCapability> = new Set([
  'image-generation',
  'video-generation',
  '3d-generation',
  'audio',
]);

/** Does this filter ask for a modality that is not packaged as GGUF? */
export function wantsNonGguf(capabilities: readonly ModelCapability[]): boolean {
  return capabilities.some((c) => NON_GGUF_CAPABILITIES.has(c));
}

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
  /** HF pipeline tag verbatim, e.g. "image-text-to-text" — the in→out label. */
  readonly pipelineTag?: string;
  readonly downloaded?: boolean;
  /**
   * WHICH quants are on disk, not merely whether ANY is.
   *
   * The boolean above is per-REPO, and the quant picker was using it to label
   * whatever row happened to be selected: open a model you own at Q3 and the
   * picker said "Installed" over BF16, a 47 GB file nobody had fetched. A
   * control that reports the state of a different file than the one it names is
   * worse than one that reports nothing.
   */
  readonly downloadedQuants?: readonly string[];
  /** From model-manager-logic's fit verdict — this module never recomputes it. */
  readonly fits?: boolean;
  readonly fitReason?: string;
}

export interface HubFilters {
  readonly format: ModelFormat;
  /**
   * MULTI-SELECT. The user: "have that capabilities dropdown be a checkbox that
   * doesn't immediately close dropdown so you can select multiple." Empty means
   * no capability filter — which is different from a magic 'all' member, because
   * a set with an 'all' in it has two ways to say the same thing.
   */
  readonly capabilities: readonly ModelCapability[];
  readonly sort: ModelSort;
  readonly onlyFits: boolean;
  readonly query: string;
  /**
   * Upper bound in GB, or undefined for no cap. The user asked for "maybe a slider
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
  /**
   * WHOSE REPOS TO SHOW. The user: "by default, the 'newest' will show just a bunch
   * of random models, so if you could just have reputable organizations shown,
   * for example a 'reccomended/all' toggle".
   *
   * 'recommended' keeps only orgs on the inference package's
   * RELIABLE_PUBLISHERS allowlist — the same list the catalog uses to decide
   * whether a publisher is trustworthy, so the two cannot disagree. 'all' is
   * the unfiltered firehose.
   *
   * Defaults to 'recommended', because the default view is the one that decides
   * what a newcomer thinks this hub is.
   */
  readonly scope?: 'recommended' | 'all';
  /**
   * WHAT IT MAKES. The user: "everything filterable by output also".
   *
   * Multi-select, and empty means no filter — the same shape as `capabilities`,
   * for the same reason: a magic 'all' member gives the set two ways to say the
   * same thing. A row whose tag names no generative output is dropped when this
   * is set, because "makes video" is a claim it cannot support.
   */
  readonly outputs?: readonly OutputModality[];
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
 * The user's report: "searching for datasets seeming to not work because filters for
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
    // A generation model (image/video/3D/audio) is never GGUF, so the format
    // gate does not apply to it — otherwise the default gguf format hides every
    // diffuser the moment you filter to "Image".
    const isGenModel = m.capabilities.some((c) => NON_GGUF_CAPABILITIES.has(c));
    if (f.format === 'finetune') {
      // "Fine-tune ready" is a safetensors property, not a quantised-file one.
      if (!m.formats.includes('safetensors')) return false;
    } else if (f.format !== 'all' && !isGenModel && !m.formats.includes(f.format)) {
      return false;
    }
    /* OR, not AND: ticking Vision and Audio means "show me either", which is
       how a browse filter reads. AND would return almost nothing. */
    if (f.capabilities.length > 0 && !f.capabilities.some((c) => m.capabilities.includes(c)))
      return false;
    if (f.onlyFits && m.fits !== true) return false;
    if (f.scope !== 'all' && !isReliablePublisher(m.org)) return false;
    if (f.outputs !== undefined && f.outputs.length > 0) {
      const out = outputOfPipelineTag(m.pipelineTag);
      if (out === undefined || !f.outputs.includes(out)) return false;
    }
    if (f.maxSize !== undefined) {
      if (m.bytes !== undefined) {
        if (m.bytes > f.maxSize * 1024 ** 3) return false;
      } else if (m.paramsB !== undefined && m.paramsB > f.maxSize) {
        return false;
      }
    }
    if (q.length > 0) {
      // Modality is searchable: the raw tag ("image-text-to-text"), the readable
      // form ("image + text → text"), and the capability ids all match, so a
      // user can type "speech", "vision", "text to image" and find it.
      const haystack = [
        m.name,
        m.org,
        m.pipelineTag ?? '',
        formatPipelineTag(m.pipelineTag) ?? '',
        m.capabilities.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      // Match on the query as a whole AND on its words, so "text to image"
      // (which the badge renders with arrows) still hits.
      const words = q.split(/\s+/).filter(Boolean);
      if (!haystack.includes(q) && !words.every((w) => haystack.includes(w))) return false;
    }
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
  // Empty, not a dash: these feed one-word stat chips, and a dash there is a
  // shrug that still costs a chip's worth of space.
  if (n === undefined) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** "21 GB" / "850 GB" / "412 MB". Coarse, for a size chip. */
export function compactBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const tb = bytes / 1024 ** 4;
  // Datasets go up here — HF lists several over a petabyte — and "12856 GB" is
  // a number nobody can read at a glance.
  if (tb >= 1) return `${tb >= 100 ? Math.round(tb) : Number(tb.toFixed(tb >= 10 ? 0 : 1))} TB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** "1d ago" / "2mo ago". Relative stamps. */
export function relativeAge(at: number | undefined, now: number): string {
  if (at === undefined) return '';
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
