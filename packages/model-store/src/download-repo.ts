/**
 * DOWNLOAD ANY HUGGING FACE REPO INTO THE STORE.
 *
 * the user: "we need to be able to download anything and store it properly in an
 * organized format so that no matter what we add either now or later we have an
 * easy way to list relevant models and know where their weights are stored."
 *
 * A GGUF text model is one file out of a ladder, and the app already had a
 * downloader for that. Everything else — image, video, audio, 3D — is a TREE:
 * transformer shards, a VAE, a text encoder, config JSON. There is no single
 * file to choose, so this takes the repo, and the unit of progress is the whole
 * set rather than whichever file is moving.
 *
 * WHAT IT REUSES, DELIBERATELY. Each file goes through `downloadFile` from the
 * inference package — the same resumable, sha256-verified, abortable transfer
 * that GGUF downloads use. Writing a second HTTP downloader here would mean two
 * implementations of resume, two of verification, and two places for a partial
 * file to be mistaken for a whole one.
 *
 * THE MANIFEST IS WRITTEN FIRST, marked `incomplete`, and rewritten at the end
 * without that mark. So an interrupted download leaves a directory that says
 * what it is and that it is unfinished, instead of a pile of files that the
 * index has to guess about. A crash gets the same treatment as a clean cancel,
 * because neither one gets to run cleanup code.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadFile, type HfRepoFile, listHfRepoFiles } from '@pi-desktop/inference';
import { entryDir, type ModelKind } from './layout.js';
import type { ModelTask, StoredFile, StoredModel } from './manifest.js';
import { readManifest, writeManifest } from './store.js';

export interface RepoDownloadProgress {
  readonly repo: string;
  /** Bytes across the WHOLE repo, not the current file. */
  readonly received: number;
  readonly total: number;
  readonly fraction: number;
  /** Which file is moving, for the caption. */
  readonly file: string;
  readonly fileIndex: number;
  readonly fileCount: number;
}

export interface RepoDownloadOptions {
  readonly repo: string;
  readonly kind: ModelKind;
  readonly name: string;
  readonly org?: string;
  readonly family?: string;
  readonly tasks?: readonly ModelTask[];
  readonly backend?: string;
  readonly notes?: string;
  /**
   * Glob-ish prefixes/suffixes to keep, as the 3D registry already uses
   * (`ckpts/ss_dec_*`). Empty means the whole repo. Matching is deliberately
   * simple — `*` only — because the alternative is shipping a glob engine to
   * express "the transformer and the VAE, not the ONNX exports".
   */
  readonly allow?: readonly string[];
  readonly hfToken?: string;
  readonly root?: string;
  readonly onProgress?: (p: RepoDownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** `*`-only glob match against a repo-relative path. */
export function matchesAllow(path: string, allow: readonly string[] | undefined): boolean {
  if (allow === undefined || allow.length === 0) return true;
  return allow.some((pattern) => {
    const rx = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    return rx.test(path);
  });
}

/**
 * Files worth fetching, and the bytes they will cost.
 *
 * Skips the `.gitattributes` / `README.md` furniture only when the repo has real
 * weights beside them, so a documentation-only repo still reports honestly
 * instead of appearing to be a zero-byte model.
 */
export function selectFiles(files: readonly HfRepoFile[], allow?: readonly string[]): HfRepoFile[] {
  const kept = files.filter((f) => matchesAllow(f.path, allow));
  const withoutGit = kept.filter((f) => !/^\.git/.test(f.path));
  // "Real weights" must be judged on the files that would REMAIN — a
  // `.gitattributes` is a non-zero byte count and would otherwise vouch for
  // itself, stripping the only file in a repo that has nothing else.
  const weighty = withoutGit.some((f) => (f.sizeBytes ?? 0) > 0);
  return weighty ? withoutGit : kept;
}

const HF_RESOLVE = 'https://huggingface.co';

export async function downloadRepo(opts: RepoDownloadOptions): Promise<StoredModel> {
  const dir = entryDir(opts.kind, opts.repo, opts.root);
  const listOpts = {
    ...(opts.hfToken === undefined ? {} : { hfToken: opts.hfToken }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const all = await listHfRepoFiles(opts.repo, listOpts);
  const files = selectFiles(all, opts.allow);
  if (files.length === 0) throw new Error(`${opts.repo} has no files matching the requested set`);

  const total = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const org = opts.org ?? opts.repo.split('/')[0] ?? '';
  const id = dir.split('/').pop() ?? opts.repo;

  /*
   * ONE DIRECTORY PER REPO, EVEN WHEN YOU FETCH IT IN PIECES.
   *
   * A big generation repo is downloaded as recipes — "first + last frame → video
   * at Q4" is a few files out of a tree that also holds the reference-image
   * weights and the encoder. Those land in the same directory because they ARE
   * the same repo, so the manifest has to accumulate: the union of the files
   * present and the union of the jobs they enable. Overwriting instead would
   * make the second download appear to delete the first, in the index if not on
   * the disk.
   */
  const prior = await readManifest(dir);
  const priorFiles = prior?.repo === opts.repo ? (prior.files ?? []) : [];
  const priorTasks = prior?.repo === opts.repo ? (prior.tasks ?? []) : [];

  const base: StoredModel = {
    id,
    repo: opts.repo,
    name: opts.name,
    org,
    kind: opts.kind,
    dir,
    files: [],
    bytes: total,
    installedAt: new Date().toISOString(),
    source: 'store',
    incomplete: true,
    ...(opts.family === undefined ? {} : { family: opts.family }),
    ...(opts.tasks === undefined ? {} : { tasks: opts.tasks }),
    ...(opts.backend === undefined ? {} : { backend: opts.backend }),
    ...(opts.notes === undefined ? {} : { notes: opts.notes }),
  };
  await writeManifest(base);

  const done: StoredFile[] = [];
  let received = 0;
  for (const [index, file] of files.entries()) {
    if (opts.signal?.aborted === true) throw new Error('cancelled');
    const url = `${HF_RESOLVE}/${opts.repo}/resolve/main/${file.path}`;
    const dest = join(dir, file.path);
    const before = received;
    await downloadFile({
      url,
      dest,
      ...(file.sha256 === undefined ? {} : { expectedSha256: file.sha256 }),
      ...(file.sizeBytes === undefined ? {} : { expectedBytes: file.sizeBytes }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.hfToken === undefined
        ? {}
        : { headers: { authorization: `Bearer ${opts.hfToken}` } }),
      onProgress: (p) => {
        opts.onProgress?.({
          repo: opts.repo,
          received: before + p.received,
          total,
          fraction: total > 0 ? Math.min(1, (before + p.received) / total) : 0,
          file: file.path,
          fileIndex: index,
          fileCount: files.length,
        });
      },
    });
    received = before + (file.sizeBytes ?? 0);
    done.push({ path: file.path, bytes: file.sizeBytes ?? 0 });
  }

  const merged = [...priorFiles.filter((f) => !done.some((d) => d.path === f.path)), ...done];
  const tasks = [...new Set([...priorTasks, ...(opts.tasks ?? [])])];
  const finished: StoredModel = {
    ...base,
    files: merged,
    bytes: merged.reduce((sum, f) => sum + f.bytes, 0),
    ...(tasks.length === 0 ? {} : { tasks }),
    installedAt: new Date().toISOString(),
  };
  // Written WITHOUT `incomplete` — see the file docstring.
  const { incomplete: _dropped, ...clean } = finished;
  await writeManifest(clean as StoredModel);
  return clean as StoredModel;
}

/**
 * Throw away a cancelled download.
 *
 * The whole directory goes, manifest included: a half-fetched tree is not a
 * model, and leaving it costs disk while looking like something the user chose
 * to keep. Only ever called for an entry this module created.
 */
export async function discardRepo(kind: ModelKind, repo: string, root?: string): Promise<void> {
  await rm(entryDir(kind, repo, root), { recursive: true, force: true });
}
