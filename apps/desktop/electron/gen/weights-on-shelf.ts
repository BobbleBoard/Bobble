/**
 * WHERE A GRAPH'S FILES SIT, and whether they are all there.
 *
 * A catalog entry lists the files its ComfyUI graph loads (`weights`); the
 * model store lands each one at `<shelf>/<org__repo>/<path>` (download-repo.ts)
 * and ComfyUI is pointed at every such folder (engines-main
 * writeComfyModelPaths). This is the one place that spelling is agreed on, so
 * the gate that asks "present?" and the download that makes it so cannot
 * disagree about a directory. No Electron, no side effects: the 3D studio's
 * main and the modules' ports both read it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ModalityModel, WeightFile } from '@pi-desktop/gen-service';
import { entryDir, type ModelKind, shelfDir, shelfFor } from '@pi-desktop/model-store';
import type { GenModuleMeta } from './gen-modules';

/** The store's kind for a catalog modality (the shelf a repo lands on). */
export function storeKind(model: ModalityModel): ModelKind {
  return model.modality;
}

/**
 * Where one listed file sits on its shelf: `<shelf>/<org__repo>/<path>`, or
 * `<shelf>/<org__repo>/<folder>/<name>` for a file the repo keeps at its root
 * (WeightFile.folder) — the type folder ComfyUI reads it from.
 */
export function weightPath(model: ModalityModel, file: WeightFile): string {
  const dir = entryDir(storeKind(model), file.repo);
  if (file.folder !== undefined && !file.path.includes('/')) {
    return path.join(dir, file.folder, file.path);
  }
  return path.join(dir, file.path);
}

/** Where the store puts a file as downloaded: `<shelf>/<org__repo>/<path>`. */
export function downloadedPath(model: ModalityModel, file: WeightFile): string {
  return path.join(entryDir(storeKind(model), file.repo), file.path);
}

/**
 * A file that arrived some other way — placed by hand in the shelf's own
 * type folder (`Video/Generation/unet/<name>`) — counts: ComfyUI finds it
 * there just the same, and a second copy is 7 GB nobody asked for.
 */
export function weightPresent(model: ModalityModel, file: WeightFile): boolean {
  if (existsSync(weightPath(model, file))) return true;
  const segs = file.path.split('/');
  const folder = file.folder ?? (segs[0] === 'split_files' ? segs[1] : segs[0]);
  const name = path.basename(file.path);
  if (folder === undefined || folder === name) return false;
  const shelf = path.dirname(entryDir(storeKind(model), file.repo));
  return existsSync(path.join(shelf, folder, name));
}

/**
 * Where a model MADE on this Mac lives (`mflux.prepared`): its own folder on
 * the modality's shelf — `Image/Generation/qwen-image-2.1-mflux-4bit-te8` — the
 * folder `mflux-save` wrote and `--model` points at. A local conversion has no
 * repo of its own, so it is not an `<org__repo>` entry; the folder name is the
 * catalog's, which is how a conversion made by hand before this existed is
 * found (the user's Mac, 2026-09-20).
 */
export function preparedDir(model: ModalityModel): string {
  const prepared = model.mflux?.prepared;
  if (prepared === undefined) throw new Error(`${model.id} prepares no weights`);
  const shelf = shelfFor(storeKind(model), { repo: prepared.from });
  return path.join(shelfDir(shelf), prepared.folder);
}

/**
 * The saved model is there when every component mflux wrote is: its shards
 * and their index per component, and the tokenizer. A folder with only some
 * of them is an interrupted save, which the next install redoes.
 */
export const PREPARED_COMPONENTS = ['transformer', 'text_encoder', 'vae'] as const;
export function preparedPresent(model: ModalityModel): boolean {
  if (model.mflux?.prepared === undefined) return false;
  const dir = preparedDir(model);
  return (
    PREPARED_COMPONENTS.every(
      (c) =>
        existsSync(path.join(dir, c, 'model.safetensors.index.json')) &&
        existsSync(path.join(dir, c, '0.safetensors')),
    ) && existsSync(path.join(dir, 'processor', 'tokenizer.json'))
  );
}

/** Every listed file present — or, for a model made here, the conversion. */
export function weightsPresent(model: ModalityModel): boolean {
  if (model.mflux?.prepared !== undefined) return preparedPresent(model);
  return (model.weights ?? []).every((f) => weightPresent(model, f));
}

/** The label, size and blurb of a weights module, from its catalog entry. */
export function weightsMeta(model: ModalityModel): GenModuleMeta {
  const prepared = model.mflux?.prepared;
  if (prepared !== undefined) {
    // What the button costs is the fetch; what stays is smaller, and the
    // card says both so nobody is surprised by either number.
    return {
      label: `${model.label} weights`,
      blurb: `Fetches the ${prepared.downloadGB} GB release from Hugging Face and converts it to a ${prepared.sizeGB} GB ${prepared.bits}-bit MLX model on this Mac, once; the original is removed after. No account needed.`,
      approxGB: prepared.downloadGB,
      noun: model.label,
    };
  }
  const files = model.weights ?? [];
  const bytes = files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  const repos = new Set(files.map((f) => f.repo));
  return {
    label: `${model.label} weights`,
    blurb: `The ${files.length} files this model loads, from ${repos.size} Hugging Face repo${
      repos.size === 1 ? '' : 's'
    } — no account needed.`,
    approxGB: Math.round((bytes / 1e9) * 10) / 10,
    noun: model.label,
  };
}
