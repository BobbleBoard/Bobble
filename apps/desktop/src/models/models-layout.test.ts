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

  it('ages relative to a supplied now, never a hidden clock', () => {
    const now = 1_000 * 86_400_000;
    expect(relativeAge(now, now)).toBe('today');
    expect(relativeAge(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeAge(now - 60 * 86_400_000, now)).toBe('2mo ago');
    expect(relativeAge(now - 800 * 86_400_000, now)).toBe('2y ago');
  });
});
