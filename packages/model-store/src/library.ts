/**
 * THE MODEL LIBRARY — a folder tree a person can open, sorted the way the app
 * is.
 *
 * The user (2026-09-12): "all models and such are dumped in .cache … a lot of
 * people complain about how some apps like lmstudio really obscure where they
 * hide their data, chats, models etc. so let's not be like that, can we manage
 * them ourselves and sort them in filesystem similarly to how their access is
 * sorted in the interface, eg. seperate modalities, llms, and then seperate
 * also audio,video,3d,image, further split below eg. editing vs generation on
 * image and video and hopefully soon 3d, audio sfx/music/tts."
 *
 * What was there: ~400 GB under `~/.cache/pi-desktop` in the shapes the ENGINES
 * wanted — GGUFs by catalog id, MLX twins in a store keyed by repo slug,
 * ComfyUI's weights in its `unet/` `vae/` `text_encoders/` folders, everything
 * the Python workers load in a Hugging Face hub cache (`models--org--name`),
 * OmniSVG in a folder of its own. Nobody could open Finder and see what they
 * had.
 *
 * THE TREE. One visible root, `~/Bobble/Models`, and under it the SHELVES —
 * the sidebar's own order, then the split each modality needs:
 *
 *   LLM/                  chat models: <catalog id>/ (GGUF + drafters + mmproj)
 *   LLM/MLX/              their MLX twins and MTP heads, by repo slug
 *   Image/Generation      Image/Editing      Image/Vector (OmniSVG)
 *   Video/Generation      Video/Editing
 *   3D/Generation         3D/Rigging         3D/Motion
 *   Audio/Music           Audio/SFX          Audio/Speech       Audio/Transcription
 *   Support/              models other models need (a vision encoder, a
 *                         background remover, a text embedder)
 *
 * WHAT STAYS ENGINE-SHAPED INSIDE A SHELF. A shelf holds what the engine can
 * load: a Hugging Face repo keeps its `snapshots/` layout (the workers load by
 * repo id through a hub cache whose entries are symlinks INTO the shelves —
 * see library-hub.ts), and ComfyUI's weights sit in its type folders
 * (`Video/Generation/unet/…`, one extra-model-paths entry per shelf). The
 * folder a person opens is sorted by what the model MAKES; the file inside is
 * whatever the engine needs it to be.
 *
 * WHAT DOES NOT MOVE. Engines, venvs, tool binaries and scratch stay under
 * the support root (`~/.cache/pi-desktop`): a Python venv bakes absolute paths
 * into every script it installs, so moving one breaks every engine at once,
 * and all of it is re-creatable tooling rather than something a person wants
 * to browse. The Manage Storage page shows it beside the library, with its
 * size and a Reveal, so nothing is hidden — it is just not in the library.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelKind } from './layout.js';
import type { ModelTask } from './manifest.js';

/** A shelf: a modality folder, and the split under it. Paths use `/`. */
export type Shelf =
  | 'LLM'
  | 'LLM/MLX'
  | 'Image/Generation'
  | 'Image/Editing'
  | 'Image/Vector'
  | 'Video/Generation'
  | 'Video/Editing'
  | '3D/Generation'
  | '3D/Rigging'
  | '3D/Motion'
  | 'Audio/Music'
  | 'Audio/SFX'
  | 'Audio/Speech'
  | 'Audio/Transcription'
  | 'Support'
  | 'Unsorted';

/** Every shelf, in the order the sidebar lists the modalities. */
export const SHELVES: readonly Shelf[] = [
  'LLM',
  'LLM/MLX',
  'Image/Generation',
  'Image/Editing',
  'Image/Vector',
  'Video/Generation',
  'Video/Editing',
  '3D/Generation',
  '3D/Rigging',
  '3D/Motion',
  'Audio/Music',
  'Audio/SFX',
  'Audio/Speech',
  'Audio/Transcription',
  'Support',
  'Unsorted',
];

/** The top-level folders, in sidebar order, with what each is for. */
export const MODALITY_FOLDERS: readonly { folder: string; label: string; blurb: string }[] = [
  { folder: 'LLM', label: 'LLM', blurb: 'Chat models — GGUF for llama.cpp, MLX twins beside them' },
  { folder: 'Image', label: 'Image', blurb: 'Generation, editing, and vector (SVG)' },
  { folder: 'Video', label: 'Video', blurb: 'Generation and editing' },
  { folder: '3D', label: '3D', blurb: 'Generation, rigging, motion' },
  { folder: 'Audio', label: 'Audio', blurb: 'Music, SFX, speech, transcription' },
  {
    folder: 'Support',
    label: 'Support',
    blurb: 'Models other models need — encoders, embedders, background removal',
  },
  {
    folder: 'Unsorted',
    label: 'Unsorted',
    blurb: 'Weights the migration could not place — kept, never guessed at',
  },
];

/**
 * Root of the library. `PI_DESKTOP_MODELS_DIR` overrides it (the app sets it
 * from the storage setting before anything reads a path; probes point it at
 * the real library while keeping a throwaway HOME).
 */
export function libraryRoot(): string {
  const override = process.env.PI_DESKTOP_MODELS_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), 'Bobble', 'Models');
}

/** The default location, for the settings page to say what "default" means. */
export function defaultLibraryRoot(home: string = homedir()): string {
  return join(home, 'Bobble', 'Models');
}

export function shelfDir(shelf: Shelf, root: string = libraryRoot()): string {
  return join(root, ...shelf.split('/'));
}

/** The shelf a model belongs on, from what it makes and how. */
export function shelfFor(
  kind: ModelKind,
  opts: {
    readonly tasks?: readonly ModelTask[];
    readonly family?: string;
    readonly repo?: string;
  } = {},
): Shelf {
  const tasks = opts.tasks ?? [];
  const has = (t: ModelTask) => tasks.includes(t);
  const name = `${opts.family ?? ''} ${opts.repo ?? ''}`.toLowerCase();
  switch (kind) {
    case 'text':
      return 'LLM';
    case 'image':
      if (has('image-to-image') && !has('text-to-image')) return 'Image/Editing';
      if (/edit|inpaint|kontext/.test(name)) return 'Image/Editing';
      if (/svg|vector|omnisvg/.test(name)) return 'Image/Vector';
      return 'Image/Generation';
    case 'video':
      if (has('video-to-video') && !has('text-to-video') && !has('image-to-video')) {
        return 'Video/Editing';
      }
      return 'Video/Generation';
    case 'audio':
      if (has('text-to-speech') || /tts|speech|voice/.test(name)) return 'Audio/Speech';
      if (/asr|whisper|parakeet|transcri|stt/.test(name)) return 'Audio/Transcription';
      if (/sfx|sound|foley|dasheng|thinksound|fluid/.test(name)) return 'Audio/SFX';
      return 'Audio/Music';
    case '3d':
      if (has('text-to-motion') || /motion|ardy/.test(name)) return '3D/Motion';
      if (/skintoken|rig|remesh|mesh/.test(name)) return '3D/Rigging';
      return '3D/Generation';
    default:
      return 'Support';
  }
}

/**
 * A repo's folder on a shelf: `org__name`, the same spelling the store uses,
 * so a directory still reads as the repo it came from.
 */
export function repoFolderName(repo: string): string {
  return repo
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\//g, '__')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The Hugging Face hub cache spelling of a repo dir: `models--org--name`. */
export function hubEntryName(repo: string): string {
  return `models--${repo.trim().replace(/\//g, '--')}`;
}

/** Back from `models--org--name` to `org/name`; null for anything else. */
export function repoFromHubEntry(dirName: string): string | null {
  if (!dirName.startsWith('models--')) return null;
  return dirName.slice('models--'.length).replace(/--/g, '/');
}

/**
 * Prefer the library location; fall back to the legacy one while it still
 * holds the files (a cache not yet migrated, a probe pointed at the old tree).
 */
export function preferExisting(libraryPath: string, legacyPath: string): string {
  if (existsSync(libraryPath)) return libraryPath;
  if (existsSync(legacyPath)) return legacyPath;
  return libraryPath;
}

/** A path under the library, split into `[shelf, ...rest]` for display. */
export function shelfOf(path: string, root: string = libraryRoot()): Shelf | null {
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^\/+/, '') : null;
  if (rel === null) return null;
  const parts = rel.split('/');
  const two = `${parts[0]}/${parts[1]}`;
  if ((SHELVES as readonly string[]).includes(two)) return two as Shelf;
  if ((SHELVES as readonly string[]).includes(parts[0] ?? '')) return parts[0] as Shelf;
  return null;
}
