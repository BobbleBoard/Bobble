/**
 * WHAT A PASTED OR DROPPED FILE BECOMES IN THE COMPOSER.
 *
 * the user (2026-09-24): "why not handle this natively so that any image(s)/files/
 * folders... can be pasted into the input box". The composer took two kinds of
 * thing — a picture (read into a data URI, with no file behind it) and a small
 * text file (read into the prompt) — and turned everything else away into a
 * "skipped" note: a PDF, a zip, a spreadsheet, a folder, a text file over the
 * size limit. For drops and pastes alike.
 *
 * Nearly all of those ARE files, at a real path, and the model has tools that
 * can open a file at a path. So now:
 *
 *   a picture          pixels for the model's eyes, AND its path
 *   a text file        folded into the prompt as before, AND its path
 *   anything else      a reference — its path, what it is and how big
 *   a folder           a reference — its path
 *
 * Pixels with no file behind them (a screenshot, a card's Copy, a browser's
 * "Copy Image") are the one case with no path to give; the composer has main
 * save them once (attachments-main.ts) and they are a picture WITH a path from
 * then on. What is left to skip is only what is not on this Mac at all.
 *
 * Pure: the File and what main found at its path go in, a decision comes out.
 */

/** Text files we fold into the prompt (by MIME or extension). */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'rst',
  'json',
  'jsonc',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'log',
  'gitignore',
  'dockerfile',
  'makefile',
  'gradle',
  'properties',
]);

/**
 * The most text we fold into a prompt (256 KB). A larger text file is still
 * attached — by path, for the model's own tools to read — rather than skipped.
 */
export const TEXT_MAX_BYTES = 256 * 1024;

/** Pictures by extension, for a File whose MIME the OS left blank. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;

/** The part of a `File` this decides on — so it can be tested without a DOM. */
export interface IncomingFile {
  readonly name: string;
  /** The MIME the browser gave it ('' when it had none). */
  readonly type: string;
  readonly size: number;
}

export function isTextFile(file: IncomingFile): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : file.name.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function isImageFile(file: IncomingFile): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

/** What main found at a path (`attachments:inspect`), or null when nothing was asked. */
export interface OnDisk {
  readonly kind: 'file' | 'folder' | 'missing';
  readonly bytes?: number;
}

/**
 * How one incoming File attaches.
 *
 *  - `image` `save`: pixels with no file — save them, then attach with that path
 *  - `image`: a picture file — read its pixels, attach with its own path
 *  - `text`: fold its contents in (with its path, when it has one)
 *  - `file` / `folder`: a reference by path, nothing read
 *  - `skip`: not a file on this Mac, and not pixels either
 */
export type AttachPlan =
  | { readonly as: 'image'; readonly save: boolean }
  | { readonly as: 'text' }
  | { readonly as: 'file' }
  | { readonly as: 'folder' }
  | { readonly as: 'skip' };

export function attachPlan(file: IncomingFile, path: string, disk: OnDisk | null): AttachPlan {
  if (path === '') {
    // Nothing on disk: only what can be carried whole makes it.
    if (isImageFile(file)) return { as: 'image', save: true };
    if (isTextFile(file) && file.size <= TEXT_MAX_BYTES) return { as: 'text' };
    return { as: 'skip' };
  }
  // A path the OS gave us that is not there any more (or never was readable).
  if (disk === null || disk.kind === 'missing') return { as: 'skip' };
  // Checked before anything reads the File: a folder cannot be read, only named.
  if (disk.kind === 'folder') return { as: 'folder' };
  if (isImageFile(file)) return { as: 'image', save: false };
  const bytes = disk.bytes ?? file.size;
  if (isTextFile(file) && bytes <= TEXT_MAX_BYTES) return { as: 'text' };
  return { as: 'file' };
}
