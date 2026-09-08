/**
 * The user's desktop picture, in a form the renderer is actually allowed to load.
 *
 * The computer-use monitor draws the controlled window over the real wallpaper,
 * so the tab looks like the desk the app is sitting on rather than a screenshot
 * on a grey card. Getting the picture there takes two steps that are easy to
 * miss:
 *
 *  1. WHERE IT LIVES. `NSWorkspace.desktopImageURL` points into
 *     /System/Library/Desktop Pictures (or the user's Pictures / Photos
 *     library). `pd-file://` fences to the app's OWN working roots, so a URL
 *     pointing straight at the system path is answered with 403 — correctly.
 *     So we copy it into `~/.pi/agent/mac-wallpaper/`, which IS a root (the
 *     same trick org-avatar-main.ts uses for Hugging Face logos).
 *
 *  2. WHAT FORMAT IT IS IN. Modern macOS wallpapers are multi-image HEIC
 *     (light/dark/dynamic). Chromium cannot decode HEIC at all, and a 6000px
 *     original is a lot of bytes to hand a backdrop that gets dimmed anyway.
 *     `sips` — the OS's own codec, offline — converts and downscales in one
 *     pass, so the renderer always gets a plain, modest JPEG.
 *
 * Cached by source path + mtime, so a wallpaper change re-converts and an
 * unchanged one costs nothing after the first read.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:mac-wallpaper');
const execFileAsync = promisify(execFile);

/** Under the pi agent dir, which `allowedWriteRoots()` already serves. */
const CACHE_DIR = path.join(homedir(), '.pi', 'agent', 'mac-wallpaper');

/** Long edge of the cached copy. The backdrop is dimmed and cover-fitted; more
 * than this is bytes nobody sees. */
const MAX_EDGE = 2560;

export interface CachedWallpaper {
  /** The ORIGINAL on-disk path (diagnostics; not loadable by the renderer). */
  source: string;
  /** The converted copy's absolute path. */
  path: string;
  /** `pd-file://` URL the renderer may load. */
  url: string;
}

/** `pd-file://f/<encoded abs path>` — the scheme canvas-main serves. */
function pdFileUrl(abs: string): string {
  return `pd-file://f${abs.split(path.sep).map(encodeURIComponent).join('/')}`;
}

const memo = new Map<string, CachedWallpaper>();

/**
 * Convert + cache a wallpaper, returning the servable URL (null when the path
 * is unusable or `sips` fails — the surface then just paints its own gradient,
 * which is a fine backdrop and never an error the user has to read).
 */
export async function cacheWallpaper(source: string): Promise<CachedWallpaper | null> {
  if (process.platform !== 'darwin') return null;
  const src = source.trim();
  if (src === '') return null;
  let mtimeMs: number;
  try {
    const st = statSync(src);
    if (!st.isFile()) return null;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  const key = `${src}:${mtimeMs}`;
  const hit = memo.get(key);
  if (hit !== undefined && existsSync(hit.path)) return hit;

  const stem = createHash('sha1').update(key).digest('hex').slice(0, 20);
  const out = path.join(CACHE_DIR, `${stem}.jpg`);
  const entry: CachedWallpaper = { source: src, path: out, url: pdFileUrl(out) };
  if (existsSync(out)) {
    memo.set(key, entry);
    return entry;
  }
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    // -Z scales the LONG edge and never upscales; format jpeg flattens the
    // multi-image HEIC to its primary representation.
    await execFileAsync('sips', [
      '-Z',
      String(MAX_EDGE),
      '-s',
      'format',
      'jpeg',
      src,
      '--out',
      out,
    ]);
    if (!existsSync(out)) return null;
    memo.set(key, entry);
    return entry;
  } catch (error) {
    log.warn('wallpaper convert failed', { source: src, error: String(error) });
    return null;
  }
}

/** Test/lifecycle hook. */
export function clearWallpaperCache(): void {
  memo.clear();
}
