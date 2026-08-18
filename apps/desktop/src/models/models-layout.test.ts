/**
 * The hub's filter/sort behaviour, which is the part of the Unsloth layout that
 * is a decision rather than markup. The tests worth having are the ones where a
 * plausible implementation quietly does the wrong thing.
 */
import { describe, expect, it } from 'vitest';
import {
  compactBytes,
  compactCount,
  DEFAULT_FILTERS,
  filterModels,
  formatPipelineTag,
  type HubModel,
  relativeAge,
  sortModels,
} from './models-layout';

const m = (over: Partial<HubModel> & { id: string }): HubModel => ({
  name: over.id,
  org: 'unsloth',
  formats: ['gguf'],
  capabilities: [],
  ...over,
});

describe('"only show models that fit"', () => {
  it('hides models whose fit is UNKNOWN, not just ones that do not fit', () => {
    // A user ticking this is asking not to be shown things that will fail.
    // "We could not tell" belongs on the wrong side of that promise.
    const models = [
      m({ id: 'fits', fits: true }),
      m({ id: 'too-big', fits: false }),
      m({ id: 'unknown' }),
    ];
    const out = filterModels(models, { ...DEFAULT_FILTERS, onlyFits: true });
    expect(out.map((x) => x.id)).toEqual(['fits']);
  });

  it('shows everything when the toggle is off', () => {
    const models = [m({ id: 'a', fits: false }), m({ id: 'b' })];
    expect(filterModels(models, DEFAULT_FILTERS)).toHaveLength(2);
  });
});

describe('format filter', () => {
  it('treats "fine-tune ready" as a safetensors property, not a quant one', () => {
    const models = [
      m({ id: 'gguf-only', formats: ['gguf'] }),
      m({ id: 'st', formats: ['safetensors'] }),
    ];
    const out = filterModels(models, { ...DEFAULT_FILTERS, format: 'finetune' });
    expect(out.map((x) => x.id)).toEqual(['st']);
  });

  it('matches a model that publishes several formats', () => {
    const both = m({ id: 'both', formats: ['gguf', 'mlx'] });
    expect(filterModels([both], { ...DEFAULT_FILTERS, format: 'mlx' })).toHaveLength(1);
    expect(filterModels([both], { ...DEFAULT_FILTERS, format: 'gguf' })).toHaveLength(1);
  });

  it('"All formats" filters nothing out', () => {
    const models = [m({ id: 'a', formats: ['gguf'] }), m({ id: 'b', formats: ['mlx'] })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, format: 'all' })).toHaveLength(2);
  });
});

describe('search + capability', () => {
  it('searches the org as well as the name', () => {
    const models = [m({ id: 'x', name: 'Muse-Glimmer', org: 'nvidia' })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, query: 'nvidia' })).toHaveLength(1);
    expect(filterModels(models, { ...DEFAULT_FILTERS, query: 'glimmer' })).toHaveLength(1);
    expect(filterModels(models, { ...DEFAULT_FILTERS, query: 'qwen' })).toHaveLength(0);
  });

  it('filters by capability', () => {
    const models = [
      m({ id: 'sees', capabilities: ['vision'] }),
      m({ id: 'thinks', capabilities: ['reasoning'] }),
    ];
    const out = filterModels(models, { ...DEFAULT_FILTERS, capabilities: ['vision'] });
    expect(out.map((x) => x.id)).toEqual(['sees']);
  });

  it('several capabilities are OR, not AND', () => {
    // Ticking Vision and Audio means "either" — AND would return almost nothing,
    // since few models claim both.
    const models = [
      m({ id: 'sees', capabilities: ['vision'] }),
      m({ id: 'hears', capabilities: ['audio'] }),
      m({ id: 'neither', capabilities: ['reasoning'] }),
    ];
    const out = filterModels(models, { ...DEFAULT_FILTERS, capabilities: ['vision', 'audio'] });
    expect(out.map((x) => x.id)).toEqual(['sees', 'hears']);
  });

  it('an empty capability set filters nothing', () => {
    const models = [m({ id: 'a' }), m({ id: 'b', capabilities: ['vision'] })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, capabilities: [] })).toHaveLength(2);
  });
});

describe('sorting', () => {
  it('orders by downloads, likes and recency as labelled', () => {
    const models = [
      m({ id: 'a', downloads: 10, likes: 5, updatedAt: 1 }),
      m({ id: 'b', downloads: 900, likes: 1, updatedAt: 2 }),
      m({ id: 'c', downloads: 50, likes: 900, updatedAt: 3 }),
    ];
    expect(sortModels(models, 'downloads')[0]?.id).toBe('b');
    expect(sortModels(models, 'likes')[0]?.id).toBe('c');
    expect(sortModels(models, 'newest')[0]?.id).toBe('c');
  });

  it('trending is not just a second name for most-downloads', () => {
    const models = [
      m({ id: 'downloads-king', downloads: 1000, likes: 0 }),
      m({ id: 'loved', downloads: 700, likes: 40 }),
    ];
    expect(sortModels(models, 'downloads')[0]?.id).toBe('downloads-king');
    expect(sortModels(models, 'trending')[0]?.id).toBe('loved');
  });

  it('"Newest" is NOT "Recently updated" — they were the same comparator', () => {
    // A 2023 model re-quantised yesterday is recently updated and not new.
    const models = [
      m({ id: 'old-but-touched', createdAt: 1_000, updatedAt: 9_000 }),
      m({ id: 'genuinely-new', createdAt: 8_000, updatedAt: 8_100 }),
    ];
    expect(sortModels(models, 'newest')[0]?.id).toBe('genuinely-new');
    expect(sortModels(models, 'updated')[0]?.id).toBe('old-but-touched');
  });

  it('falls back to the update stamp when creation is unknown', () => {
    const models = [m({ id: 'a', updatedAt: 1 }), m({ id: 'b', updatedAt: 5 })];
    expect(sortModels(models, 'newest')[0]?.id).toBe('b');
  });

  it('sorts by size in both directions', () => {
    const GB = 1024 ** 3;
    const models = [
      m({ id: 'big', bytes: 20 * GB }),
      m({ id: 'small', bytes: 2 * GB }),
      m({ id: 'mid', bytes: 8 * GB }),
    ];
    expect(sortModels(models, 'size-asc').map((x) => x.id)).toEqual(['small', 'mid', 'big']);
    expect(sortModels(models, 'size-desc').map((x) => x.id)).toEqual(['big', 'mid', 'small']);
  });

  it('an UNKNOWN size sorts last in both directions — absent is not small', () => {
    // Sorting unmeasured rows to the top of "smallest first" would hand someone
    // on 8GB exactly the models we cannot vouch for.
    const GB = 1024 ** 3;
    const models = [m({ id: 'unknown' }), m({ id: 'known', bytes: 5 * GB })];
    expect(sortModels(models, 'size-asc').map((x) => x.id)).toEqual(['known', 'unknown']);
    expect(sortModels(models, 'size-desc').map((x) => x.id)).toEqual(['known', 'unknown']);
  });

  it('breaks ties on name so the list cannot jitter between renders', () => {
    const models = [m({ id: 'b', name: 'b' }), m({ id: 'a', name: 'a' })];
    expect(sortModels(models, 'downloads').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('never mutates the input array', () => {
    const models = [m({ id: 'a', downloads: 1 }), m({ id: 'b', downloads: 2 })];
    sortModels(models, 'downloads');
    expect(models.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('the pipeline tag as in→out', () => {
  it('reads the X-to-Y shape, including a multi-input left side', () => {
    expect(formatPipelineTag('text-to-image')).toBe('text → image');
    expect(formatPipelineTag('image-to-text')).toBe('image → text');
    expect(formatPipelineTag('image-text-to-text')).toBe('image + text → text');
    expect(formatPipelineTag('text-to-video')).toBe('text → video');
    expect(formatPipelineTag('image-to-3d')).toBe('image → 3D');
  });

  it('reads the tags that do not spell "-to-"', () => {
    expect(formatPipelineTag('automatic-speech-recognition')).toBe('audio → text');
    expect(formatPipelineTag('text-generation')).toBe('text → text');
    expect(formatPipelineTag('feature-extraction')).toBe('embeddings');
    expect(formatPipelineTag('visual-question-answering')).toBe('image + text → text');
  });

  it('shows NOTHING for a tag it cannot read, rather than a cryptic badge', () => {
    expect(formatPipelineTag(undefined)).toBeUndefined();
    expect(formatPipelineTag('')).toBeUndefined();
    expect(formatPipelineTag('robotics')).toBeUndefined();
  });
});

describe('modality is searchable', () => {
  const m2 = (over: Partial<HubModel> & { id: string }): HubModel => ({
    name: over.id,
    org: 'someone',
    formats: ['gguf'],
    capabilities: [],
    ...over,
  });

  it('finds a model by its pipeline tag, raw or readable', () => {
    const models = [
      m2({ id: 'flux', name: 'FLUX', pipelineTag: 'text-to-image' }),
      m2({ id: 'llm', name: 'SomeLLM', pipelineTag: 'text-generation' }),
    ];
    // raw tag
    expect(
      filterModels(models, { ...DEFAULT_FILTERS, scope: 'all', query: 'text-to-image' }).map(
        (x) => x.id,
      ),
    ).toEqual(['flux']);
    // the readable form, word by word
    expect(
      filterModels(models, { ...DEFAULT_FILTERS, scope: 'all', query: 'text image' }).map(
        (x) => x.id,
      ),
    ).toEqual(['flux']);
  });

  it('finds a model by a capability word', () => {
    const models = [
      m2({ id: 'sees', capabilities: ['vision'] }),
      m2({ id: 'plain', capabilities: [] }),
    ];
    expect(
      filterModels(models, { ...DEFAULT_FILTERS, scope: 'all', query: 'vision' }).map((x) => x.id),
    ).toEqual(['sees']);
  });
});

describe('the Recommended / All scope', () => {
  it('hides orgs that are not on the reliable allowlist', () => {
    // the user: "'newest' will show just a bunch of random models… have reputable
    // organizations shown". Community re-quanters and individuals are the
    // firehose the toggle exists to hold back.
    const models = [
      m({ id: 'a', org: 'unsloth' }),
      m({ id: 'b', org: 'Krypto-Whitehat' }),
      m({ id: 'c', org: 'mradermacher' }),
    ];
    const out = filterModels(models, { ...DEFAULT_FILTERS, scope: 'recommended' });
    expect(out.map((x) => x.id)).toEqual(['a']);
  });

  it('"all" is the unfiltered firehose', () => {
    const models = [m({ id: 'a', org: 'unsloth' }), m({ id: 'b', org: 'somebody' })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, scope: 'all' })).toHaveLength(2);
  });

  it('recommends by DEFAULT — the default view decides what the hub looks like', () => {
    const models = [m({ id: 'a', org: 'unsloth' }), m({ id: 'b', org: 'somebody' })];
    expect(filterModels(models, DEFAULT_FILTERS).map((x) => x.id)).toEqual(['a']);
  });

  it('matches a handle whatever its capitalisation', () => {
    // HF shows 'Qwen' and 'BAAI' with their published caps but hands back
    // whatever the author typed; an exact-match test answered "not reliable"
    // for the very orgs the list names.
    const models = [m({ id: 'a', org: 'qwen' }), m({ id: 'b', org: 'QWEN' })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, scope: 'recommended' })).toHaveLength(2);
  });

  it('includes the first-party labs, not just the GGUF re-hosts', () => {
    const labs = ['meta-llama', 'mistralai', 'deepseek-ai', 'microsoft', 'allenai'];
    const models = labs.map((org, i) => m({ id: `x${i}`, org }));
    expect(filterModels(models, { ...DEFAULT_FILTERS, scope: 'recommended' })).toHaveLength(
      labs.length,
    );
  });
});

describe('the size cap', () => {
  const GB = 1024 ** 3;

  it('hides anything above the cap, in GB, when the row has real bytes', () => {
    const models = [m({ id: 'fits', bytes: 4 * GB }), m({ id: 'huge', bytes: 40 * GB })];
    const out = filterModels(models, { ...DEFAULT_FILTERS, maxSize: 10 });
    expect(out.map((x) => x.id)).toEqual(['fits']);
  });

  it('caps a byteless repo row on PARAMETERS instead', () => {
    // A Discover row is a repo holding every quant it publishes, so it has no
    // meaningful byte size — only a parameter count. Ignoring that is how the
    // slider shipped filtering nothing at all on the tab people actually use.
    const models = [m({ id: 'small', paramsB: 4 }), m({ id: 'big', paramsB: 27 })];
    const out = filterModels(models, { ...DEFAULT_FILTERS, maxSize: 12 });
    expect(out.map((x) => x.id)).toEqual(['small']);
  });

  it('prefers real bytes over parameters when a row knows both', () => {
    // A 27B model in a 6GB file on disk fits; judging it as "27" would hide it.
    const models = [m({ id: 'quantised', bytes: 6 * GB, paramsB: 27 })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, maxSize: 12 })).toHaveLength(1);
  });

  it('keeps rows whose size is unknown either way — a cap cannot judge the unseen', () => {
    const models = [m({ id: 'unknown' })];
    expect(filterModels(models, { ...DEFAULT_FILTERS, maxSize: 1 })).toHaveLength(1);
  });

  it('no cap filters nothing', () => {
    const models = [m({ id: 'huge', bytes: 900 * GB }), m({ id: 'wide', paramsB: 1573 })];
    expect(filterModels(models, DEFAULT_FILTERS)).toHaveLength(2);
  });
});

describe('the hub number formats', () => {
  it('matches the reference stamps', () => {
    expect(compactCount(1_900_000)).toBe('1.9M');
    expect(compactCount(84_800)).toBe('84.8K');
    expect(compactCount(45)).toBe('45');
    expect(compactCount(undefined)).toBe('—');
  });

  it('drops the decimal on large sizes, keeps it on small', () => {
    expect(compactBytes(21 * 1024 ** 3)).toBe('21 GB');
    expect(compactBytes(850 * 1024 ** 3)).toBe('850 GB');
    expect(compactBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(compactBytes(412 * 1024 ** 2)).toBe('412 MB');
  });

  it('switches to TB before the number stops being readable', () => {
    // HF lists datasets in the thousands of GB; "12856 GB" is not a size.
    expect(compactBytes(12_856 * 1024 ** 3)).toBe('13 TB');
    expect(compactBytes(1782 * 1024 ** 3)).toBe('1.7 TB');
    expect(compactBytes(850 * 1024 ** 3)).toBe('850 GB');
  });

  it('ages relative to a supplied now, never a hidden clock', () => {
    const now = 1_000 * 86_400_000;
    expect(relativeAge(now, now)).toBe('today');
    expect(relativeAge(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeAge(now - 60 * 86_400_000, now)).toBe('2mo ago');
    expect(relativeAge(now - 800 * 86_400_000, now)).toBe('2y ago');
  });
});
