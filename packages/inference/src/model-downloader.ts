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

  /* Catalog bytes may be 0 (unverified entries), so the job total is only
     trustworthy when EVERY planned file declares a size. Reporting a partial
     denominator would be worse than reporting none. */
  const jobTotal = plan.every((p) => p.file.bytes > 0)
    ? plan.reduce((sum, p) => sum + p.file.bytes, 0)
    : null;

  const paths: Partial<Record<PlannedFile['kind'], string>> = {};
  let doneBytes = 0;
  for (const [index, planned] of plan.entries()) {
    const report = opts.onProgress;
    paths[planned.kind] = await fetchOne(
      planned.repo,
      planned.file,
      dir,
      opts,
      report === undefined
        ? undefined
        : (p) =>
            report(planned.file.name, {
              ...p,
              fileIndex: index,
              fileCount: plan.length,
              jobReceived: doneBytes + p.received,
              jobTotal,
            }),
    );
    doneBytes += planned.file.bytes;
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
