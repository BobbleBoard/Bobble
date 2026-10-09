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
 * The fallback verdict for a card whose file sizes are not known yet — several
 * catalog entries carry `bytes: 0` until their live ladder is fetched.
 *
 * SAME THREE WORDS as {@link quantFit} on purpose. They used to be "Fits
 * comfortably" / "Tight fit" / "Needs more RAM", and with the measured verdict
 * shipping beside them the manager showed two vocabularies at once — a card
 * reading "Tight fit" next to one reading "Tight — will swap" looks like two
 * different states rather than one state known two ways. Seen on screen, not in
 * a test.
 *
 * The DETAIL is where they differ, and it says so plainly: this one is the
 * model's hand-set minimum, not an estimate of the file you picked. Prefer
 * {@link quantFit} wherever a size is known — this cannot tell Q2 from Q8.
 */
export function ramVerdict(minRamGB: number, totalRamGB: number): RamVerdict {
  if (totalRamGB <= 0) return { tone: 'default', label: `${minRamGB} GB RAM`, fits: true };
  const detail = `this model states ${minRamGB} GB minimum; no file size known yet`;
  if (totalRamGB < minRamGB) return { tone: 'danger', label: "Won't fit", fits: false, detail };
  if (totalRamGB - minRamGB < 4) {
    return { tone: 'warning', label: 'Tight, will swap', fits: true, detail };
  }
  return { tone: 'success', label: 'Fits', fits: true, detail };
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
 * The user: "it says things will fit I think without taking into account OS overhead
 * or unified memory or anything".
 *
 * The user is right, and in a worse way than the wording suggests: the badge was
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
    return { tone: 'default', label: formatBytes(modelBytes), fits: true };
  }
  /*
   * The context the app would really launch with — not the model's advertised
   * maximum. Asking "does 27B at its full context fit" answers a question the
   * app never asks; `chooseContextCap` steps the window down until it does.
   */
  const budgetGB = totalRamGB * DEFAULT_MEMORY_FRACTION;
  const ctx = Math.min(CONTEXT_CEILING, modelMaxContext > 0 ? modelMaxContext : CONTEXT_CEILING);
  /*
   * THE VERDICT IS ABOUT THE DEFAULT LAUNCH, WHICH IS TEXT-ONLY.
   *
   * The projector is downloaded with the weights but only LOADED on a
   * multimodal launch, which is an explicit opt-in restart. Charging every
   * model for it judges a cost most sessions never pay — and it changed the
   * answer, not just the number: on a 24 GB Mac it pushed the 27B's
   * UD-Q3_K_XL out of green and handed the recommendation to a plain Q3_K_S
   * that is a worse model at the same size. Caught by reading the real
   * dropdown, where two "Tight" rows sat above five "Fits" rows.
   *
   * So the projector is not in the verdict. It IS in the detail, because
   * turning vision on later is a real cliff and the number should be visible
   * before someone walks off it.
   */
  const needGB = estimateLaunchRamGB(modelBytes, ctx);
  const withVisionGB = mmprojBytes > 0 ? estimateLaunchRamGB(modelBytes + mmprojBytes, ctx) : null;
  /*
   * SHOW THE WHOLE SUM, IN ONE UNIT.
   *
   * The card quotes file sizes base-1000 ("13 GB", matching HuggingFace and
   * every download UI) while every memory figure here is base-1024 — so a bare
   * "13 GB model needs ≈18.5 GB" looks like 5.5 GB of unexplained overhead, and
   * the two numbers labelled GB are not even the same GB. (Unsloth Desktop has
   * exactly this split too; theirs is unexplained.) Breaking the estimate into
   * its terms makes the arithmetic add up on screen, all in GiB.
   *
   * The parts are DERIVED from the total rather than recomputed, so they cannot
   * drift from `estimateLaunchRamGB` if its formula changes.
   */
  const weightsGB = modelBytes / 1024 ** 3;
  const runtimeGB = 1;
  const contextGB = Math.max(0, needGB - weightsGB - runtimeGB);
  const detail =
    `${weightsGB.toFixed(1)} weights + ${contextGB.toFixed(1)} context + ${runtimeGB.toFixed(1)} ` +
    `runtime ≈ ${needGB.toFixed(1)} GB of ${totalRamGB} GB, at a ${Math.round(ctx / 1024)}k window` +
    (withVisionGB !== null ? ` (≈${withVisionGB.toFixed(1)} GB with vision on)` : '');
  if (needGB <= budgetGB) return { tone: 'success', label: 'Fits', fits: true, detail };
  if (needGB <= totalRamGB) {
    return { tone: 'warning', label: 'Tight, will swap', fits: true, detail };
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
 * How much quality a quant carries per byte, relative to a plain one.
 *
 * Unsloth Dynamic (`UD-`) quants keep the layers that matter at higher
 * precision, so they beat a same-sized plain quant — that is the entire reason
 * they exist, and Unsloth's own `GGUF_QUANT_PREFERENCE` puts all sixteen UD
 * entries above every plain quant unconditionally.
 *
 * MEASURED on the real 27B card: strict size-descending picked `Q3_K_M`
 * (13.82 GB) over `UD-Q3_K_XL` (13.44 GB) — 0.4 GB of extra file bought at the
 * cost of the better quantisation. Weighting UD by 1.05 makes the ordering
 * express "bigger is better, and dynamic is worth a little size", which is what
 * a person choosing here actually believes. It is a modelling assumption, so it
 * is written down as one rather than buried in a comparator.
 */
const UD_QUALITY_BONUS = 1.05;
function qualityWeightedBytes(option: QuantOption): number {
  return /(^|[^A-Z])UD-/i.test(option.quant) ? option.bytes * UD_QUALITY_BONUS : option.bytes;
}

/**
 * Order the quant list so ROW 0 IS THE RECOMMENDATION.
 *
 * The user, describing what the user liked in Unsloth Desktop: "they have a default
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
    /* Inside the won't-fit group the question is "how close was it", which is
       about real bytes, not quality. Everywhere else, best-first. */
    if (fa === 3) return a.bytes - b.bytes;
    return qualityWeightedBytes(b) - qualityWeightedBytes(a);
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
  if (bytes <= 0) return '';
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

/*
 * The reliable-publisher allowlist used to be COPIED here, with a comment
 * explaining that the package barrel could not be imported into the renderer
 * because it re-exports the node-only supervisor and downloader. True, but the
 * fix for that is a subpath export, not a second copy: `catalog.ts` has no
 * imports at all, so `@pi-desktop/inference/catalog` is safe in the bundle.
 *
 * Two hand-synced lists is a bug waiting for someone to add an org to one of
 * them — which is exactly what happened when the hub's Recommended filter
 * needed the first-party labs.
 */
export { isReliablePublisher, RELIABLE_PUBLISHERS } from '@pi-desktop/inference/catalog';

// ---------------------------------------------------------------------------
// De-duplicated model grouping — model → variant → quant (round-12 #1, #3)
// ---------------------------------------------------------------------------

/** Speculative-decoding speed method (mirror of the catalog `SpecMethod`). */
export type SpecMethod = 'mtp' | 'eagle3' | 'dflash' | 'dspark';

/** Order the variant dropdown offers methods in: [MTP / DFlash / DSpark / EAGLE-3]. */
export const VARIANT_ORDER: readonly SpecMethod[] = ['mtp', 'dflash', 'dspark', 'eagle3'];

/** Human label per speed method. */
export const VARIANT_LABEL: Record<SpecMethod, string> = {
  mtp: 'MTP',
  dflash: 'DFlash',
  dspark: 'DSpark',
  eagle3: 'EAGLE-3',
};

/** Trailing "(MTP)" / "(EAGLE-3)" / "(DFlash)" / "(DSpark)" suffix on a display name. */
const VARIANT_SUFFIX_RE = /\s*\((?:MTP|EAGLE-?3|DFlash|DSpark)\)\s*$/i;

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

/** An importance-matrix file: calibration data a quantizer used, not a model. */
const IMATRIX_RE = /imatrix/i;

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
 * The user: "sort ggufs instead of alphabetically which as you can see might put all
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
  fetched?: ReadonlyArray<{
    quant?: string;
    sizeBytes?: number;
    mmproj?: boolean;
    mtp?: boolean;
  }>,
): QuantOption[] {
  const map = new Map<string, QuantOption>();
  for (const q of base) map.set(q.quant, { quant: q.quant, bytes: q.bytes });
  /*
   * SHARDS ARE ONE MODEL, SO THEIR BYTES ADD UP.
   *
   * CAUGHT BY DRIVING THE REAL CARD, not by any unit test: the 27B's dropdown
   * offered "BF16 · 4.7 GB · Fits" on a 24 GB Mac. `unsloth/Qwen3.8-27B-GGUF`
   * ships BF16 as two shards — 49.99 GB and 4.67 GB — and `parseQuant` strips
   * the `-00001-of-00002` suffix, so both landed on the label "BF16" and the
   * later one WON. A 54.7 GB model was advertised as 4.7 GB and green.
   *
   * Two files in one repo that reduce to the same quant label are shards of one
   * model; there is no other way for that to happen. Summing them is both the
   * correct size and the correct verdict, and it is what Unsloth Desktop does
   * (`gguf.py` sums per shard family). Fetched sizes replace a catalog entry the
   * FIRST time and accumulate after, so a single-file quant is unaffected.
   */
  const fromFetch = new Set<string>();
  for (const f of fetched ?? []) {
    if (f.quant === undefined || f.quant.length === 0) continue;
    /*
     * A PROJECTOR IS NOT A QUANT. The user: "lists mmproj's separately I think, as if
     * it's its own standalone model". `mmproj-F16.gguf` parses to the quant label
     * "F16", so a vision repo grew a phantom 0.9 GB option that loads nothing on
     * its own. Callers filter it today; the shared helper should not depend on
     * every caller remembering to.
     */
    if (f.mmproj === true) continue;
    /*
     * NOR IS A SPEED HEAD, NOR AN IMATRIX. The same 27B repo ships
     * `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` (a 1.4 GB draft head that loads beside
     * the weights) and `imatrix_unsloth.gguf` (calibration data). Listed row for
     * row they became a second "Q4_0" at 1.3 GB and a 13 MB "imatrix_unsloth",
     * both green and neither a model you can run.
     */
    if (f.mtp === true || IMATRIX_RE.test(f.quant)) continue;
    const bytes = f.sizeBytes ?? 0;
    const prior = fromFetch.has(f.quant) ? (map.get(f.quant)?.bytes ?? 0) : 0;
    fromFetch.add(f.quant);
    map.set(f.quant, {
      quant: f.quant,
      bytes: bytes > 0 || prior > 0 ? prior + bytes : (map.get(f.quant)?.bytes ?? 0),
    });
  }
  return [...map.values()].sort(
    (a, b) =>
      a.bytes - b.bytes ||
      quantRank(a.quant) - quantRank(b.quant) ||
      a.quant.localeCompare(b.quant),
  );
}
