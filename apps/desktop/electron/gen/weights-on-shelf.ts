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
import { entryDir, type ModelKind } from '@pi-desktop/model-store';
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

/** Every listed file present. */
export function weightsPresent(model: ModalityModel): boolean {
  return (model.weights ?? []).every((f) => weightPresent(model, f));
}

/** The label, size and blurb of a weights module, from its catalog entry. */
export function weightsMeta(model: ModalityModel): GenModuleMeta {
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
