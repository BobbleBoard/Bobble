/**
 * The quick menu is the user's list, so the tests are mostly about NOT
 * overriding them: their order is kept, their rename does not move the binding,
 * and a favourite that cannot run is not offered.
 */
import { describe, expect, it } from 'vitest';
import {
  addSlot,
  bindSlot,
  DEFAULT_QUICK_MENU,
  downloadedBySize,
  filterModels,
  type MenuModel,
  orgOf,
  quickMenuRows,
  removeSlot,
  renameSlot,
  shouldShowSearch,
  toggleFavourite,
} from './quick-menu';

const GB = 1024 ** 3;
const model = (id: string, bytes: number, downloaded = true): MenuModel => ({
  id,
  displayName: id.split('/')[1] ?? id,
  bytes,
  org: orgOf(id),
  downloaded,
});

const MODELS: MenuModel[] = [
  model('qwen/Qwen3-27B', 18 * GB),
  model('google/gemma-4-12b', 8 * GB),
  model('liquid/LFM-2.6B', 2 * GB),
  model('qwen/Qwen3-8B', 5 * GB, false),
];

describe('quick menu', () => {
  it('lists what is on disk largest first', () => {
    const rows = downloadedBySize(MODELS);
    expect(rows.map((m) => m.displayName)).toEqual(['Qwen3-27B', 'gemma-4-12b', 'LFM-2.6B']);
    // The undownloaded one is not on disk, so it is not in the on-disk list.
    expect(rows.some((m) => m.id === 'qwen/Qwen3-8B')).toBe(false);
  });

  it('breaks size ties on name so the list cannot reshuffle itself', () => {
    const same = [model('a/zeta', GB), model('a/alpha', GB)];
    expect(downloadedBySize(same).map((m) => m.displayName)).toEqual(['alpha', 'zeta']);
  });

  it('reads the publisher out of the id, and does not invent one', () => {
    expect(orgOf('qwen/Qwen3-8B')).toBe('qwen');
    expect(orgOf('some-local-model')).toBe('');
  });

  it('takes the publisher from the HF repo when the id is a bare catalogue name', () => {
    // The built-in catalogue ids look like "qwen3.5-9b" — no publisher in them —
    // so without the repo every shipped model drew a blank avatar.
    expect(orgOf('qwen3.5-9b', 'unsloth/Qwen3.5-9B-GGUF')).toBe('unsloth');
    expect(orgOf('qwen3.5-9b')).toBe('');
  });

  it('only offers search once a search would help', () => {
    expect(shouldShowSearch(3)).toBe(false);
    expect(shouldShowSearch(20)).toBe(true);
  });

  it('searches by org as well as name, because that is how people look', () => {
    expect(filterModels(MODELS, 'qwen').length).toBe(2);
    expect(filterModels(MODELS, 'gemma').map((m) => m.org)).toEqual(['google']);
    expect(filterModels(MODELS, '   ').length).toBe(MODELS.length);
  });

  it('keeps favourites in the order the user made them', () => {
    let cfg = DEFAULT_QUICK_MENU;
    cfg = toggleFavourite(cfg, 'liquid/LFM-2.6B');
    cfg = toggleFavourite(cfg, 'qwen/Qwen3-27B');
    expect(cfg.favourites).toEqual(['liquid/LFM-2.6B', 'qwen/Qwen3-27B']);
    cfg = toggleFavourite(cfg, 'liquid/LFM-2.6B');
    expect(cfg.favourites).toEqual(['qwen/Qwen3-27B']);
  });

  it('renaming a slot does not move which model it runs', () => {
    let cfg = bindSlot(DEFAULT_QUICK_MENU, 'balanced', 'google/gemma-4-12b');
    cfg = renameSlot(cfg, 'balanced', 'Daily');
    const slot = cfg.slots.find((s) => s.id === 'balanced');
    expect(slot?.label).toBe('Daily');
    expect(slot?.modelId).toBe('google/gemma-4-12b');
  });

  it('refuses an empty rename rather than leaving a nameless row', () => {
    const cfg = renameSlot(DEFAULT_QUICK_MENU, 'fast', '   ');
    expect(cfg.slots.find((s) => s.id === 'fast')?.label).toBe('Fast');
  });

  it('gives an added slot a unique id, since ids are what selections persist against', () => {
    let cfg = addSlot(DEFAULT_QUICK_MENU, 'Night run', null);
    cfg = addSlot(cfg, 'Night run', null);
    const ids = cfg.slots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('night-run');
    expect(ids).toContain('night-run-2');
  });

  it('will not delete the capability tiers', () => {
    let cfg = addSlot(DEFAULT_QUICK_MENU, 'Extra', null);
    cfg = removeSlot(cfg, 'balanced');
    expect(cfg.slots.some((s) => s.id === 'balanced')).toBe(true);
    cfg = removeSlot(cfg, 'extra');
    expect(cfg.slots.some((s) => s.id === 'extra')).toBe(false);
  });

  it('puts favourites above the slots', () => {
    const cfg = toggleFavourite(DEFAULT_QUICK_MENU, 'qwen/Qwen3-27B');
    const rows = quickMenuRows(cfg, MODELS, {});
    expect(rows[0]?.kind).toBe('favourite');
    expect(rows[0]?.label).toBe('Qwen3-27B');
    expect(rows.filter((r) => r.kind === 'slot').length).toBe(3);
  });

  it('drops a favourite that is no longer on disk, but keeps it in the config', () => {
    const cfg = toggleFavourite(DEFAULT_QUICK_MENU, 'qwen/Qwen3-8B'); // not downloaded
    const rows = quickMenuRows(cfg, MODELS, {});
    expect(rows.some((r) => r.kind === 'favourite')).toBe(false);
    expect(cfg.favourites).toContain('qwen/Qwen3-8B');
  });

  it('shows the app-chosen model under a slot the user has not pinned', () => {
    const rows = quickMenuRows(DEFAULT_QUICK_MENU, MODELS, {
      balanced: { displayName: 'gemma-4-12b', downloaded: true, bytes: 8 * GB },
    });
    const balanced = rows.find((r) => r.key === 'slot:balanced');
    expect(balanced?.secondary).toBe('gemma-4-12b');
    expect(balanced?.downloaded).toBe(true);
  });

  it('prefers the pinned model over the app-chosen one', () => {
    const cfg = bindSlot(DEFAULT_QUICK_MENU, 'balanced', 'qwen/Qwen3-27B');
    const rows = quickMenuRows(cfg, MODELS, {
      balanced: { displayName: 'gemma-4-12b', downloaded: true, bytes: 8 * GB },
    });
    expect(rows.find((r) => r.key === 'slot:balanced')?.secondary).toBe('Qwen3-27B');
  });
});
