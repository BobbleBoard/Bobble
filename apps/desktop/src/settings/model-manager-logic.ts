/**
 * Pure presentation logic for the Model Manager — kept React-free so the
 * RAM-fit verdict, size/speed formatting, and quant selection are unit-testable
 * and can't drift silently.
 */
import {
  CONTEXT_CEILING,
  DEFAULT_MEMORY_FRACTION,
  estimateLaunchRamGB,
} from '@pi-desktop/inference/context-cap';
import type { LlmCatalogEntry } from '../../electron/ipc-contract';

export type RamTone = 'success' | 'warning' | 'danger' | 'default';

export interface RamVerdict {
  tone: RamTone;
  label: string;
  /** Whether the machine meets the model's minimum RAM. */
  fits: boolean;
  /** What the verdict actually weighed, for the tooltip/subtitle. Absent on the
   * legacy catalog-minimum path, which has nothing to show its working from. */
  detail?: string;
}

/**
 * Green/ok/insufficient verdict comparing a model's minimum RAM against
 * detected RAM. Unknown RAM (0, e.g. non-macOS detect) yields a neutral badge
 * that just states the requirement rather than guessing a fit.
 *
 * Prefer {@link quantFit} wherever the SELECTED quant is known — this compares a
 * whole model group's hand-set catalog minimum and cannot tell Q2 from Q8.
 */
export function ramVerdict(minRamGB: number, totalRamGB: number): RamVerdict {
  if (totalRamGB <= 0) return { tone: 'default', label: `${minRamGB} GB RAM`, fits: true };
  if (totalRamGB < minRamGB) return { tone: 'danger', label: 'Needs more RAM', fits: false };
  if (totalRamGB - minRamGB < 4) return { tone: 'warning', label: 'Tight fit', fits: true };
  return { tone: 'success', label: 'Fits comfortably', fits: true };
}

export interface QuantFitInput {
  /** Bytes of the GGUF actually selected in the dropdown. */
  readonly modelBytes: number;
  /** Bytes of the vision projector, when it is loaded alongside the weights. */
  readonly mmprojBytes?: number;
  /** The model's own maximum context; the launch cap is derived from it. */
  readonly modelMaxContext?: number;
  /** Detected unified/system RAM. 0 = unknown. */
  readonly totalRamGB: number;
}

/**
 * Will THIS quant actually run on THIS machine?
 *
 * the user: "it says things will fit I think without taking into account OS overhead
 * or unified memory or anything".
 *
 * He is right, and in a worse way than the wording suggests: the badge was
 * {@link ramVerdict}(group.primary.minRamGB, totalRam) — a hand-set constant for
 * the whole MODEL, compared against the machine's TOTAL RAM. Two consequences:
 *
 *  1. It did not move when you changed the quant. The size next to it did. So a
 *     card could read "31 GB · Fits comfortably" on a 24 GB Mac, because 31 GB is
 *     the file you picked and "fits comfortably" is about a different number.
 *  2. Weights are not the footprint. The KV cache alone is ~20% of the weights
 *     per 32k of context, and on unified memory it comes out of the same pool as
 *     the OS, the compositor and this Electron app.
 *
 * So this asks the question the launcher will actually face, using the estimator
 * the launcher itself uses — {@link estimateLaunchRamGB}, already calibrated
 * against the catalog's hand-set minimums — at the context the app would really
 * pick, plus the projector when vision is on. `DEFAULT_MEMORY_FRACTION` (0.8) is
 * the OS/other-apps headroom; between that and total RAM is the band where it
 * loads and then swaps, which is a real state and deserves its own colour.
 *
 * The label shows its working. "Fits comfortably" is a claim; "16 GB of 24 GB"
 * is a number the user can disagree with.
 */
export function quantFit(input: QuantFitInput): RamVerdict {
  const { modelBytes, mmprojBytes = 0, modelMaxContext = CONTEXT_CEILING, totalRamGB } = input;
  if (totalRamGB <= 0 || modelBytes <= 0) {
    return { tone: 'default', label: formatBytes(modelBytes + mmprojBytes), fits: true };
  }
  /*
   * The context the app would really launch with — not the model's advertised
   * maximum. Asking "does 27B at its full context fit" answers a question the
   * app never asks; `chooseContextCap` steps the window down until it does.
   */
  const budgetGB = totalRamGB * DEFAULT_MEMORY_FRACTION;
  const ctx = Math.min(CONTEXT_CEILING, modelMaxContext > 0 ? modelMaxContext : CONTEXT_CEILING);
  const needGB = estimateLaunchRamGB(modelBytes + mmprojBytes, ctx);
  const detail = `≈${needGB.toFixed(1)} GB of ${totalRamGB} GB with a ${Math.round(ctx / 1024)}k context`;
  if (needGB <= budgetGB) return { tone: 'success', label: 'Fits', fits: true, detail };
  if (needGB <= totalRamGB) {
    return { tone: 'warning', label: 'Tight — will swap', fits: true, detail };
  }
  return { tone: 'danger', label: "Won't fit", fits: false, detail };
}

/**
 * Can this MODEL run here at all — i.e. is ANY of its quants green?
 *
 * The card-level question, as opposed to {@link quantFit}'s row-level one. A
 * model is only genuinely out of reach when even its smallest quant will not
 * load, so this asks about the smallest rather than the default. Unknown
 * hardware (`totalRamGB` 0) passes everything: a machine we could not measure is
 * not grounds for hiding the catalog.
 */
export function groupFits(
  group: Pick<ModelGroup, 'entries'>,
  hardware: { totalRamGB: number } | null,
): boolean {
  if (hardware === null || hardware.totalRamGB <= 0) return true;
  for (const entry of group.entries) {
    for (const q of entry.quants) {
      if (q.bytes <= 0) return true; // unknown size — do not hide on a guess
      const verdict = quantFit({
        modelBytes: q.bytes,
        modelMaxContext: entry.contextWindow,
        totalRamGB: hardware.totalRamGB,
      });
      if (verdict.fits) return true;
    }
  }
  return false;
}

/** Rank for the display sort: already yours, then usable, then not. */
function fitRank(tone: RamTone): number {
  if (tone === 'success') return 0;
  if (tone === 'warning') return 1;
  if (tone === 'default') return 2;
  return 3;
}

/**
 * Order the quant list so ROW 0 IS THE RECOMMENDATION.
 *
 * the user, describing what he liked in Unsloth Desktop: "they have a default
 * selection, the dropdown is clickable and then the download button, if you
 * press it immediately will do the recommended (which was already initially
 * selected)".
 *
 * The neat part of that design, which their source confirms
 * (`hub/lib/gguf-variant-sort.ts`), is that there is no separate "recommend"
 * step to keep in sync with the list — the preselection is just the first row.
 * So the ordering has to carry the whole opinion, in three keys:
 *
 *  1. What you already have — a downloaded quant beats re-downloading a better one.
 *  2. Whether it fits — green, then tight, then unknown, then won't.
 *  3. Size DESCENDING inside the fitting groups, because quality rises with
 *     quant size and the best usable option is the biggest one that still fits.
 *     Inside the won't-fit group it flips to ascending: if you are going to
 *     scroll into the red, the near-misses are the interesting end.
 *
 * (Note the direction. "Order by file size" read literally means ascending, which
 * would put the WORST quant first and make Download-without-thinking pick Q2.)
 */
export function orderQuantsForDisplay(
  options: readonly QuantOption[],
  fit: Omit<QuantFitInput, 'modelBytes'>,
  isDownloaded: (quant: string) => boolean = () => false,
): QuantOption[] {
  const rank = new Map<string, number>();
  for (const option of options) {
    rank.set(option.quant, fitRank(quantFit({ ...fit, modelBytes: option.bytes }).tone));
  }
  return [...options].sort((a, b) => {
    const own = Number(isDownloaded(b.quant)) - Number(isDownloaded(a.quant));
    if (own !== 0) return own;
    const fa = rank.get(a.quant) ?? 3;
    const fb = rank.get(b.quant) ?? 3;
    if (fa !== fb) return fa - fb;
    return fa === 3 ? a.bytes - b.bytes : b.bytes - a.bytes;
  });
}

/**
 * The quant to preselect — by construction, the first row of
 * {@link orderQuantsForDisplay}, so the dropdown's default and the list's top
 * can never disagree.
 */
export function recommendedQuant(
  options: readonly QuantOption[],
  fit: Omit<QuantFitInput, 'modelBytes'>,
  isDownloaded?: (quant: string) => boolean,
): QuantOption | undefined {
  return orderQuantsForDisplay(options, fit, isDownloaded)[0];
}

/** Human byte size (binary-ish, matches how model files are quoted). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1e6;
  return `${mb.toFixed(0)} MB`;
}

/** Transfer rate, e.g. "12.4 MB/s"; null/zero → empty so the UI can omit it. */
export function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / 1e6;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSec / 1e3;
  return `${kb.toFixed(0)} KB/s`;
}

/** 0..1 fraction → integer percent, clamped; null → null (indeterminate). */
export function percent(fraction: number | null): number | null {
  if (fraction === null) return null;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** The quant to size/act on: the named one, else the first (smallest listed). */
export function selectedQuant(
  entry: Pick<LlmCatalogEntry, 'quants'>,
  quant?: string,
): { quant: string; bytes: number } | undefined {
  if (quant !== undefined) {
    const match = entry.quants.find((q) => q.quant === quant);
    if (match !== undefined) return match;
  }
  return entry.quants[0];
}

/** The size shown on a card: downloaded → the on-disk quant, else the default. */
export function displaySizeBytes(entry: LlmCatalogEntry, quant?: string): number {
  return selectedQuant(entry, quant)?.bytes ?? 0;
}

// ---------------------------------------------------------------------------
// Reliable-publisher labelling (round-12 #2)
// ---------------------------------------------------------------------------

/**
 * Reliable-publisher allowlist — a renderer-side MIRROR of
 * `@pi-desktop/inference`'s catalog `RELIABLE_PUBLISHERS` (kept in sync with
 * keystone). We can't import the package barrel into the renderer bundle (it
 * re-exports the node-only supervisor/downloader), so curated cards read the
 * flag the contract already carries (`entry.publisher.reliable`) and this list
 * powers the Browse-HF author check, where no flag is wired. NOTE: community
 * re-quanters (e.g. `mradermacher`) are deliberately NOT reliable.
 */
export const RELIABLE_PUBLISHERS: readonly string[] = [
  'unsloth',
  'bartowski',
  'ggml-org',
  'nvidia',
  'Qwen',
  'google',
  'deepmind',
  'mlx-community',
  'lmstudio-community',
];

/** Whether an HF publisher handle is in the reliable allowlist (exact match,
 * matching keystone's `isReliablePublisher`). */
export function isReliablePublisher(handle: string): boolean {
  return RELIABLE_PUBLISHERS.includes(handle);
}

// ---------------------------------------------------------------------------
// De-duplicated model grouping — model → variant → quant (round-12 #1, #3)
// ---------------------------------------------------------------------------

/** Speculative-decoding speed method (mirror of the catalog `SpecMethod`). */
export type SpecMethod = 'mtp' | 'eagle3' | 'dflash';

/** Order the variant dropdown offers methods in: [MTP / DFlash / EAGLE-3]. */
export const VARIANT_ORDER: readonly SpecMethod[] = ['mtp', 'dflash', 'eagle3'];

/** Human label per speed method. */
export const VARIANT_LABEL: Record<SpecMethod, string> = {
  mtp: 'MTP',
  dflash: 'DFlash',
  eagle3: 'EAGLE-3',
};

/** Trailing "(MTP)" / "(EAGLE-3)" / "(DFlash)" suffix on a display name. */
const VARIANT_SUFFIX_RE = /\s*\((?:MTP|EAGLE-?3|DFlash)\)\s*$/i;

/** A model size token, e.g. `E2B`, `12B`, `0.8B`, `26B-A4B`, `30B-A3B`. */
const SIZE_TOKEN_RE = /^E?\d+(?:\.\d+)?B(?:-A\d+B)?$/i;

/** The de-duplication key: a display name stripped of its speed-variant suffix,
 * so "Qwen3.6 27B (MTP)" and "Qwen3.6 27B (EAGLE-3)" collapse to one model. */
export function baseModelName(displayName: string): string {
  return displayName.replace(VARIANT_SUFFIX_RE, '').trim();
}

/** The model FAMILY label (everything before the size token), for the
 * power-user categorized view — e.g. "Gemma 4 12B Instruct" → "Gemma 4",
 * "Qwen3.6 27B (MTP)" → "Qwen3.6", "NVIDIA Nemotron-3 Nano 30B-A3B" →
 * "NVIDIA Nemotron-3 Nano". */
export function modelFamily(displayName: string): string {
  const base = baseModelName(displayName);
  const tokens = base.split(/\s+/);
  const idx = tokens.findIndex((t) => SIZE_TOKEN_RE.test(t));
  if (idx <= 0) return base;
  return tokens.slice(0, idx).join(' ');
}

/** One speed variant option on a grouped card — a method plus the CONCRETE
 * catalog entry (repo) its Download/Start resolves to. */
export interface VariantOption {
  method: SpecMethod;
  label: string;
  /** The catalog entry id to download/start when this variant is selected. */
  entryId: string;
  /** Separate draft-GGUF repo (EAGLE-3 / DFlash), surfaced in Advanced. */
  draftRepo?: string;
  /** True when the head is embedded in the main GGUF (no separate draft). */
  embedded?: boolean;
}

/** One de-duplicated model: a single card that fans out to its variants (repos)
 * and quants. */
export interface ModelGroup {
  /** De-dup key = base display name. */
  key: string;
  /** Base display name (no variant suffix) shown on the card. */
  displayName: string;
  /** Family label for the categorized view. */
  family: string;
  /** Every catalog entry that collapsed into this model. */
  entries: LlmCatalogEntry[];
  /** The representative entry (badges / RAM / publisher / tier / size). */
  primary: LlmCatalogEntry;
  /** Available speed variants (deduped union, in {@link VARIANT_ORDER}). */
  variants: VariantOption[];
  /** Min system RAM (from the primary) — the size-sort key. */
  minRamGB: number;
}

/** Pick a group's representative entry: prefer the simple MTP/embedded default,
 * else the smallest by RAM. (A group is never empty, so `reduce` without a seed
 * always returns an entry.) */
function pickPrimary(entries: readonly LlmCatalogEntry[]): LlmCatalogEntry {
  return entries.reduce((best, e) => {
    const bestIsMtp = best.spec === 'mtp' || best.mtp;
    const eIsMtp = e.spec === 'mtp' || e.mtp;
    if (eIsMtp !== bestIsMtp) return eIsMtp ? e : best;
    return e.minRamGB < best.minRamGB ? e : best;
  });
}

/** Build the deduped variant option list for a group's entries. For each method
 * (in dropdown order) the option resolves to the entry that best provides it:
 * an entry whose DEFAULT spec is that method (its dedicated repo), else the
 * first entry that lists it among its `variants`. */
function buildVariants(entries: readonly LlmCatalogEntry[]): VariantOption[] {
  const options: VariantOption[] = [];
  for (const method of VARIANT_ORDER) {
    const dedicated = entries.find((e) => e.spec === method);
    const lister = entries.find((e) => e.variants?.some((v) => v.method === method));
    const entry = dedicated ?? lister;
    if (entry === undefined) continue;
    const v = entry.variants?.find((x) => x.method === method);
    options.push({
      method,
      label: VARIANT_LABEL[method],
      entryId: entry.id,
      draftRepo: v?.draftRepo,
      embedded: v?.embedded,
    });
  }
  // Defensive: a text-only / no-variants entry still gets its default spec as an
  // option so the card can render (and resolve) something.
  const first = entries[0];
  if (options.length === 0 && first !== undefined && first.spec !== undefined) {
    options.push({ method: first.spec, label: VARIANT_LABEL[first.spec], entryId: first.id });
  }
  return options;
}

/** Collapse catalog entries into de-duplicated model groups (one card each). */
export function groupCatalog(entries: readonly LlmCatalogEntry[]): ModelGroup[] {
  const byKey = new Map<string, LlmCatalogEntry[]>();
  for (const entry of entries) {
    const key = baseModelName(entry.displayName);
    const arr = byKey.get(key);
    if (arr !== undefined) arr.push(entry);
    else byKey.set(key, [entry]);
  }
  const groups: ModelGroup[] = [];
  for (const [key, groupEntries] of byKey) {
    const primary = pickPrimary(groupEntries);
    groups.push({
      key,
      displayName: key,
      family: modelFamily(primary.displayName),
      entries: groupEntries,
      primary,
      variants: buildVariants(groupEntries),
      minRamGB: primary.minRamGB,
    });
  }
  return groups;
}

/** The default variant a group opens on: the primary's own spec when available,
 * else the first offered variant. */
export function defaultVariant(group: ModelGroup): SpecMethod {
  const spec = group.primary.spec;
  if (spec !== undefined && group.variants.some((v) => v.method === spec)) return spec;
  return group.variants[0]?.method ?? 'mtp';
}

/** Resolve a group + chosen variant method → the concrete catalog entry (repo)
 * its Download/Start acts on. */
export function variantEntry(group: ModelGroup, method: SpecMethod): LlmCatalogEntry {
  const opt = group.variants.find((v) => v.method === method);
  const id = opt?.entryId ?? group.primary.id;
  return group.entries.find((e) => e.id === id) ?? group.primary;
}

/** A family section for the categorized power-user view. */
export interface FamilySection {
  family: string;
  groups: ModelGroup[];
}

/** Categorize groups by model family, sorting models within a family by size
 * (RAM) and families by their smallest member — the power-user Recommended view. */
export function categorizeByFamily(groups: readonly ModelGroup[]): FamilySection[] {
  const byFamily = new Map<string, ModelGroup[]>();
  for (const group of groups) {
    const arr = byFamily.get(group.family);
    if (arr !== undefined) arr.push(group);
    else byFamily.set(group.family, [group]);
  }
  const sections: FamilySection[] = [];
  for (const [family, gs] of byFamily) {
    gs.sort((a, b) => a.minRamGB - b.minRamGB || a.displayName.localeCompare(b.displayName));
    sections.push({ family, groups: gs });
  }
  sections.sort(
    (a, b) =>
      (a.groups[0]?.minRamGB ?? 0) - (b.groups[0]?.minRamGB ?? 0) ||
      a.family.localeCompare(b.family),
  );
  return sections;
}

// ---------------------------------------------------------------------------
// Quant ladder — merge the entry's known quants with a live hf:list-files ladder
// ---------------------------------------------------------------------------

export interface QuantOption {
  quant: string;
  bytes: number;
}

/** Rough Q2…Q8 ordering key (UD-/IQ- prefixes keep their base digit). Only a
 * tie-break now, for ladders whose sizes we never learned. */
function quantRank(quant: string): number {
  const m = quant.match(/Q(\d)/i);
  return m !== null ? Number(m[1]) : 5;
}

/**
 * Merge a catalog entry's known quants (always present, offline) with a live
 * `hf:list-files` quant ladder (real Q2…Q8), deduped by quant label (live size
 * wins when known) and sorted SMALLEST FILE FIRST. Returns the base list
 * unchanged when no ladder was fetched, so the dropdown is deterministic without
 * the network.
 *
 * the user: "sort ggufs instead of alphabetically which as you can see might put all
 * the unsloth dynamics (labeled UD) below all the others, instead if we order by
 * file size".
 *
 * The old key was `quantRank` then `localeCompare`, which is alphabetical inside
 * a digit — so within Q4 you got IQ4_NL, Q4_0, Q4_1, Q4_K_M, Q4_K_S and then
 * UD-Q4_K_XL dead last, purely because "U" sorts after "Q". The one property a
 * user actually scans a quant list for — how big is it — was the one thing the
 * order did not encode. Bytes is also the only key that stays meaningful across
 * naming schemes nobody has invented yet.
 */
export function mergeQuantLadder(
  base: readonly QuantOption[],
  fetched?: ReadonlyArray<{ quant?: string; sizeBytes?: number; mmproj?: boolean }>,
): QuantOption[] {
  const map = new Map<string, QuantOption>();
  for (const q of base) map.set(q.quant, { quant: q.quant, bytes: q.bytes });
  for (const f of fetched ?? []) {
    if (f.quant === undefined || f.quant.length === 0) continue;
    /*
     * A PROJECTOR IS NOT A QUANT. the user: "lists mmproj's separately I think, as if
     * it's its own standalone model". `mmproj-F16.gguf` parses to the quant label
     * "F16", so a vision repo grew a phantom 0.9 GB option that loads nothing on
     * its own. Callers filter it today; the shared helper should not depend on
     * every caller remembering to.
     */
    if (f.mmproj === true) continue;
    const existing = map.get(f.quant);
    map.set(f.quant, { quant: f.quant, bytes: f.sizeBytes ?? existing?.bytes ?? 0 });
  }
  return [...map.values()].sort(
    (a, b) =>
      a.bytes - b.bytes ||
      quantRank(a.quant) - quantRank(b.quant) ||
      a.quant.localeCompare(b.quant),
  );
}
