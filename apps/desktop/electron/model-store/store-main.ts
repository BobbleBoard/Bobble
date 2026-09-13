/**
 * The store's main-process side: one download at a time, an index that reads
 * every source, and a delete that respects who owns what.
 *
 * ONE AT A TIME, deliberately. These are multi-gigabyte trees and the machine
 * has one network link and one disk; two in flight finish later than two in
 * sequence and make both progress bars lie about their rate. The map is keyed by
 * repo anyway, so a second request for the SAME repo is idempotent rather than a
 * second writer onto the same files.
 *
 * THE INDEX SPANS THREE SOURCES, because the weights already did. New downloads
 * live in the store; GGUF models live in the inference supervisor's directory;
 * the 3D engine's repos live in its Hugging Face cache. Rather than move any of
 * them, this adapts the two older layouts into the same `StoredModel` shape, so
 * a video studio added next month asks one question and gets one answer.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheRoot as inferenceCacheRoot, legacyModelsDir, modelsDir } from '@pi-desktop/inference';
import {
  discardRepo,
  downloadRepo,
  listStore,
  type ModelKind,
  removeStored,
  type StoredFile,
  type StoredModel,
  totalBytes,
} from '@pi-desktop/model-store';
import { registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { StoreDownloadUpdate, StoreInvokeMap } from './store-contract';

type Emit = (channel: 'store:download', payload: StoreDownloadUpdate) => void;

const inFlight = new Map<string, AbortController>();

/** Recursively sum a directory's files, and list them, relative to its root. */
async function walk(dir: string, base = dir): Promise<StoredFile[]> {
  const out: StoredFile[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) out.push(...(await walk(full, base)));
      else if (s.isFile()) out.push({ path: full.slice(base.length + 1), bytes: s.size });
    } catch {
      /* a file that vanished mid-walk is not worth failing the listing over */
    }
  }
  return out;
}

/**
 * GGUF models, as the store sees them.
 *
 * They keep living where the supervisor put them — see the module docstring —
 * so this describes rather than relocates. `source: 'llm'` is what stops the
 * store's delete from pulling weights out from under a running server.
 */
async function adaptLlmModels(): Promise<StoredModel[]> {
  // The library's LLM shelf, and the legacy folder while it still has entries.
  const roots = [modelsDir(), legacyModelsDir()];
  const out: StoredModel[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      continue;
    }
    for (const id of dirs) {
      // `LLM/MLX` is the twins' shelf, not a catalog model.
      if (id === 'MLX' || id.startsWith('.') || id === 'README.txt' || seen.has(id)) continue;
      seen.add(id);
      const dir = join(root, id);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      const files = await walk(dir);
      if (files.length === 0) continue;
      out.push({
        id,
        repo: id,
        name: id,
        org: '',
        kind: 'text',
        backend: 'llamacpp',
        dir,
        files,
        bytes: files.reduce((sum, f) => sum + f.bytes, 0),
        installedAt: new Date(0).toISOString(),
        source: 'llm',
      });
    }
  }
  return out;
}

/**
 * The 3D engine's repos, from its own Hugging Face cache.
 *
 * Its stamp files (`gen3d/installed/<id>.json`) are the record of what finished;
 * the blob directories under `gen3d/hf/hub` are where the bytes are. Reading
 * both is what lets the store report 18 GB of TRELLIS as disk the user is
 * actually spending, instead of it being invisible because a different
 * component downloaded it.
 */
async function adaptGen3dModels(): Promise<StoredModel[]> {
  const root = join(inferenceCacheRoot(), 'gen3d');
  const hub = join(root, 'hf', 'hub');
  let installed: string[];
  try {
    installed = (await readdir(join(root, 'installed'))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  let repos: string[];
  try {
    repos = (await readdir(hub)).filter((d) => d.startsWith('models--'));
  } catch {
    repos = [];
  }
  const byRepo = new Map<string, string>();
  for (const d of repos) byRepo.set(d.slice('models--'.length).replace(/--/g, '/'), join(hub, d));

  const out: StoredModel[] = [];
  for (const file of installed) {
    const id = file.replace(/\.json$/, '');
    let stampRepos: string[] = [];
    try {
      const stamp: unknown = JSON.parse(await readFile(join(root, 'installed', file), 'utf8'));
      const list = (stamp as { repos?: unknown }).repos;
      if (Array.isArray(list)) stampRepos = list.filter((r): r is string => typeof r === 'string');
    } catch {
      /* a stamp we cannot read still means "installed"; it just names no repos */
    }
    const dirs = stampRepos.map((r) => byRepo.get(r)).filter((d): d is string => d !== undefined);
    const files = (await Promise.all(dirs.map((d) => walk(d)))).flat();
    out.push({
      id: `gen3d:${id}`,
      repo: stampRepos[0] ?? id,
      name: id,
      org: (stampRepos[0] ?? '').split('/')[0] ?? '',
      kind: '3d',
      backend: 'gen3d',
      dir: dirs[0] ?? root,
      files,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      installedAt: new Date(0).toISOString(),
      source: 'gen3d',
    });
  }
  return out;
}

async function listEverything(): Promise<StoredModel[]> {
  const [store, llm, gen3d] = await Promise.all([
    listStore(),
    adaptLlmModels(),
    adaptGen3dModels(),
  ]);
  return [...store, ...llm, ...gen3d];
}

export function registerStoreIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  emit: Emit,
  hfToken: () => string | undefined,
): void {
  registerIpcHandlers<StoreInvokeMap>(
    ipcMain,
    {
      'store:list': async () => {
        const models = await listEverything();
        return { models, bytes: totalBytes(models) };
      },

      'store:download': async (req) => {
        if (inFlight.has(req.repo)) return { ok: true };
        const controller = new AbortController();
        inFlight.set(req.repo, controller);
        const token = hfToken();
        void (async () => {
          try {
            await downloadRepo({
              repo: req.repo,
              kind: req.kind as ModelKind,
              name: req.name,
              ...(req.family === undefined ? {} : { family: req.family }),
              ...(req.tasks === undefined ? {} : { tasks: req.tasks }),
              ...(req.backend === undefined ? {} : { backend: req.backend }),
              ...(req.notes === undefined ? {} : { notes: req.notes }),
              ...(req.allow === undefined ? {} : { allow: req.allow }),
              ...(token === undefined ? {} : { hfToken: token }),
              signal: controller.signal,
              onProgress: (p) => emit('store:download', { ...p, done: false }),
            });
            emit('store:download', {
              repo: req.repo,
              received: 1,
              total: 1,
              fraction: 1,
              file: '',
              fileIndex: 0,
              fileCount: 0,
              done: true,
            });
          } catch (err) {
            const cancelled = controller.signal.aborted;
            // A cancel is an outcome the user asked for, not a failure — saying
            // "download failed" about it is how the UI ends up arguing with the
            // button that was just pressed.
            if (cancelled) await discardRepo(req.kind as ModelKind, req.repo);
            emit('store:download', {
              repo: req.repo,
              received: 0,
              total: 0,
              fraction: 0,
              file: '',
              fileIndex: 0,
              fileCount: 0,
              done: true,
              ...(cancelled
                ? { cancelled: true }
                : { error: err instanceof Error ? err.message : String(err) }),
            });
          } finally {
            inFlight.delete(req.repo);
          }
        })();
        return { ok: true };
      },

      'store:cancel': async (req) => {
        const controller = inFlight.get(req.repo);
        if (controller === undefined) return { ok: false };
        controller.abort();
        return { ok: true };
      },

      'store:delete': async (req) => {
        try {
          await removeStored(req.id);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    { allowSender },
  );
}
