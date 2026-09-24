/**
 * PUTTING THE HUB LINKS BACK — the migration's inverse, for a 3D cache that
 * lost them.
 *
 * The migration (library-migration.ts) moves each `gen3d/hf/hub/models--Org--Name`
 * onto its library shelf and leaves a symlink at the old spot, and the 3D
 * engine reads its weights through that link. The links live in the support
 * folder and the weights in the library, so the two can come apart: when the
 * engine's cache is recreated (a reset engine, a deleted `~/.cache/bobble/gen3d`
 * — the user's Mac since 2026-09-20), every byte is still on the shelves but the
 * engine sees none of it. Every 3D model reads "not downloaded", and Download
 * fetches again what is already on disk. For Mage-Flow it is worse: the old
 * `microsoft/Mage-Flow-*` copies on the shelves (35 GB on the user's Mac) come
 * from repos that were withdrawn, so without the link they are weights nobody
 * can use and nobody can download again (see gen3d-engine's
 * mage-flow-release.ts, whose `legacyRepos` honour those copies on disk).
 *
 * So at boot, beside the migration, and for every repo the 3D engine's catalog
 * names — its current sources and the legacy ones it still honours:
 *   - when the hub cache has NO entry of that name (not a folder, not a link,
 *     not even a dangling one: anything there is left exactly as it is), and
 *   - a shelf holds that repo's folder in the hub's own layout (a `snapshots/`
 *     folder inside; the model store's plain folders are never linked),
 * the link goes back — relative, exactly as the migration writes it. Nothing
 * is moved, copied, overwritten or deleted.
 */
import { lstatSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { GEN3D_MODEL_SPECS } from '@pi-desktop/gen3d-engine';
import { repoFolderName, SHELVES, shelfDir } from '@pi-desktop/model-store';
import { hubLinkFor } from './library-migration';

/** One link to put back. */
export interface HubRelink {
  readonly repo: string;
  /** The hub entry to create: `<cache>/gen3d/hf/hub/models--Org--Name`. */
  readonly at: string;
  /** The shelf folder it points at. */
  readonly to: string;
}

/** What the planner reads from the disk — injectable for tests. */
export interface HubRelinkProbe {
  /** Is there anything at this path — a dangling link included (lstat)? */
  readonly present: (p: string) => boolean;
  /** Is this a repo folder in the hub layout (a `snapshots/` folder inside)? */
  readonly isHubRepo: (p: string) => boolean;
}

/** What applying writes — injectable for tests. */
export interface HubRelinkWriter {
  readonly mkdirp: (p: string) => void;
  readonly symlink: (target: string, at: string) => void;
}

/**
 * Every repo the 3D engine loads from its hub cache, in the catalog's exact
 * spelling (the hub cache is keyed by it): each model's sources and the
 * legacy repos whose complete copies still count as installed.
 */
export function gen3dHubRepos(): string[] {
  const out: string[] = [];
  for (const m of GEN3D_MODEL_SPECS) {
    for (const r of [...m.repos, ...(m.legacyRepos ?? [])]) {
      if (!out.includes(r.repo)) out.push(r.repo);
    }
  }
  return out;
}

const realProbe: HubRelinkProbe = {
  present: (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
  isHubRepo: (p) => {
    try {
      return statSync(join(p, 'snapshots')).isDirectory();
    } catch {
      return false;
    }
  },
};

const realWriter: HubRelinkWriter = {
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
  symlink: (target, at) => {
    symlinkSync(target, at);
  },
};

/**
 * The links to put back: one per catalog repo whose hub entry is missing and
 * whose folder a shelf holds in the hub layout. `skip` names repos to leave
 * alone (a download in flight owns its paths).
 */
export function planHubRelinks(
  s: {
    readonly cacheRoot: string;
    readonly libraryRoot: string;
    readonly repos: readonly string[];
    readonly skip?: ReadonlySet<string>;
  },
  probe: HubRelinkProbe = realProbe,
): HubRelink[] {
  const out: HubRelink[] = [];
  const seen = new Set<string>();
  for (const repo of s.repos) {
    // One folder per repo whatever its spelling (the shelves are lowercase,
    // and macOS folds case anyway).
    const folder = repoFolderName(repo);
    if (seen.has(folder)) continue;
    seen.add(folder);
    if (s.skip?.has(repo) === true) continue;
    const at = hubLinkFor(s.cacheRoot, repo);
    if (probe.present(at)) continue;
    const to = SHELVES.map((shelf) => join(shelfDir(shelf, s.libraryRoot), folder)).find((p) =>
      probe.isHubRepo(p),
    );
    if (to === undefined) continue;
    out.push({ repo, at, to });
  }
  return out;
}

/** Create the links. Each is independent: one that fails is reported and the rest go on. */
export function applyHubRelinks(
  plan: readonly HubRelink[],
  write: HubRelinkWriter = realWriter,
): { linked: HubRelink[]; failed: { relink: HubRelink; why: string }[] } {
  const linked: HubRelink[] = [];
  const failed: { relink: HubRelink; why: string }[] = [];
  for (const r of plan) {
    try {
      write.mkdirp(dirname(r.at));
      // Relative, the same spelling the migration leaves behind.
      write.symlink(relative(dirname(r.at), r.to), r.at);
      linked.push(r);
    } catch (err) {
      const code = (err as { code?: string }).code;
      failed.push({ relink: r, why: code ?? String(err) });
    }
  }
  return { linked, failed };
}

/** Plan and apply against the real disk. */
export function relinkShelvedHubRepos(
  cacheRoot: string,
  libraryRoot: string,
  skip: ReadonlySet<string> = new Set(),
): ReturnType<typeof applyHubRelinks> {
  const plan = planHubRelinks({ cacheRoot, libraryRoot, repos: gen3dHubRepos(), skip });
  return applyHubRelinks(plan);
}

/**
 * The boot path (storage-main's runLibraryMigration): relink, and say what was
 * done. Never throws — a link that cannot be checked must not cost the boot
 * its migration.
 */
export function relinkAtBoot(
  cacheRoot: string,
  libraryRoot: string,
  skip: ReadonlySet<string>,
  log: {
    readonly info: (msg: string, data: Record<string, unknown>) => void;
    readonly warn: (msg: string, data: Record<string, unknown>) => void;
  },
): void {
  try {
    const { linked, failed } = relinkShelvedHubRepos(cacheRoot, libraryRoot, skip);
    for (const r of linked) log.info('hub link put back', { repo: r.repo, to: r.to });
    for (const f of failed) log.warn('hub link not put back', { repo: f.relink.repo, why: f.why });
  } catch (err) {
    log.warn('hub links not checked', { error: String(err) });
  }
}
