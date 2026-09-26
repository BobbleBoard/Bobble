/**
 * A PRESENTED PAGE, PHOTOGRAPHED AS IT ACTUALLY LOADS — the look `present`
 * hands the model at the page it wrote.
 *
 * It used to load a `data:` stub whose meta refresh pointed at the `file://`
 * page, wait 600 ms and capture. Chromium does not let a `data:` document
 * navigate to a local file, so every capture was the blank stub. MEASURED
 * 2026-09-25 (the visual suite, 4B, website task): the model was told twice
 * that its page was "a blank/white page" while the canvas showed it whole,
 * and it went on "fixing" a page that worked — swapping its photos for inline
 * SVG placeholders.
 *
 * So the window loads the file itself, waits for its images and web fonts —
 * never longer than `waitMs`, a page whose remote picture hangs is still
 * photographed — and captures at the size asked for. The page is written by a
 * MODEL: the window is offscreen, sandboxed, with no node and isolated
 * context, exactly as the HyperFrames still window.
 */
import { BrowserWindow } from 'electron';

export interface RenderPageOptions {
  /** CSS pixels. The capture is scaled to this size (offscreen renders at 2×). */
  readonly width?: number;
  readonly height?: number;
  /** The most to wait for the page's load event, then its images and fonts. */
  readonly waitMs?: number;
  /** A beat for layout and the first frame of any entrance animation. */
  readonly settleMs?: number;
}

/** The page at `filePath` as a base64 PNG, or null when it could not be drawn. */
export async function renderPageFile(
  filePath: string,
  opts: RenderPageOptions = {},
): Promise<string | null> {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 900;
  const waitMs = opts.waitMs ?? 6000;
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
    Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  try {
    win.webContents.setZoomFactor(1);
    // `loadFile` settles on the load event, which waits for every image; a
    // remote one that hangs must not hold the look.
    await within(
      win.loadFile(filePath).catch(() => undefined),
      waitMs,
    );
    await within(
      win.webContents.executeJavaScript(
        `Promise.all([
           document.fonts ? document.fonts.ready : null,
           ...Array.from(document.images).map((i) => i.complete ? null : new Promise((r) => {
             i.addEventListener('load', r, { once: true });
             i.addEventListener('error', r, { once: true });
           })),
         ]).then(() => true)`,
        true,
      ),
      waitMs,
    );
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 400));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    const png =
      size.width > width || size.height > height
        ? image.resize({ width, height, quality: 'best' }).toPNG()
        : image.toPNG();
    return png.toString('base64');
  } catch {
    return null;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
