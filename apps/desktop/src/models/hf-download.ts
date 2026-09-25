/**
 * WHICH FILE A HUGGING FACE DOWNLOAD FETCHES — decided once, here.
 *
 * A GGUF repo is a listing of files, and only some of them are models: beside
 * the weights sit a vision projector (`mmproj-*.gguf`), a speed head
 * (`MTP/mtp-*.gguf`), calibration data (`imatrix_*.gguf`), and quants split
 * across several files (`BF16/…-00001-of-00002.gguf`). The hub asks one
 * question of that listing in several places — the quant picker's rows, its
 * pinned "Recommended" row, the headline Download, Top Recommended, Quick
 * Download — and every one of them used to answer it differently. Driven on the
 * real 27B card (unsloth/Qwen3.8-27B-GGUF, 24 GB Mac), with the IPC refused in
 * main so nothing moved:
 *
 *   - the headline Download took the FIRST file of the listing, which is
 *     alphabetical: `BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf`, one 50 GB
 *     shard of a 54.7 GB model that cannot load here. The comment above it said
 *     "fall back to the ladder's best"; the code never asked the ladder.
 *   - picking "Q4_0" registered `MTP/mtp-Qwen3.8-27B-Q4_0.gguf`, the 1.4 GB
 *     draft head, because it sorts before the 16 GB model of the same label.
 *   - picking BF16 registered its first shard alone, which cannot run.
 *
 * So the ladder, the recommendation and the label → file lookup are one pure
 * function of the listing. The picker ranks {@link hfLadder}'s options with
 * `recommendedQuant`, and {@link pickHfDownload} runs the SAME call on the SAME
 * options, so a Download pressed without opening the picker fetches the row the
 * picker pins — by construction, not by two pieces of code agreeing.
 */
import type { HfGgufFileDTO, LlmCatalogEntry } from '../../electron/ipc-contract';
import {
  mergeQuantLadder,
  type QuantFitInput,
  type QuantOption,
  recommendedQuant,
} from '../settings/model-manager-logic';

/**
 * A readable name for one downloadable file.
 *
 * HF only sometimes reports a `quant`; the rest of the time the picker fell back
 * to the whole filename, so the row read
 * "zimageuncensoredtextencoderV10_v10.gguf" instead of "Q4_K_M". Pull the quant
 * out of the filename where it is there — it almost always is, that being the
 * convention — and only then fall back to the stem.
 */
export function quantLabel(quant: string | undefined, filePath: string): string {
  // Do NOT trust `quant` blindly: the supervisor falls back to the filename
  // when it cannot parse one, so a naive check shows the whole ".gguf" path.
  const looksParsed =
    quant !== undefined &&
    quant.length > 0 &&
    quant.length < 24 &&
    !quant.toLowerCase().endsWith('.gguf');
  if (looksParsed) return quant;
  const file = (quant ?? filePath).split('/').pop() ?? filePath;
  const stem = file.replace(/\.gguf$/i, '');
  // UD-Q4_K_XL / IQ3_M / Q8_0 / BF16 / F16 — the shapes that actually appear.
  const m = /((?:UD-)?(?:IQ|Q)\d[A-Z0-9_]*|BF16|F16|F32)/i.exec(stem);
  return m?.[1] ?? stem;
}

/** `…-00001-of-00002.gguf`: one part of a model published across several files. */
const SPLIT_PART_RE = /-\d{5}-of-\d{5}\.gguf$/i;
/** Calibration data a quantizer used — never a model (mergeQuantLadder agrees). */
const IMATRIX_RE = /imatrix/i;

/** A file that could be the weights themselves: not a projector, head or imatrix. */
function isWeights(f: HfGgufFileDTO): boolean {
  return (
    f.mmproj !== true &&
    f.mtp !== true &&
    !IMATRIX_RE.test(f.path) &&
    !IMATRIX_RE.test(quantLabel(f.quant, f.path))
  );
}

/** What one repo's listing offers to download. */
export interface HfLadder {
  /** One row per model a Download can fetch, smallest first — the picker's rows. */
  readonly options: QuantOption[];
  /** The projector that loads beside the weights, when the repo ships one. */
  readonly mmproj?: HfGgufFileDTO;
  /**
   * Quants published as SEVERAL files, by label, with how many.
   *
   * NOT OFFERED, because they cannot be fetched yet: `hf:register` takes one
   * file, so only the first shard would download, and the supervisor refuses to
   * start a model whose shards are missing (its `sharded` guard). Listing a row
   * whose Download can only fail is the trap this module exists to remove, and
   * leaving it in the ladder also let it WIN the recommendation on any machine
   * big enough to hold it — the 27B's BF16 is the largest file in its repo.
   */
  readonly split: ReadonlyMap<string, number>;
}

/**
 * The ladder a listing offers: one row per model a Download can fetch. The files
 * that are not models are dropped by mergeQuantLadder's rules, and a quant split
 * across files is left out whole (see {@link HfLadder.split}).
 */
export function hfLadder(files: readonly HfGgufFileDTO[]): HfLadder {
  const perLabel = new Map<string, HfGgufFileDTO[]>();
  for (const f of files) {
    if (!isWeights(f)) continue;
    const label = quantLabel(f.quant, f.path);
    perLabel.set(label, [...(perLabel.get(label) ?? []), f]);
  }
  /* Two files that reduce to one label are one model in parts — the rule
     mergeQuantLadder sums by — and so is a lone file named as a part. */
  const split = new Map<string, number>();
  for (const [label, group] of perLabel) {
    if (group.length > 1 || group.some((f) => SPLIT_PART_RE.test(f.path))) {
      split.set(label, group.length);
    }
  }
  const options = mergeQuantLadder(
    [],
    files.map((f) => ({
      quant: quantLabel(f.quant, f.path),
      sizeBytes: f.sizeBytes,
      mmproj: f.mmproj,
      mtp: f.mtp,
    })),
  ).filter((q) => q.bytes > 0 && !split.has(q.quant));
  const mmproj = files.find((f) => f.mmproj === true);
  return mmproj === undefined ? { options, split } : { options, mmproj, split };
}

/** What {@link quantsOnDisk} reads from a catalog entry. */
export type OnDiskEntry = Pick<
  LlmCatalogEntry,
  'hfRepo' | 'downloaded' | 'downloadedQuants' | 'quants' | 'source'
>;

/**
 * Which quants of a REPO are on disk, under any catalog entry.
 *
 * A Recommended pick and a Hub search hit are cards for a repo. The files are
 * held by catalog ENTRIES, with ids of their own: the curated one
 * (`qwen3.8-27b-mtp`), or one `hf:register` made for a single file
 * (`unsloth-qwen3-8-27b-gguf-ud-q3-k-xl`). Those cards read
 * `downloadedQuants` off themselves, and neither kind of card carries it. So a
 * file already here was offered as a Download (which registered a second entry
 * to fetch it again) and never became the pick.
 *
 * So the answer comes from every entry with that `hfRepo` that is downloaded:
 * its `downloadedQuants` or, for an entry `hf:register` made (one file), that
 * file's quant. Either label is the listing's own (`parseQuant`), which is the
 * label the picker shows. The picker and {@link pickHfDownload} both take their
 * `isDownloaded` from this one answer, so they rank alike.
 */
export function quantsOnDisk(catalog: readonly OnDiskEntry[], repo: string): ReadonlySet<string> {
  const held = new Set<string>();
  for (const e of catalog) {
    if (e.hfRepo !== repo || e.downloaded !== true) continue;
    const only = e.quants.length === 1 ? e.quants[0]?.quant : undefined;
    const quants = e.downloadedQuants ?? (e.source === 'hf' && only !== undefined ? [only] : []);
    for (const quant of quants) held.add(quant);
  }
  return held;
}

/** What a Download press resolves to. */
export type HfPick =
  | {
      readonly kind: 'file';
      /** The label the picker shows for it. */
      readonly quant: string;
      /** The weights — one file, never a projector, a speed head or a shard. */
      readonly file: HfGgufFileDTO;
      readonly mmproj?: HfGgufFileDTO;
      readonly mtpFile?: HfGgufFileDTO;
    }
  /** Nothing in the listing is a model this downloader can fetch. */
  | { readonly kind: 'none' }
  /** The quant asked for — or, with none asked, every quant — is split. */
  | { readonly kind: 'split'; readonly quant?: string; readonly parts?: number }
  /** A label the listing does not have (the listing changed under the picker). */
  | { readonly kind: 'missing'; readonly quant: string };

export interface HfPickOptions {
  /** The label the picker showed. Omitted: the recommendation, as the picker pins it. */
  readonly quant?: string;
  /**
   * Which labels are on disk: the repo's {@link quantsOnDisk}, which is also the
   * picker's `isDownloaded`, so the two rank alike and a file you have is the pick.
   */
  readonly isDownloaded?: (quant: string) => boolean;
}

/**
 * The file a Download fetches.
 *
 * With a `quant`, the file of that label that is the WEIGHTS: matching the label
 * alone found the speed head of the same name first. Without one, the picker's
 * own recommendation — `recommendedQuant` over {@link hfLadder}'s options with
 * the picker's inputs — never "the first file", whatever order the listing
 * arrives in.
 */
export function pickHfDownload(
  files: readonly HfGgufFileDTO[],
  fit: Omit<QuantFitInput, 'modelBytes'>,
  { quant, isDownloaded }: HfPickOptions = {},
): HfPick {
  const ladder = hfLadder(files);
  const want = quant ?? recommendedQuant(ladder.options, fit, isDownloaded)?.quant;
  if (want === undefined) {
    return ladder.split.size > 0 ? { kind: 'split' } : { kind: 'none' };
  }
  const parts = ladder.split.get(want);
  if (parts !== undefined) return { kind: 'split', quant: want, parts };
  const file = files.find(
    (f) => isWeights(f) && (f.sizeBytes ?? 0) > 0 && quantLabel(f.quant, f.path) === want,
  );
  if (file === undefined) return { kind: 'missing', quant: want };
  const mtpFile = files.find((f) => f.mtp === true);
  return {
    kind: 'file',
    quant: want,
    file,
    ...(ladder.mmproj === undefined ? {} : { mmproj: ladder.mmproj }),
    ...(mtpFile === undefined ? {} : { mtpFile }),
  };
}

/**
 * What to say when a Download resolves to no file.
 *
 * Specific about WHICH half failed: a repo with no GGUF in it is an
 * image/video/audio model that this downloader cannot install, and saying
 * "could not resolve a file" sends people looking for a bug. A listing that
 * never arrived is not a repo without weights either, so it is not called one.
 */
export function pickRefusal(
  repo: string,
  pick: Exclude<HfPick, { kind: 'file' }>,
  listingError?: string,
): string {
  if (pick.kind === 'none' && listingError !== undefined) {
    return `Could not list ${repo}'s files: ${listingError}`;
  }
  switch (pick.kind) {
    case 'none':
      return `${repo} publishes no GGUF weights. The generation stack fetches it on first use.`;
    case 'split':
      return pick.quant === undefined
        ? `Every quant of ${repo} is split into several files, and Bobble can only download single-file quants for now.`
        : `${pick.quant} is split into ${pick.parts ?? 'several'} files, and Bobble can only download single-file quants for now. Pick another from the list.`;
    case 'missing':
      return `${repo} no longer lists ${pick.quant}. Pick another from the list.`;
  }
}
