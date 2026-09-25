/**
 * The main-process half of ./source-meta: the cache directory under the
 * support root, and the thumbnailer, which needs Electron's image decoder.
 * Kept apart so ./source-meta stays electron-free and unit-tested.
 */
import path from 'node:path';
import { cacheRoot } from '@pi-desktop/inference';
import { app, nativeImage } from 'electron';
import { setFaviconCacheDir } from './favicons';
import type { SourceMetaDeps } from './source-meta';

/** The short side a thumbnail is shrunk to: a 64px cover crop at 2× with room to spare. */
const THUMB_SHORT_SIDE = 160;
/** Anything smaller is a spacer or a tracking pixel, not a picture of the page. */
const MIN_SIDE = 48;

/**
 * Decode a share picture and shrink it for a row. JPEG unless it has
 * transparency — a logo with an alpha channel turned into JPEG sits on black.
 */
function thumbnail(bytes: Buffer): { data: Buffer; type: string } | null {
  const img = nativeImage.createFromBuffer(bytes);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (width < MIN_SIDE || height < MIN_SIDE) return null;
  const scale = Math.min(1, THUMB_SHORT_SIDE / Math.min(width, height));
  const out =
    scale < 1
      ? img.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'good',
        })
      : img;
  const bitmap = out.toBitmap();
  let alpha = false;
  // BGRA; every 7th pixel is plenty to find a transparent region.
  for (let i = 3; i < bitmap.length; i += 28) {
    if ((bitmap[i] ?? 255) < 250) {
      alpha = true;
      break;
    }
  }
  return alpha
    ? { data: out.toPNG(), type: 'image/png' }
    : { data: out.toJPEG(80), type: 'image/jpeg' };
}

let deps: SourceMetaDeps | null = null;

/**
 * The wiring every `canvas:source-meta` call uses; sets up the icon cache once.
 *
 * Kept under the support root beside the app's other caches — except in a
 * probe, which may point the support root at the REAL one for its model
 * weights (`realCache`); its sources stay in its own throwaway profile.
 */
export function sourceMetaDeps(): SourceMetaDeps {
  if (deps !== null) return deps;
  const root =
    process.env.PI_E2E === '1'
      ? path.join(app.getPath('userData'), 'sources')
      : path.join(cacheRoot(), 'sources');
  setFaviconCacheDir(path.join(root, 'icons'));
  deps = { cacheDir: path.join(root, 'pages'), thumbnail };
  return deps;
}
