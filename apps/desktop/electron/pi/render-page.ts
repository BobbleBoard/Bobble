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
 *
 * AND WHAT WENT WRONG WHILE IT LOADED. A picture cannot show that a script
 * threw: MEASURED (4B, the visual suite), a neural-network widget came back
 * with its neurons and none of the connections its reply described, and a
 * Fourier page with an empty canvas — both look like layout choices in a
 * screenshot. The errors the page logs, its uncaught exceptions and the files
 * it could not load are collected (its own session, so nothing is added to the
 * app's) and handed back with the picture.
 */
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';

/** A page, photographed, and what it reported while it loaded. */
export interface PageShot {
  /** Base64 PNG. */
  readonly png: string;
  /** Errors it logged or threw, and loads that failed — at most a handful. */
  readonly problems: readonly string[];
}

/** How many problems are worth handing back; the first ones are the cause. */
const MAX_PROBLEMS = 6;

export interface RenderPageOptions {
  /** CSS pixels. The capture is scaled to this size (offscreen renders at 2×). */
  readonly width?: number;
  readonly height?: number;
  /** The most to wait for the page's load event, then its images and fonts. */
  readonly waitMs?: number;
  /** A beat for layout and the first frame of any entrance animation. */
  readonly settleMs?: number;
}

/** The page at `filePath`, photographed, or null when it could not be drawn. */
export async function renderPageFile(
  filePath: string,
  opts: RenderPageOptions = {},
): Promise<PageShot | null> {
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
      // Its own, in memory: the request listeners below are this page's alone.
      partition: 'pd-render-page',
    },
  });
  const problems: string[] = [];
  // A file beside the page is named as the page names it, not as a file:// URL.
  const here = `${pathToFileURL(dirname(filePath)).href}/`;
  const note = (line: string): void => {
    const text = line.split(here).join('').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (text !== '' && !problems.includes(text) && problems.length < MAX_PROBLEMS) {
      problems.push(text);
    }
  };
  // Both console-message shapes: (event with fields) and (event, level, message, line).
  win.webContents.on('console-message', (...args: unknown[]) => {
    const e = args[0] as { level?: unknown; message?: unknown; lineNumber?: unknown };
    const level = typeof args[1] === 'number' ? args[1] : e?.level;
    const message = typeof args[2] === 'string' ? args[2] : e?.message;
    const line = typeof args[3] === 'number' ? args[3] : e?.lineNumber;
    if ((level === 3 || level === 'error') && typeof message === 'string') {
      note(typeof line === 'number' && line > 0 ? `${message} (line ${line})` : message);
    }
  });
  const requests = win.webContents.session.webRequest;
  requests.onCompleted((d) => {
    if (d.statusCode >= 400 && d.resourceType !== 'mainFrame') {
      note(`${d.resourceType} ${d.url.slice(0, 200)} failed to load (HTTP ${d.statusCode})`);
    }
  });
  requests.onErrorOccurred((d) => {
    if (d.error !== 'net::ERR_ABORTED') {
      note(`${d.resourceType} ${d.url.slice(0, 200)} failed to load (${d.error})`);
    }
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
    return { png: png.toString('base64'), problems: [...problems] };
  } catch {
    return null;
  } finally {
    win.webContents.session.webRequest.onCompleted(null);
    win.webContents.session.webRequest.onErrorOccurred(null);
    if (!win.isDestroyed()) win.destroy();
  }
}
