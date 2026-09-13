/**
 * MOVING THE MODELS OUT OF `~/.cache` AND ONTO THE SHELVES — once, at boot,
 * by renaming, with every engine still able to find its weights.
 *
 * the user (2026-09-12): "all models and such are dumped in .cache … there is
 * currently 557gb in .cache." The library's shape is in
 * @pi-desktop/model-store's library.ts; this is how an existing machine gets
 * there.
 *
 * THREE RULES.
 *
 *  1. RENAME, NEVER COPY. Everything here is `fs.rename` of a directory or a
 *     file on the same volume — instant for 400 GB, and atomic per item. A
 *     library on another volume (EXDEV) is left where it is and reported; the
 *     path helpers read the legacy location as long as it exists, so nothing
 *     breaks by being skipped.
 *
 *  2. THE ENGINES KEEP THEIR VIEW. The Python workers load by repo id through
 *     a Hugging Face hub cache — so each `models--org--name` that moves to a
 *     shelf leaves a SYMLINK behind at the old spot, and the hub cache keeps
 *     working untouched (its snapshot links are relative, inside the repo
 *     dir, so they move with it). ComfyUI reads type folders (`unet/`, `vae/`)
 *     from every shelf through its extra-model-paths file, rewritten per
 *     shelf. GGUFs and MLX twins are resolved by our own path helpers, which
 *     look on the shelf first.
 *
 *  3. NEVER GUESS. A file the classifier cannot place goes to `Unsorted/`,
 *     visibly, rather than to a shelf it might not belong on — and the
 *     Manage Storage page says so.
 *
 * Idempotent: a source that no longer exists (or is already the symlink we
 * left) is skipped; a target that already exists is never overwritten.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Shelf } from '@pi-desktop/model-store';
import { hubEntryName, repoFolderName, repoFromHubEntry } from '@pi-desktop/model-store';

export interface MigrationMove {
  /** What it is, for the log and the page. */
  readonly kind: 'gguf' | 'mlx' | 'comfy' | 'hub' | 'gen3d-model' | 'omnisvg';
  readonly from: string;
  readonly to: string;
  /** Leave a symlink at `from` → `to` after the move (engines that read there). */
  readonly linkBack: boolean;
  readonly shelf: Shelf;
}

export interface MigrationPlan {
  readonly moves: readonly MigrationMove[];
  /** Files the classifier could not place; they still move, to Unsorted. */
  readonly unsorted: readonly string[];
}

export interface MigrationResult {
  readonly moved: readonly MigrationMove[];
  readonly skipped: readonly { move: MigrationMove; why: string }[];
}

/** ComfyUI's type folders, as the legacy store spelled them. */
export const COMFY_TYPE_DIRS = [
  'checkpoints',
  'diffusion_models',
  'unet',
  'vae',
  'clip',
  'clip_vision',
  'text_encoders',
  'audio_encoders',
  'loras',
  'controlnet',
  'upscale_models',
  'latent_upscale_models',
] as const;

/**
 * Which shelf a ComfyUI weight belongs on, from its file name. The names come
 * from the studios' own templates (packages/gen-service/src/comfy-workflow.ts)
 * and the catalog; anything not listed is honestly Unsorted.
 */
export function comfyShelfFor(fileName: string): Shelf {
  const f = fileName.toLowerCase();
  if (/ltx|minimax[-_]h3|wan[-_]?2|umt5|qwen3vl.*minimax|hunyuan.*video|cosmos|mochi/.test(f)) {
    return 'Video/Generation';
  }
  if (/stable[-_]audio[-_]open|_sfx|sfx_|foley|dasheng|thinksound/.test(f)) return 'Audio/SFX';
  if (
    /ace[-_]?step|ace[-_]1\.5|ace15|minimax[-_]music|stable[-_]audio|t5gemma|musicgen|yue/.test(f)
  ) {
    return 'Audio/Music';
  }
  if (/tts|speech|voice|kokoro/.test(f)) return 'Audio/Speech';
  if (/flux.*(kontext|fill)|inpaint|edit/.test(f)) return 'Image/Editing';
  if (
    /flux|sd[-_]?xl|sd3|stable[-_]diffusion|qwen[-_]image|krea|hidream|lumina|pixart|cosmos.*image/.test(
      f,
    )
  ) {
    return 'Image/Generation';
  }
  return 'Unsorted';
}

/**
 * Which shelf a Hugging Face repo from the Python workers' cache belongs on.
 * The 3D engine's registry names which feature each repo serves; the rest is
 * the repo name.
 */
export function hubShelfFor(repo: string, registryFeature?: string): Shelf {
  const r = repo.toLowerCase();
  // Support models first: a vision backbone or an embedder serves several
  // features and belongs to none of them.
  if (
    /dinov[23]|birefnet|rmbg|llm2vec|meta-llama-3-8b-instruct$|qwen3-vl|clip-vit|siglip|t5-v1_1|bert/.test(
      r,
    )
  ) {
    return 'Support';
  }
  switch (registryFeature) {
    case 'trellis2':
    case 'cubepart':
      return '3D/Generation';
    case 'skintokens':
    case 'humanoid-rig':
      return '3D/Rigging';
    case 'ardy-motion':
      return '3D/Motion';
    case 'mageflow':
      return 'Image/Generation';
    case 'mageflow-edit':
      return 'Image/Editing';
    case 'parakeet-asr':
      return 'Audio/Transcription';
    case 'fluid-1-cleanup':
    case 'qwen3-tts':
      return 'Audio/Speech';
    case 'dasheng-sfx':
      return 'Audio/SFX';
    default:
      break;
  }
  if (/trellis|cubepart|hunyuan3d|pixal3d|triposr|sam-3d/.test(r)) return '3D/Generation';
  if (/skintoken/.test(r)) return '3D/Rigging';
  if (/ardy|motion/.test(r)) return '3D/Motion';
  if (/mage-flow-edit|kontext|image-edit/.test(r)) return 'Image/Editing';
  if (/mage-flow|qwen-image|krea|flux|stable-diffusion|sdxl/.test(r)) return 'Image/Generation';
  if (/parakeet|whisper|asr/.test(r)) return 'Audio/Transcription';
  if (/tts|fluid/.test(r)) return 'Audio/Speech';
  if (/dasheng|thinksound|sfx|audiogen/.test(r)) return 'Audio/SFX';
  if (/music|ace-step/.test(r)) return 'Audio/Music';
  // A hub-cached chat model (the enhancer's, a drafter another engine fetched)
  // is not a catalog entry: it stays out of the LLM shelf, which is keyed by
  // catalog id, and lives with the other models-that-serve-models.
  if (/qwen|llama|gemma|mistral|phi|dflash|dspark/.test(r)) return 'Support';
  return 'Unsorted';
}

/** The legacy tree as the planner sees it — injectable for tests. */
export interface LegacySnapshot {
  readonly cacheRoot: string;
  readonly libraryRoot: string;
  /** `<cache>/models/<id>` directories. */
  readonly ggufIds: readonly string[];
  /** `<cache>/store/text/<slug>` directories. */
  readonly mlxSlugs: readonly string[];
  /** `<cache>/store/<type>/<file>` files, by type. */
  readonly comfyFiles: Readonly<Record<string, readonly string[]>>;
  /** `models--org--name` directories in the workers' hub cache (real dirs only). */
  readonly hubEntries: readonly string[];
  /** repo → the 3D engine registry feature that lists it. */
  readonly hubFeatureByRepo: Readonly<Record<string, string>>;
  /** `<cache>/gen3d/models/<name>` directories (real dirs only). */
  readonly gen3dModels: readonly string[];
  /** `<cache>/omnisvg/<sub>` present, of gguf / hf / hf-checkpoint (real dirs only). */
  readonly omnisvgSubdirs: readonly string[];
}

export function planLibraryMigration(s: LegacySnapshot): MigrationPlan {
  const moves: MigrationMove[] = [];
  const unsorted: string[] = [];
  const lib = (shelf: Shelf, ...rest: string[]) =>
    join(s.libraryRoot, ...shelf.split('/'), ...rest);

  for (const id of s.ggufIds) {
    moves.push({
      kind: 'gguf',
      from: join(s.cacheRoot, 'models', id),
      to: lib('LLM', id),
      linkBack: false,
      shelf: 'LLM',
    });
  }
  for (const slug of s.mlxSlugs) {
    moves.push({
      kind: 'mlx',
      from: join(s.cacheRoot, 'store', 'text', slug),
      to: lib('LLM/MLX', slug),
      linkBack: false,
      shelf: 'LLM/MLX',
    });
  }
  for (const [type, files] of Object.entries(s.comfyFiles)) {
    for (const file of files) {
      const shelf = comfyShelfFor(file);
      if (shelf === 'Unsorted') unsorted.push(join(type, file));
      moves.push({
        kind: 'comfy',
        from: join(s.cacheRoot, 'store', type, file),
        to: lib(shelf, type, file),
        linkBack: false,
        shelf,
      });
    }
  }
  for (const entry of s.hubEntries) {
    const repo = repoFromHubEntry(entry);
    if (repo === null) continue;
    const shelf = hubShelfFor(repo, s.hubFeatureByRepo[repo]);
    if (shelf === 'Unsorted') unsorted.push(entry);
    moves.push({
      kind: 'hub',
      from: join(s.cacheRoot, 'gen3d', 'hf', 'hub', entry),
      to: lib(shelf, repoFolderName(repo)),
      linkBack: true,
      shelf,
    });
  }
  for (const name of s.gen3dModels) {
    moves.push({
      kind: 'gen3d-model',
      from: join(s.cacheRoot, 'gen3d', 'models', name),
      to: lib('3D/Generation', name),
      linkBack: true,
      shelf: '3D/Generation',
    });
  }
  for (const sub of s.omnisvgSubdirs) {
    moves.push({
      kind: 'omnisvg',
      from: join(s.cacheRoot, 'omnisvg', sub),
      to: lib('Image/Vector', 'OmniSVG', sub),
      linkBack: true,
      shelf: 'Image/Vector',
    });
  }
  return { moves, unsorted };
}

/** Read the legacy tree. Symlinks are not candidates: they are the trail of a move already made. */
export function snapshotLegacy(cacheRoot: string, libraryRoot: string): LegacySnapshot {
  const realDirs = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((n) => {
        try {
          return !n.startsWith('.') && lstatSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  };
  const realFiles = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((n) => {
        try {
          return !n.startsWith('.') && lstatSync(join(dir, n)).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  };
  const comfyFiles: Record<string, string[]> = {};
  for (const type of COMFY_TYPE_DIRS) {
    const files = realFiles(join(cacheRoot, 'store', type));
    if (files.length > 0) comfyFiles[type] = files;
  }
  const hubFeatureByRepo: Record<string, string> = {};
  try {
    const reg = JSON.parse(readFileSync(join(cacheRoot, 'gen3d', 'registry.json'), 'utf8')) as {
      models?: { id?: string; repos?: { repo?: string }[] }[];
    };
    for (const m of reg.models ?? []) {
      for (const r of m.repos ?? []) {
        if (
          typeof r.repo === 'string' &&
          typeof m.id === 'string' &&
          hubFeatureByRepo[r.repo] === undefined
        ) {
          hubFeatureByRepo[r.repo] = m.id;
        }
      }
    }
  } catch {
    /* no registry — the name decides */
  }
  return {
    cacheRoot,
    libraryRoot,
    ggufIds: realDirs(join(cacheRoot, 'models')),
    mlxSlugs: realDirs(join(cacheRoot, 'store', 'text')),
    comfyFiles,
    hubEntries: realDirs(join(cacheRoot, 'gen3d', 'hf', 'hub')).filter((n) =>
      n.startsWith('models--'),
    ),
    hubFeatureByRepo,
    gen3dModels: realDirs(join(cacheRoot, 'gen3d', 'models')),
    omnisvgSubdirs: ['gguf', 'hf', 'hf-checkpoint'].filter((sub) => {
      try {
        return lstatSync(join(cacheRoot, 'omnisvg', sub)).isDirectory();
      } catch {
        return false;
      }
    }),
  };
}

/**
 * Do the moves. Each is independent: one that fails (a target already there,
 * another volume, a permission) is reported and the rest go on. Injectable fs
 * for tests.
 */
export function applyLibraryMigration(
  plan: MigrationPlan,
  fs: {
    readonly exists: (p: string) => boolean;
    readonly isSymlink: (p: string) => boolean;
    readonly mkdirp: (p: string) => void;
    readonly rename: (from: string, to: string) => void;
    readonly symlink: (target: string, at: string) => void;
  } = realFs,
): MigrationResult {
  const moved: MigrationMove[] = [];
  const skipped: { move: MigrationMove; why: string }[] = [];
  for (const move of plan.moves) {
    if (!fs.exists(move.from)) {
      skipped.push({ move, why: 'gone' });
      continue;
    }
    if (fs.isSymlink(move.from)) {
      skipped.push({ move, why: 'already a link' });
      continue;
    }
    if (fs.exists(move.to)) {
      skipped.push({ move, why: 'target exists' });
      continue;
    }
    try {
      fs.mkdirp(dirname(move.to));
      fs.rename(move.from, move.to);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      skipped.push({ move, why: code === 'EXDEV' ? 'other volume' : code || String(err) });
      continue;
    }
    if (move.linkBack) {
      try {
        // Relative, so the pair survives the whole tree being moved together.
        fs.symlink(relative(dirname(move.from), move.to), move.from);
      } catch (err) {
        skipped.push({ move, why: `moved, but no link back: ${String(err)}` });
        continue;
      }
    }
    moved.push(move);
  }
  return { moved, skipped };
}

const realFs = {
  exists: (p: string) => existsSync(p),
  isSymlink: (p: string) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  mkdirp: (p: string) => {
    mkdirSync(p, { recursive: true });
  },
  rename: (from: string, to: string) => {
    renameSync(from, to);
  },
  symlink: (target: string, at: string) => {
    symlinkSync(target, at);
  },
};

/** The hub-cache spelling a repo will have once adopted, for callers that link new downloads. */
export function hubLinkFor(cacheRoot: string, repo: string): string {
  return join(cacheRoot, 'gen3d', 'hf', 'hub', hubEntryName(repo));
}
