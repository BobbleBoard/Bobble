/**
 * Download a catalog model's GGUF file(s) — plus its mmproj / MTP siblings when
 * a launch mode needs them — from HuggingFace `resolve/main` URLs, reusing the
 * resumable + sha256 + progress machinery in ./download.ts.
 *
 * Files land under `~/.cache/pi-desktop/models/<modelId>/`. Idempotent: already
 * present + verified files are skipped. Electron-free.
 */
import { join } from 'node:path';
import { type CatalogFile, type CatalogModel, hfResolveUrl, type LaunchMode } from './catalog.js';
import { type DownloadProgress, downloadFile } from './download.js';
import { hfHeadFile } from './hf-search.js';
import { modelDir } from './paths.js';

/**
 * A file's own progress PLUS where that file sits in the whole download.
 *
 * The per-file numbers are still here (a resumed 12-of-13 GB file wants its own
 * bar), but the UI leads with the job so the bar only ever moves forwards.
 */
export interface JobProgress extends DownloadProgress {
  /** 0-based position of the file being fetched. */
  readonly fileIndex: number;
  /** How many files this download will fetch in total. */
  readonly fileCount: number;
  /** Bytes received across the whole job so far. */
  readonly jobReceived: number;
  /** Total bytes across every planned file; null when any size is unknown. */
  readonly jobTotal: number | null;
}

export interface ModelDownloadOptions {
  /** Leave the DFlash / DSpark drafters out (the bare weights only). */
  readonly skipDrafters?: boolean;
  /** Which quant to fetch (defaults to the first file listed). */
  readonly quant?: string;
  /** Launch mode decides whether the mmproj / MTP sibling is fetched too. */
  readonly launchMode?: LaunchMode;
  /**
   * Fetch EVERY sibling the model can use, ignoring `launchMode`.
   *
   * The download question ("what might this model need?") is not the launch
   * question ("what am I loading right now?"), and conflating them is why a
   * vision model could be fully "downloaded" with no projector on disk: the
   * Model Manager downloads as `fast-text`, so the mmproj was left to be
   * fetched on demand — i.e. the first time you send it an image, mid-chat,
   * as a surprise ~1 GB stall.
   */
  readonly allCompanions?: boolean;
  /** Directory override (defaults to `~/.cache/pi-desktop/models/<id>`). */
  readonly dir?: string;
  /** Per-file progress; `file` names which sibling is downloading, and `p`
   * carries the WHOLE-JOB position alongside this file's own (see JobProgress). */
  readonly onProgress?: (file: string, p: JobProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** HF auth header for gated repos (public repos need none). */
  readonly hfToken?: string;
}

export interface DownloadedModel {
  readonly model: CatalogModel;
  readonly dir: string;
  /** Absolute path to the main GGUF. */
  readonly modelPath: string;
  /** Absolute path to the mmproj sibling (multimodal only). */
  readonly mmprojPath?: string;
  /** Absolute path to the separate MTP head (Gemma-style fast-text only). */
  readonly mtpPath?: string;
  /** Absolute path to the EAGLE-3 draft model (fast-text only). */
  readonly draftPath?: string;
}

function pickFile(model: CatalogModel, quant: string | undefined): CatalogFile {
  if (quant === undefined) {
    const first = model.files[0];
    if (first === undefined) throw new Error(`model ${model.id} has no files`);
    return first;
  }
  const file = model.files.find((f) => f.quant === quant);
  if (file === undefined) throw new Error(`quant ${quant} not found in ${model.id}`);
  return file;
}

async function fetchOne(
  repo: string,
  file: CatalogFile,
  dir: string,
  opts: Omit<ModelDownloadOptions, 'onProgress'>,
  /** This file's raw progress; the caller decorates it with the job position. */
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  const dest = join(dir, file.name);
  const headers: Record<string, string> = { 'user-agent': 'pi-desktop' };
  if (opts.hfToken !== undefined) headers.authorization = `Bearer ${opts.hfToken}`;
  await downloadFile({
    url: hfResolveUrl(repo, file.name),
    dest,
    expectedSha256: file.sha256,
    // 0 = unverified/unknown → no size assertion (see catalog note).
    expectedBytes: file.bytes > 0 ? file.bytes : undefined,
    ...(onProgress !== undefined ? { onProgress } : {}),
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    headers,
  });
  return dest;
}

/** One file in the download plan, in the order it will be fetched. */
interface PlannedFile {
  readonly kind: 'model' | 'mmproj' | 'mtp' | 'draft';
  readonly repo: string;
  readonly file: CatalogFile;
}

/**
 * Ensure a catalog model's files are downloaded for the given launch mode.
 *
 * - `multimodal` pulls the `mmproj` sibling (required for vision).
 * - `fast-text` pulls the separate `mtpFile` sibling when the model has one
 *   (Gemma4); Qwen3.6 embeds the MTP head so nothing extra is fetched. For an
 *   EAGLE-3 entry it pulls the `draftModel` from its (usually separate)
 *   `draftRepo` so the launch can pass `--model-draft`.
 * - `allCompanions` takes everything, whatever the mode.
 *
 * THE PLAN IS BUILT BEFORE THE FIRST BYTE, so progress can be reported against
 * the WHOLE job rather than the current file. That is not a nicety: the moment
 * companions started downloading with the weights, a per-file bar reached 100%
 * and then snapped back to 0% for the projector, which reads as the download
 * having restarted. A 13 GB model with a 1 GB projector does that in front of
 * someone who has been watching for seven minutes.
 */
export async function downloadModel(
  model: CatalogModel,
  opts: ModelDownloadOptions = {},
): Promise<DownloadedModel> {
  const dir = opts.dir ?? modelDir(model.id);
  const mode = opts.launchMode ?? 'fast-text';
  const all = opts.allCompanions === true;

  const plan: PlannedFile[] = [
    { kind: 'model', repo: model.hfRepo, file: pickFile(model, opts.quant) },
  ];
  if ((all || mode === 'multimodal') && model.mmproj !== undefined) {
    plan.push({ kind: 'mmproj', repo: model.hfRepo, file: model.mmproj });
  }
  if ((all || mode === 'fast-text') && model.mtpFile !== undefined && model.mtpEmbedded !== true) {
    plan.push({ kind: 'mtp', repo: model.hfRepo, file: model.mtpFile });
  }
  if ((all || mode === 'fast-text') && model.spec === 'eagle3' && model.draftModel !== undefined) {
    // The EAGLE-3 draft usually lives in a separate repo (draftRepo).
    plan.push({ kind: 'draft', repo: model.draftRepo ?? model.hfRepo, file: model.draftModel });
  }
  /*
   * …AND EVERY OTHER DRAFTER THE MODEL HAS A FILE FOR. the user: "when downloading
   * any models from the recommended tab, applicable drafter(s) should also be
   * downloaded right there and then." A DFlash or DSpark draft is a few hundred
   * megabytes beside a multi-gigabyte model, and it is what lets calibration
   * measure those methods with no network at all. `skipDrafters` is the
   * opt-out for a caller that wants the bare weights.
   */
  if ((all || mode === 'fast-text') && opts.skipDrafters !== true) {
    for (const v of model.variants ?? []) {
      if (v.draftModel === undefined || v.draftRepo === undefined) continue;
      if (plan.some((p) => p.file.name === v.draftModel?.name)) continue;
      plan.push({ kind: 'draft', repo: v.draftRepo, file: v.draftModel });
    }
  }

  /*
   * ASK HOW BIG THE FILES ARE, RATHER THAN GIVING UP ON THE JOB BAR.
   *
   * Catalog bytes may be 0 (unverified entries), and the job total is only
   * trustworthy when EVERY planned file declares a size — reporting a partial
   * denominator would be worse than reporting none. But "none" is what the user
   * gets, and 11 of the catalogue's 35 files carry no size while 14 of its 19
   * models fetch more than one file, so a bar that fills to 100% and restarts
   * at the projector was the ORDINARY case, not an edge one. MEASURED in the
   * download stress probe: the reported fraction fell from 1 to 0.86 the moment
   * the second file began.
   *
   * A HEAD per unknown file answers it — one request, before a transfer that is
   * usually gigabytes. Best-effort in both directions: a HEAD that fails or
   * answers without a length leaves that file unknown, and the job total goes
   * back to null exactly as before.
   */
  const sizes = new Map<string, number>();
  const unknown = plan.filter((p) => p.file.bytes <= 0);
  if (unknown.length > 0) {
    await Promise.all(
      unknown.map(async (p) => {
        const head = await hfHeadFile(p.repo, p.file.name, {
          ...(opts.hfToken === undefined ? {} : { hfToken: opts.hfToken }),
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          // Through the caller's fetch, so a test that stubs the transfer is
          // not quietly making a real network request to size it.
          ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
        }).catch(() => null);
        if (head?.sizeBytes !== undefined) sizes.set(p.file.name, head.sizeBytes);
      }),
    );
  }
  const sizeOf = (p: PlannedFile): number =>
    p.file.bytes > 0 ? p.file.bytes : (sizes.get(p.file.name) ?? 0);
  const jobTotal = plan.every((p) => sizeOf(p) > 0)
    ? plan.reduce((sum, p) => sum + sizeOf(p), 0)
    : null;

  const paths: Partial<Record<PlannedFile['kind'], string>> = {};
  let doneBytes = 0;
  for (const [index, planned] of plan.entries()) {
    const report = opts.onProgress;
    /*
     * The running total counts what ACTUALLY arrived, not what the catalogue
     * said would. A declared size that is a little wrong (or a file that was
     * already on disk and contributed nothing) would otherwise make the job
     * bar step or overshoot at every file boundary.
     */
    let fileReceived = 0;
    paths[planned.kind] = await fetchOne(
      planned.repo,
      planned.file,
      dir,
      opts,
      report === undefined
        ? undefined
        : (p) => {
            fileReceived = p.received;
            report(planned.file.name, {
              ...p,
              fileIndex: index,
              fileCount: plan.length,
              jobReceived: doneBytes + p.received,
              jobTotal,
            });
          },
    );
    doneBytes += fileReceived > 0 ? fileReceived : sizeOf(planned);
  }

  const modelPath = paths.model;
  if (modelPath === undefined) throw new Error(`model ${model.id} produced no main file`);
  return {
    model,
    dir,
    modelPath,
    ...(paths.mmproj !== undefined ? { mmprojPath: paths.mmproj } : {}),
    ...(paths.mtp !== undefined ? { mtpPath: paths.mtp } : {}),
    ...(paths.draft !== undefined ? { draftPath: paths.draft } : {}),
  };
}
