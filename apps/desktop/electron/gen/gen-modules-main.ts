/**
 * The generation modules' PORTS — the side effects gen-modules.ts coordinates,
 * bound to this Mac: where a module's marker lives, how each one is put there,
 * and how its progress reaches the window.
 *
 *   image  uv (the app's own pinned copy when none is on PATH) + the mflux
 *          environment, warmed by running one line of python through the SAME
 *          `uv run --with …` the worker uses — uv downloads every package first.
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildEnvWarmArgs,
  getModel,
  type ModalityModel,
  type WeightFile,
} from '@pi-desktop/gen-service';
import { cacheRoot } from '@pi-desktop/inference';
import { downloadRepo } from '@pi-desktop/model-store';
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
  storeKind,
  weightPath,
  weightPresent,
  weightsMeta,
  weightsPresent,
} from './weights-on-shelf';

const log = createLogger('desktop:gen-modules');

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

/** The catalog entry behind a weights module, when it lists files. */
function weightsModel(id: GenModuleId): ModalityModel | undefined {
  const modelId = weightsModelId(id);
  if (modelId === null) return undefined;
  const model = getModel(modelId);
  return model?.weights !== undefined && model.weights.length > 0 ? model : undefined;
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

/** The env-warm argv for a uv-worker module. */
function warmArgs(id: 'image' | 'audio'): string[] {
  return buildEnvWarmArgs({ backend: id === 'image' ? 'mflux' : 'mlx-audio' });
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
      env: { ...process.env, UV_PYTHON_DOWNLOADS: 'automatic' },
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
): GenModulePorts {
  return {
    ready: async (id) => {
      const weighted = weightsModel(id);
      if (weighted !== undefined) return weightsPresent(weighted);
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
        await installWeights(weighted, report);
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
          await runUv(uv.uvPath, warmArgs(id), report);
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

export function createGenModules(emit: (states: readonly GenModuleState[]) => void) {
  return new GenModulesManager(createGenModulePorts(emit));
}
