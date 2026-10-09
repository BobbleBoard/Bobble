/**
 * THE QUICK MENU, MADE THE USER'S.
 *
 * The user: "actually allow using favoriting, configuring the quick menu
 * (intelligent balanced fast, add more if you like, rename etc just do model
 * names), have the more models hover/show search bar if enough + show a
 * scrollable list of all downloaded models largest to smallest, include org
 * icons and model name."
 *
 * What existed was a fixed list: Auto, then three capability tiers the app
 * chose the models for, then a link to the full manager. Nothing about it was
 * configurable, so a user whose actual working set is two models they picked
 * themselves had to go through the manager every time.
 *
 * THREE THINGS THIS ADDS, and the reasoning behind each:
 *
 * FAVOURITES lead the menu. A favourite is a model the user named, so it
 * outranks a tier the app inferred — anything else would be the app arguing
 * with them. They keep the order the user put them in rather than being
 * re-sorted by size or name, because a hand-made list is already in the order
 * its author wanted.
 *
 * SLOTS are the tiers, but editable: rename them, point them at a different
 * model, add more. THE RENAME IS A LABEL OVER A BINDING, never a replacement
 * for it — a slot always keeps the model id it resolves to, so renaming
 * "Balanced" to "Daily" cannot quietly change which model runs. That is the one
 * design rule here worth stating, because the obvious shortcut (store the label
 * and look the model up by it) breaks the moment two slots share a name or a
 * model is removed.
 *
 * THE FULL LIST is every model on disk, LARGEST FIRST. Largest-first is not an
 * arbitrary sort: size is the axis the user is trading against, so descending
 * size reads as a capability ladder, and the thing you scroll past first is the
 * most capable thing you own. A search box appears only once the list is long
 * enough to need one — a search field over four rows is furniture.
 */
import type { ModelSelectionTier } from '../../electron/settings/settings-contract';

/** A configurable slot in the quick menu — a tier the user can edit. */
export interface QuickSlot {
  /** Stable id; the three defaults reuse the tier names so old settings load. */
  readonly id: string;
  /** What the user calls it. Defaults to the tier's own label. */
  readonly label: string;
  /**
   * The model this slot runs, or null to let the app keep choosing for it.
   * A slot with a model id is pinned; a slot without one follows the tier.
   */
  readonly modelId: string | null;
  /** Which capability tier this slot came from, when it is one of the defaults. */
  readonly tier?: ModelSelectionTier;
}

/** The user's quick-menu configuration, as persisted. */
export interface QuickMenuConfig {
  /** Model ids, in the order the user arranged them. */
  readonly favourites: readonly string[];
  readonly slots: readonly QuickSlot[];
}

/** What the app ships with: the three capability tiers, unrenamed, unpinned. */
export const DEFAULT_SLOTS: readonly QuickSlot[] = [
  { id: 'fast', label: 'Fast', modelId: null, tier: 'fast' },
  { id: 'balanced', label: 'Balanced', modelId: null, tier: 'balanced' },
  { id: 'intelligent', label: 'Intelligent', modelId: null, tier: 'intelligent' },
];

export const DEFAULT_QUICK_MENU: QuickMenuConfig = {
  favourites: [],
  slots: DEFAULT_SLOTS,
};

/**
 * Below this many models a search box is clutter rather than help.
 * Six is about a screenful of rows in this menu.
 */
export const SEARCH_THRESHOLD = 6;

export function shouldShowSearch(modelCount: number): boolean {
  return modelCount > SEARCH_THRESHOLD;
}

/** One model as the menu renders it. */
export interface MenuModel {
  readonly id: string;
  readonly displayName: string;
  /** Bytes on disk. Drives the sort and the size chip. */
  readonly bytes: number;
  /** Publisher handle, for the org icon (`qwen`, `google`, …). */
  readonly org: string;
  readonly downloaded: boolean;
}

/**
 * The publisher handle for a model, for the org mark.
 *
 * The catalogue's own ids are bare names ("qwen3.5-9b"), so the handle has to
 * come from the HF REPO the entry names — the same derivation the model hub
 * uses (`hfRepo.split('/')[0]`), so the two surfaces cannot show different
 * logos for the same model. A discovered model whose id is already `org/name`
 * carries it directly.
 *
 * Returns '' when nothing names a publisher. Guessing one from the model NAME
 * would put the wrong logo beside it, which is worse than no logo: "qwen3.5"
 * from an unaffiliated repacker is not Qwen's.
 */
export function orgOf(id: string, hfRepo?: string): string {
  if (hfRepo?.includes('/') === true) {
    return (hfRepo.split('/')[0] ?? '').toLowerCase();
  }
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash).toLowerCase() : '';
}

/**
 * Everything on disk, largest first.
 *
 * Ties break on name so the list cannot reorder itself between renders — two
 * models of identical size are otherwise at the mercy of sort stability.
 */
export function downloadedBySize(models: readonly MenuModel[]): MenuModel[] {
  return models
    .filter((m) => m.downloaded)
    .sort((a, b) => b.bytes - a.bytes || a.displayName.localeCompare(b.displayName));
}

/**
 * Filter the list by what the user typed.
 *
 * Matches the display name AND the org, because "qwen" is how people look for a
 * model whose display name is "Qwen3 8B" and "google" is how they look for
 * Gemma. Case-insensitive; whitespace-only is not a filter.
 */
export function filterModels(models: readonly MenuModel[], query: string): MenuModel[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...models];
  return models.filter(
    (m) =>
      m.displayName.toLowerCase().includes(q) ||
      m.org.includes(q) ||
      m.id.toLowerCase().includes(q),
  );
}

/** Add or remove a favourite, keeping the user's order. */
export function toggleFavourite(config: QuickMenuConfig, modelId: string): QuickMenuConfig {
  const has = config.favourites.includes(modelId);
  return {
    ...config,
    favourites: has
      ? config.favourites.filter((id) => id !== modelId)
      : [...config.favourites, modelId],
  };
}

/** Rename a slot. The binding is untouched — see the file docstring. */
export function renameSlot(
  config: QuickMenuConfig,
  slotId: string,
  label: string,
): QuickMenuConfig {
  const trimmed = label.trim();
  if (trimmed === '') return config;
  return {
    ...config,
    slots: config.slots.map((s) => (s.id === slotId ? { ...s, label: trimmed } : s)),
  };
}

/** Point a slot at a specific model, or back at the app's own choice. */
export function bindSlot(
  config: QuickMenuConfig,
  slotId: string,
  modelId: string | null,
): QuickMenuConfig {
  return {
    ...config,
    slots: config.slots.map((s) => (s.id === slotId ? { ...s, modelId } : s)),
  };
}

/**
 * Add a slot. Its id is derived from the label but kept unique, because ids are
 * what selections persist against and a duplicate would silently retarget one.
 */
export function addSlot(
  config: QuickMenuConfig,
  label: string,
  modelId: string | null,
): QuickMenuConfig {
  const trimmed = label.trim();
  if (trimmed === '') return config;
  const base =
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'slot';
  let id = base;
  for (let n = 2; config.slots.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return { ...config, slots: [...config.slots, { id, label: trimmed, modelId }] };
}

/**
 * Remove a slot. The three defaults can be renamed and rebound but not deleted:
 * a menu with no capability tiers has no Auto behaviour left to describe, and
 * getting back from that state would mean a reset button for a mistake that is
 * one click away.
 */
export function removeSlot(config: QuickMenuConfig, slotId: string): QuickMenuConfig {
  if (DEFAULT_SLOTS.some((s) => s.id === slotId)) return config;
  return { ...config, slots: config.slots.filter((s) => s.id !== slotId) };
}

/** A row the menu draws, in order. */
export interface QuickMenuRow {
  readonly kind: 'favourite' | 'slot';
  readonly key: string;
  readonly label: string;
  /** Grey second line — the model behind the row, when it is known. */
  readonly secondary: string | null;
  readonly modelId: string | null;
  readonly org: string;
  readonly downloaded: boolean;
  readonly bytes: number;
  readonly tier?: ModelSelectionTier;
}

/**
 * The menu, assembled: favourites first in the user's order, then the slots.
 *
 * A favourite whose model is no longer on disk is DROPPED rather than shown
 * greyed — it was pinned because it was useful, and a menu that lists things
 * that cannot run teaches people to distrust it. It stays in the config, so
 * re-downloading brings it back where it was.
 */
export function quickMenuRows(
  config: QuickMenuConfig,
  models: readonly MenuModel[],
  tierPicks: Partial<Record<string, { displayName: string; downloaded: boolean; bytes: number }>>,
): QuickMenuRow[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const rows: QuickMenuRow[] = [];

  for (const id of config.favourites) {
    const model = byId.get(id);
    if (model === undefined || !model.downloaded) continue;
    rows.push({
      kind: 'favourite',
      key: `fav:${id}`,
      label: model.displayName,
      secondary: null,
      modelId: id,
      org: model.org,
      downloaded: true,
      bytes: model.bytes,
    });
  }

  for (const slot of config.slots) {
    const pinned = slot.modelId === null ? undefined : byId.get(slot.modelId);
    const auto = slot.tier === undefined ? undefined : tierPicks[slot.tier];
    const name = pinned?.displayName ?? auto?.displayName ?? null;
    rows.push({
      kind: 'slot',
      key: `slot:${slot.id}`,
      label: slot.label,
      // The label is the user's word for it; the model name is the truth
      // underneath, which is why both are shown rather than one replacing the
      // other.
      secondary: name,
      modelId: slot.modelId,
      org: pinned?.org ?? '',
      downloaded: pinned?.downloaded ?? auto?.downloaded ?? false,
      bytes: pinned?.bytes ?? auto?.bytes ?? 0,
      ...(slot.tier === undefined ? {} : { tier: slot.tier }),
    });
  }

  return rows;
}
