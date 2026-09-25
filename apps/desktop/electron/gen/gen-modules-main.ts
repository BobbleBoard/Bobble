/**
 * The generation modules' PORTS — the side effects gen-modules.ts coordinates,
 * bound to this Mac: where a module's marker lives, how each one is put there,
 * and how its progress reaches the window.
 *
 *   image  uv (the app's own pinned copy when none is on PATH) + the mflux
 *          environment, warmed by running one line of python through the SAME
 *          `uv run --with …` the worker uses — uv downloads every package first.
 *          Offline first, like every `uv run --with` here (inference uv-run.ts):
 *          an env already in uv's cache warms `--offline`, with no network.
 *   audio  the same, for mlx-audio.
 *   comfy  the ComfyUI engine (inference/engines-main), the thing Settings ›
 *          Engines installs; video, music and sound effects run on it.
 *   3d     the 3D sidecar (gen3d-main), whose first start is its install.
 *
 * A module counts as READY when its marker is there — written by a finished
 * install, or by the first job that succeeded without one (a Mac that already
 * had the environment from before this existed). ComfyUI and the sidecar answer
 * from their own state instead.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  buildEnvWarmArgs,
  buildMfluxSaveArgs,
  bundledWheelPath,
  type EnvWarmOptions,
  getModel,
  type MfluxSaveOptions,
  MODALITY_CATALOG,
  type ModalityModel,
  mfluxSaveUvEnv,
  resolveWorkerScript,
  type WeightFile,
  warmUvEnv,
} from '@pi-desktop/gen-service';
import { cacheRoot, uvEnvCached } from '@pi-desktop/inference';
import {
  downloadRepo,
  readManifest,
  removeStored,
  type StoredModel,
  writeManifest,
} from '@pi-desktop/model-store';
import { createLogger } from '@pi-desktop/shared';
import { ensureUv } from '@pi-desktop/web-tools';
import { gen3dModuleReady, warmGen3dModule } from '../gen3d/gen3d-main';
import { installEngine } from '../inference/engines-main';
import { comfyEngineInstalled } from '../studio/studio-main';
import {
  type GenModuleId,
  type GenModulePorts,
  type GenModuleState,
  GenModulesManager,
  uvLineToDetail,
  weightsModelId,
} from './gen-modules';
import {
  downloadedPath,
  preparedDir,
  preparedPresent,
  storeKind,
  weightPath,
  weightPresent,
  weightsMeta,
  weightsPresent,
} from './weights-on-shelf';

const log = createLogger('desktop:gen-modules');

/** What the ports need to know about this Mac beyond the catalog. */
export interface GenModulePortsDeps {
  /** worker.py's path (main.ts resolves it); the bundled wheels sit beside it. */
  readonly workerScript?: string | undefined;
}

function markerDir(): string {
  return path.join(cacheRoot(), 'gen', 'modules');
}
function markerPath(id: GenModuleId): string {
  return path.join(markerDir(), `${id}.json`);
}
function hasMarker(id: GenModuleId): boolean {
  return existsSync(markerPath(id));
}
function writeMarker(id: GenModuleId, how: 'installed' | 'succeeded'): void {
  mkdirSync(markerDir(), { recursive: true });
  writeFileSync(markerPath(id), `${JSON.stringify({ id, how, at: new Date().toISOString() })}\n`);
}

/** The catalog entry behind a weights module, when it lists or prepares files. */
function weightsModel(id: GenModuleId): ModalityModel | undefined {
  const modelId = weightsModelId(id);
  if (modelId === null) return undefined;
  const model = getModel(modelId);
  if (model === undefined) return undefined;
  const lists = model.weights !== undefined && model.weights.length > 0;
  return lists || model.mflux?.prepared !== undefined ? model : undefined;
}

/**
 * A MODEL MADE ON THIS MAC — `mflux.prepared` (Qwen-Image 2.1). Three steps
 * under one bar: fetch the bf16 release through the model store (sha-verified,
 * resumable, the same download Model management runs), `mflux-save` it to a
 * quantized folder on the shelf under the model's own mflux build, and remove
 * the release — 31 GB that nothing will read again. MEASURED 2026-09-20 (M5
 * Pro 24 GB): the conversion itself is 12 s; the fetch is the wait.
 *
 * The saved folder gets a manifest so Model management lists it as what it
 * is: a conversion of Qwen/Qwen-Image-2.1, made here, not a download.
 */
async function installPrepared(
  model: ModalityModel,
  deps: GenModulePortsDeps,
  report: (detail: string, percent?: number) => void,
): Promise<void> {
  const mflux = model.mflux;
  const prepared = mflux?.prepared;
  if (mflux === undefined || prepared === undefined)
    throw new Error(`${model.id} prepares nothing`);
  const total = prepared.downloadGB * 1e9;
  report(`Downloading ${prepared.from}…`, 0);
  const release = await downloadRepo({
    repo: prepared.from,
    kind: storeKind(model),
    name: `${model.label} (bf16 release)`,
    allow: prepared.patterns,
    backend: 'mflux',
    notes: 'The release Bobble converts to MLX; removed once the conversion has landed.',
    onProgress: (p) => {
      report(
        `Downloading ${p.file} — ${(p.received / 1e9).toFixed(1)} of ${(p.total / 1e9).toFixed(1)} GB`,
        // The whole button: the fetch is ~95% of it, the conversion the rest.
        Math.min(0.95, (0.95 * p.received) / Math.max(p.total, total)),
      );
    },
  });

  const uv = await ensureUv({});
  const workerScript = resolveWorkerScript(deps.workerScript);
  const dest = preparedDir(model);
  // A half-written folder from an interrupted save is redone, not trusted.
  if (existsSync(dest) && !preparedPresent(model)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  report(`Converting to ${prepared.bits}-bit for MLX — a minute or two, once…`, 0.95);
  const save: MfluxSaveOptions = {
    ...(mflux.wheel !== undefined
      ? { mfluxWith: bundledWheelPath(workerScript, mflux.wheel) }
      : {}),
    model: release.dir,
    ...(mflux.baseModel !== undefined ? { baseModel: mflux.baseModel } : {}),
    bits: prepared.bits,
    dest,
  };
  const offline = await uvCached(uv.uvPath, mfluxSaveUvEnv(save));
  await runUv(uv.uvPath, buildMfluxSaveArgs({ ...save, offline }), (line) => report(line, 0.97));
  if (!preparedPresent(model)) {
    throw new Error(`mflux-save finished but ${dest} is not a complete model`);
  }

  // What Model management shows for the folder: a conversion, with its bytes.
  await writeManifest(await preparedManifest(model, dest));

  report('Removing the bf16 release…', 0.99);
  await removeStored(release.id).catch((err) => {
    // Not fatal: the picture works; the 31 GB shows in Model management to remove by hand.
    log.warn('prepared: release not removed', { dir: release.dir, err: String(err) });
  });
  report('Ready', 1);
}

/** The manifest of a conversion: what it is, where from, what it weighs. */
async function preparedManifest(model: ModalityModel, dir: string): Promise<StoredModel> {
  const prepared = model.mflux?.prepared;
  if (prepared === undefined) throw new Error(`${model.id} prepares nothing`);
  const files = await savedFiles(dir);
  return {
    id: prepared.folder,
    repo: prepared.from,
    // The wheel keeps the text encoder at 8 bits under a 4-bit save.
    name: `${model.label} (MLX ${prepared.bits}-bit, 8-bit encoder)`,
    org: prepared.from.split('/')[0] ?? '',
    kind: storeKind(model),
    tasks: ['text-to-image'],
    backend: 'mflux',
    dir,
    files,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    installedAt: new Date().toISOString(),
    source: 'store',
    quant: `${prepared.bits}-bit MLX, 8-bit encoder`,
    notes: `Converted on this Mac from ${prepared.from} by mflux-save; the bf16 release is not kept.`,
  };
}

/** Every file under a saved model's folder, relative, with its size. */
async function savedFiles(dir: string): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name !== 'model.json')
        out.push({ path: next, bytes: statSync(path.join(dir, next)).size });
    }
  };
  await walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A conversion that is there but has no manifest — made by hand before the
 * button existed — is adopted: the manifest is written so Model management
 * lists it, and it counts as ready. Idempotent; nothing is downloaded.
 */
async function adoptPrepared(model: ModalityModel): Promise<boolean> {
  if (!preparedPresent(model)) return false;
  const dir = preparedDir(model);
  if ((await readManifest(dir)) === undefined) {
    await writeManifest(await preparedManifest(model, dir)).catch((err) =>
      log.warn('prepared: manifest not written', { dir, err: String(err) }),
    );
    log.info('prepared: adopted a conversion found on the shelf', { dir });
  }
  return true;
}

/**
 * Fetch the listed files that are missing, one repo at a time, through the
 * model store (sha-verified, resumable, a manifest beside the files — the same
 * download Model management runs). Progress is whole-set: a person pressing
 * one button sees one bar.
 */
async function installWeights(
  model: ModalityModel,
  report: (detail: string, percent?: number) => void,
): Promise<void> {
  const files = (model.weights ?? []).filter((f) => !weightPresent(model, f));
  const total = files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  let before = 0;
  const byRepo = new Map<string, WeightFile[]>();
  for (const f of files) byRepo.set(f.repo, [...(byRepo.get(f.repo) ?? []), f]);
  for (const [repo, list] of byRepo) {
    const repoBytes = list.reduce((n, f) => n + (f.bytes ?? 0), 0);
    report(`Downloading ${repo}…`, total > 0 ? before / total : undefined);
    await downloadRepo({
      repo,
      kind: storeKind(model),
      name: model.label,
      allow: list.map((f) => f.path),
      backend: model.backend,
      onProgress: (p) => {
        const done = before + p.received;
        report(
          `Downloading ${p.file} — ${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`,
          total > 0 ? Math.min(1, done / total) : undefined,
        );
      },
    });
    before += repoBytes;
    // A root-level file into the type folder ComfyUI reads it from.
    for (const f of list) {
      const landed = downloadedPath(model, f);
      const home = weightPath(model, f);
      if (landed !== home && existsSync(landed)) {
        mkdirSync(path.dirname(home), { recursive: true });
        renameSync(landed, home);
      }
    }
  }
  for (const f of model.weights ?? []) {
    if (!weightPresent(model, f)) {
      throw new Error(`${f.repo}/${f.path} did not land where the graph reads it`);
    }
  }
}

/**
 * The envs a uv-worker module warms — for `image`, one per mflux build the
 * catalog's image models run on: the pinned release, and the bundled wheel of
 * any model that ships its own (Qwen-Image 2.1's port). Same packages for the
 * most part; uv hardlinks them, so the second is quick.
 */
function warmSpecs(id: 'image' | 'audio', deps: GenModulePortsDeps): EnvWarmOptions[] {
  if (id === 'audio') return [{ backend: 'mlx-audio' }];
  const workerScript = resolveWorkerScript(deps.workerScript);
  const wheels = new Set<string>();
  for (const m of MODALITY_CATALOG) {
    if (m.modality === 'image' && m.reserved !== true && m.mflux?.wheel !== undefined)
      wheels.add(bundledWheelPath(workerScript, m.mflux.wheel));
  }
  return [
    { backend: 'mflux' },
    ...[...wheels].map((mfluxWith): EnvWarmOptions => ({ backend: 'mflux', mfluxWith })),
  ];
}

/** The env every `uv` here runs with — the probe's and the launch's alike. */
function uvSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, UV_PYTHON_DOWNLOADS: 'automatic' };
}

/**
 * Is this env already all in uv's cache? A silent `uv run --offline` probe
 * (inference uv-run.ts): yes → the launch runs `--offline` and needs no
 * network; no → online, as before, and uv downloads.
 */
function uvCached(uvPath: string, env: readonly string[]): Promise<boolean> {
  return uvEnvCached((args) => spawn(uvPath, args, { env: uvSpawnEnv(), stdio: 'ignore' }), env);
}

/**
 * Run `uv …` streaming its stderr (uv's resolver/downloader talks there) into
 * the card's detail line. Resolves on exit 0, rejects with uv's last words.
 */
function runUv(
  uvPath: string,
  args: string[],
  report: (detail: string, percent?: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(uvPath, args, {
      env: uvSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      const line = uvLineToDetail(text);
      if (line !== undefined) report(line);
    };
    child.stderr?.on('data', onChunk);
    child.stdout?.on('data', onChunk);
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else {
        const last = uvLineToDetail(tail) ?? `uv exited with code ${code}`;
        reject(new Error(last));
      }
    });
  });
}

export function createGenModulePorts(
  emit: (states: readonly GenModuleState[]) => void,
  deps: GenModulePortsDeps = {},
): GenModulePorts {
  return {
    ready: async (id) => {
      const weighted = weightsModel(id);
      if (weighted !== undefined) {
        return weighted.mflux?.prepared !== undefined
          ? adoptPrepared(weighted)
          : weightsPresent(weighted);
      }
      switch (id) {
        case 'comfy':
          return comfyEngineInstalled();
        case '3d':
          return gen3dModuleReady();
        default:
          return hasMarker(id);
      }
    },
    meta: (id) => {
      const weighted = weightsModel(id);
      return weighted === undefined ? undefined : weightsMeta(weighted);
    },
    install: async (id, report) => {
      const weighted = weightsModel(id);
      if (weighted !== undefined) {
        if (weighted.mflux?.prepared !== undefined) await installPrepared(weighted, deps, report);
        else await installWeights(weighted, report);
        return;
      }
      switch (id) {
        case 'image':
        case 'audio': {
          report('Fetching the package manager…');
          const uv = await ensureUv({
            onProgress: (p) => {
              if (p.total !== undefined && p.total > 0)
                report('Fetching the package manager…', p.received / p.total);
            },
          });
          log.info('module install: uv ready', { id, source: uv.source, uvPath: uv.uvPath });
          report('Resolving packages…');
          for (const warm of warmSpecs(id, deps)) {
            const offline = await uvCached(uv.uvPath, warmUvEnv(warm));
            await runUv(uv.uvPath, buildEnvWarmArgs({ ...warm, offline }), report);
          }
          writeMarker(id, 'installed');
          return;
        }
        case 'comfy': {
          report('Installing ComfyUI — a clone and a Torch environment; this takes a while…');
          const res = await installEngine('comfyui');
          if (!res.success) throw new Error(res.error ?? 'ComfyUI install failed');
          return;
        }
        case '3d': {
          await warmGen3dModule(report);
          return;
        }
      }
    },
    remember: (id) => {
      if (id === 'image' || id === 'audio') writeMarker(id, 'succeeded');
    },
    emit,
  };
}

/** Read back a marker (diagnostics). */
export function readModuleMarker(id: GenModuleId): { how: string; at: string } | null {
  try {
    return JSON.parse(readFileSync(markerPath(id), 'utf8')) as { how: string; at: string };
  } catch {
    return null;
  }
}

export function createGenModules(
  emit: (states: readonly GenModuleState[]) => void,
  deps: GenModulePortsDeps = {},
) {
  return new GenModulesManager(createGenModulePorts(emit, deps));
}
