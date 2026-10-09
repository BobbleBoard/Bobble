/**
 * WHAT A PASTED OR DROPPED THING IS ON DISK — and a file for pixels that never
 * had one.
 *
 * The user (2026-09-24): "why not handle this natively so that any image(s)/files/
 * folders... can be pasted into the input box".
 *
 * The composer holds the Files of a paste or a drop and, through webUtils, the
 * path each one has. Two questions only main can answer about them:
 *
 *  - WHAT A PATH IS. A folder arrives as a File like any other, and nothing in
 *    the renderer can tell it from an empty file short of reading it — which
 *    fails. One stat each says folder or file, and how big.
 *  - WHERE PIXELS LIVE. A screenshot, a card's Copy, a browser's "Copy Image"
 *    are pixels with no file behind them, and a picture with no file cannot be
 *    opened in the viewer, edited, exported, shown in Finder or named to the
 *    model. So they are written ONCE into ~/Bobble/attachments, named by their
 *    content hash: the same picture pasted twice is one file, and an old
 *    message's picture opened a second time finds the file the first made.
 *
 * AND ONE FOR THE VIEWER. The pictures a person hands the app live where THEY
 * keep them — a Desktop, Downloads — outside the folders pd-file:// serves
 * (fs-handlers allowedWriteRoots). The viewer draws through pd-file://, so the
 * picture in your own message opened as a 403. A picture the person OPENS is
 * handed to the scheme one file at a time ({@link isHandedFile}), in answer to
 * that click and nothing else, and only if it is a picture; the fence keeps
 * refusing the rest of their disk. That fence exists for the sandboxed canvas
 * frame, which renders what a model wrote — it can reach a handed file only by
 * naming its path, and the model already had that path (it is in the message).
 *
 * Nothing here reads the pasteboard. The paths come from the paste event the
 * renderer already has (see composer/paste-files.ts for why that is enough).
 */
import { createHash } from 'node:crypto';
import {
  type Dir,
  existsSync,
  opendirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { bobbleDir } from '../bobble-paths';
import {
  type AttachmentsInvokeMap,
  FOLDER_COUNT_CAP,
  type InspectedPath,
} from './attachments-contract';

/** Where pixels with no file of their own are kept: `~/Bobble/attachments`. */
export const ATTACHMENTS_DIR = 'attachments';

/** The picture types a data URL is accepted as, and the extension each is saved with. */
const IMAGE_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** What the viewer can open: pd-file:// serves these (HEIC transcoded). */
const VIEWABLE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;

/** A pasted picture larger than this is refused rather than written. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** A paste of more paths than this is not a paste, it is a mistake. */
const MAX_PATHS = 200;

/** Visible items in a folder, counted up to the cap (a bounded read, not a walk). */
function countEntries(dir: string): number | undefined {
  let handle: Dir | undefined;
  try {
    handle = opendirSync(dir);
    let n = 0;
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entry.name.startsWith('.')) continue;
      n += 1;
      if (n >= FOLDER_COUNT_CAP) break;
    }
    return n;
  } catch {
    return undefined;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      /* already closed */
    }
  }
}

/** Folder or file, and how big, for each path. Never throws. */
export function inspectPaths(paths: readonly string[]): InspectedPath[] {
  return paths.slice(0, MAX_PATHS).map((p): InspectedPath => {
    const name = typeof p === 'string' ? path.basename(p) : '';
    if (typeof p !== 'string' || !path.isAbsolute(p))
      return { path: String(p), name, kind: 'missing' };
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        const entries = countEntries(p);
        return { path: p, name, kind: 'folder', ...(entries !== undefined ? { entries } : {}) };
      }
      if (st.isFile()) return { path: p, name, kind: 'file', bytes: st.size };
    } catch {
      /* gone, or not ours to read */
    }
    // A socket, a device, a path that is not there: nothing to attach.
    return { path: p, name, kind: 'missing' };
  });
}

export type SaveImageResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly error: string };

/**
 * Write a picture's pixels to `~/Bobble/attachments/image-<hash>.<ext>` — once.
 *
 * The name IS the content (the first 12 hex of its SHA-256), so a second paste
 * of the same picture, or a second look at an old message's, lands on the file
 * the first one wrote instead of making another. Written to a temp name and
 * renamed, so nothing can ever see half a picture under the real name.
 */
export function saveImage(dataUrl: string, home: string = homedir()): SaveImageResult {
  if (typeof dataUrl !== 'string') return { ok: false, error: 'not a data URL' };
  const head = /^data:([^;,]+)((?:;[^;,]*)*),/.exec(dataUrl);
  if (head === null || !(head[2] ?? '').includes(';base64')) {
    return { ok: false, error: 'not a base64 data URL' };
  }
  const mime = (head[1] ?? '').toLowerCase();
  const ext = IMAGE_EXT[mime];
  if (ext === undefined) return { ok: false, error: `not a picture (${mime})` };
  const bytes = Buffer.from(dataUrl.slice(head[0].length), 'base64');
  if (bytes.length === 0) return { ok: false, error: 'the picture is empty' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: 'the picture is too large' };
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  try {
    const dir = bobbleDir(ATTACHMENTS_DIR, home);
    const file = path.join(dir, `image-${hash}.${ext}`);
    // Same name, same size: the same picture. (A file someone edited in place
    // since is written over — the name promises these bytes.)
    const there = existsSync(file) ? statSync(file) : null;
    if (there === null || !there.isFile() || there.size !== bytes.length) {
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
    }
    return { ok: true, path: file, bytes: bytes.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Real paths of pictures the person opened, which pd-file:// may serve. */
const handed = new Set<string>();

/** Whether pd-file:// may serve this (realpath'd) file though it is outside every root. */
export function isHandedFile(real: string): boolean {
  return handed.has(real);
}

/**
 * The file the viewer should open for a picture: its own, when it still has
 * one, else its pixels saved (see {@link saveImage}).
 *
 * Its own file is handed to pd-file:// here — a picture, that exists, that the
 * person just clicked on. Anything else falls to the pixels, which is also how
 * a picture whose file has since been moved or deleted still opens.
 */
export function openForViewing(
  req: { path?: string; dataUrl?: string },
  home: string = homedir(),
): { ok: boolean; path?: string; error?: string } {
  const p = req.path;
  if (typeof p === 'string' && path.isAbsolute(p) && VIEWABLE.test(p)) {
    try {
      const real = realpathSync(p);
      if (statSync(real).isFile()) {
        handed.add(real);
        return { ok: true, path: p };
      }
    } catch {
      /* moved or deleted since: the pixels below still open */
    }
  }
  if (typeof req.dataUrl === 'string' && req.dataUrl !== '') {
    const saved = saveImage(req.dataUrl, home);
    return saved.ok ? { ok: true, path: saved.path } : { ok: false, error: saved.error };
  }
  return { ok: false, error: 'the picture is not on disk any more' };
}

/** The channel implementations, registered in main.ts like the fs ones. */
export const attachmentsHandlers: {
  [K in keyof AttachmentsInvokeMap]: (
    req: AttachmentsInvokeMap[K]['request'],
  ) => AttachmentsInvokeMap[K]['response'];
} = {
  'attachments:inspect': (req) => ({
    items: inspectPaths(Array.isArray(req?.paths) ? req.paths : []),
  }),
  'attachments:save-image': (req) => {
    const saved = saveImage(req?.dataUrl ?? '');
    return saved.ok ? { ok: true, path: saved.path, bytes: saved.bytes } : saved;
  },
  'attachments:view-image': (req) => openForViewing(req ?? {}),
};
