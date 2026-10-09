/**
 * Canvas main-process wiring:
 *   1. the `pd-preview://` sandboxed-harness protocol (privileged / standard /
 *      secure) that serves @pi-desktop/canvas's static harness files, and
 *   2. the artifact pop-out channel that hands the current artifact to a
 *      standalone canvas window.
 *
 * The canvas iframe is isolated by the frame sandbox (allow-scripts, NO
 * allow-same-origin) plus this distinct scheme origin — the app preload is
 * NEVER attached to it (see trusted-senders.ts). This module deliberately does
 * NOT import @pi-desktop/canvas: that barrel re-exports the React/CodeMirror
 * surfaces, which must not enter the Node main bundle. The two wire constants
 * below mirror the frozen source of truth in
 * packages/canvas/src/harness/protocol.ts (PD_PREVIEW_SCHEME /
 * PD_PREVIEW_HARNESS_HOST).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeImage,
  protocol,
  shell,
  type WebContents,
} from 'electron';
import { isHandedFile } from '../attachments/attachments-main';
import { bobbleDir, GENERATED_DIR } from '../bobble-paths';
import { allowedWriteRoots } from '../fs-handlers';
import type {
  AppEventMap,
  CanvasArtifactPayload,
  CanvasOpenApp,
  CanvasOpenWithAppId,
} from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import {
  describeOpenFailure,
  type OpenOutcome,
  type OpenRequest,
  openArgv,
  openFailureDetail,
  openPolicy,
  openRequestsFor,
  resolveOpenTarget,
} from './os-open';

const execFileAsync = promisify(execFile);

const log = createLogger('desktop:canvas');

/** Mirrors packages/canvas/src/harness/protocol.ts (frozen). */
const PD_PREVIEW_SCHEME = 'pd-preview';
const PD_PREVIEW_HARNESS_HOST = 'canvas';

/**
 * The `pd-file://` media scheme: serves raw project-file BYTES to the renderer so
 * the canvas can preview binary modalities — images, video, audio, PDFs, 3D
 * models (glb/obj/stl/ply) and Office docs (docx/pptx). It exists because the
 * main window runs with `webSecurity` on and a non-`file://` origin in dev, where
 * `<img src=file://…>` happens to load but `fetch('file://…')` (needed to hand a
 * model/doc's ArrayBuffer to three.js / mammoth) is blocked cross-origin. A
 * privileged `supportFetchAPI` + `corsEnabled` scheme fixes BOTH the element
 * `src` case and the `fetch()` case uniformly, and — being ours — lets us fence
 * to the app's working roots and honour HTTP Range so `<video>` can seek.
 * URL shape: `pd-file://f` + the URL-encoded absolute path (its own pathname).
 */
const PD_FILE_SCHEME = 'pd-file';
const PD_FILE_HOST = 'f';

/** Extension → Content-Type for the media scheme. Elements (img/video/audio/pdf
 * iframe) rely on this; the fetch()-based surfaces (3D/doc) read the bytes
 * directly and ignore it. Unknowns fall back to octet-stream. */
const FILE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  apng: 'image/apng',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  stl: 'application/sla',
  ply: 'application/octet-stream',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const events = createIpcEventSender<AppEventMap>();

/** Latest artifact handed off for the pop-out window to fetch/render. */
let popoutArtifact: CanvasArtifactPayload | null = null;

/**
 * Register the harness scheme as privileged+standard+secure. MUST run before
 * `app.whenReady()` (Electron requirement). `standard: true` gives the harness
 * page a stable opaque origin (`pd-preview://canvas`) distinct from the app,
 * which — with the frame's allow-scripts / no-allow-same-origin sandbox — is
 * the containment boundary.
 */
export function registerCanvasSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PD_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
    {
      // `stream` lets the handler return a streamed body (large video/models);
      // `corsEnabled` + our ACAO header make cross-origin fetch() readable so the
      // 3D/doc surfaces can pull an ArrayBuffer from a `http://localhost` / `file://`
      // renderer origin.
      scheme: PD_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Parse a `Range: bytes=start-end` header against a known total size. Returns
 * null for no/negative/unsatisfiable ranges (caller then serves the whole file
 * or a 416). Only the first range of a (rare) multi-range request is honoured. */
function parseRange(header: string | null, total: number): { start: number; end: number } | null {
  if (header === null) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(header.trim());
  if (m === null) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start: number;
  let end: number;
  if (!hasStart) {
    // suffix range: last N bytes
    const suffix = Number(m[2]);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return null;
  }
  return { start, end };
}

/** True when `target` sits inside one of the app's working roots (registered
 * projects, pi session cwds, the sandbox base, pi's agent dir). Both the target
 * and each root are compared BOTH lexically and via realpath, so a symlinked path
 * on either side matches (e.g. macOS `/var` → `/private/var`: a project stored as
 * `/var/folders/…` still contains a file that realpaths to `/private/var/…`). */
function isUnderAllowedRoot(target: string, real: string): boolean {
  const contained = (root: string): boolean =>
    target === root ||
    target.startsWith(root + path.sep) ||
    real === root ||
    real.startsWith(root + path.sep);
  for (const root of allowedWriteRoots()) {
    if (contained(root)) return true;
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      continue; // root doesn't exist yet — its lexical form was already checked
    }
    if (rootReal !== root && contained(rootReal)) return true;
  }
  return false;
}

/**
 * Serve `pd-file://f/<abs-path>` from disk with a correct content-type, HTTP
 * Range support (so `<video>` can seek), and CORS. The path is realpath'd and
 * fenced to the app's working roots — a page (even the sandboxed canvas iframe)
 * can never stream a file outside the folders the app already operates in.
 * Registered after `app.whenReady()` (protocol.handle requirement).
 */
export function registerFileProtocol(): void {
  protocol.handle(PD_FILE_SCHEME, async (request) => {
    const cors = { 'access-control-allow-origin': '*' } as const;
    let target: string;
    try {
      const { host, pathname } = new URL(request.url);
      if (host !== PD_FILE_HOST) return new Response('not found', { status: 404, headers: cors });
      const decoded = decodeURIComponent(pathname);
      // `~` is the home folder (a model often names files that way).
      const home = decoded.match(/^\/?~(\/.*)?$/);
      target = home !== null ? path.join(homedir(), home[1] ?? '') : path.resolve(decoded);
    } catch {
      return new Response('bad request', { status: 400, headers: cors });
    }

    // realpath (collapse symlinks) then fence — never serve outside the roots.
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return new Response('not found', { status: 404, headers: cors });
    }
    /* …or a picture the person opened in the image viewer: THEIR file, where
       they keep it, handed over one file at a time (attachments-main.ts). */
    if (!isUnderAllowedRoot(target, real) && !isHandedFile(real)) {
      log.warn('pd-file rejected: outside allowed roots', { target });
      return new Response('forbidden', { status: 403, headers: cors });
    }
    const st = statSafe(real);
    if (st === null || !st.isFile()) {
      return new Response('not found', { status: 404, headers: cors });
    }

    const ext = extOf(real);

    // Chromium's <img> can't decode HEIC/HEIF (iPhone's default), so transcode to
    // PNG with macOS `sips` (offline; the OS's own codec — nativeImage's decoder
    // returns empty for real camera HEICs) and stream THAT instead.
    let serveFile = real;
    let contentType = FILE_MIME[ext] ?? 'application/octet-stream';
    if (ext === 'heic' || ext === 'heif') {
      const png = await heicToPng(real, st.mtimeMs);
      if (png === null) return new Response('unsupported image', { status: 415, headers: cors });
      serveFile = png;
      contentType = 'image/png';
    }
    const serveStat = serveFile === real ? st : statSafe(serveFile);
    if (serveStat === null) return new Response('not found', { status: 404, headers: cors });
    const total = serveStat.size;
    const base: Record<string, string> = {
      ...cors,
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    };

    const range = parseRange(request.headers.get('range'), total);
    if (request.headers.get('range') !== null && range === null && total > 0) {
      // A Range header we couldn't satisfy → 416 with the current size.
      return new Response(null, {
        status: 416,
        headers: { ...base, 'content-range': `bytes */${total}` },
      });
    }
    try {
      if (range !== null) {
        const stream = createReadStream(serveFile, { start: range.start, end: range.end });
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...base,
            'content-range': `bytes ${range.start}-${range.end}/${total}`,
            'content-length': String(range.end - range.start + 1),
          },
        });
      }
      const stream = createReadStream(serveFile);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: { ...base, 'content-length': String(total) },
      });
    } catch (error) {
      log.warn('pd-file read failed', { target: real, error: String(error) });
      return new Response('read error', { status: 500, headers: cors });
    }
  });
}

// HEIC/HEIF → temp-PNG cache, keyed by source path + mtime so a file that changes
// on disk re-transcodes. macOS only (sips); elsewhere → null → 415.
const heicPngCache = new Map<string, string>();

/** Transcode a HEIC/HEIF file to a temp PNG via macOS `sips` (offline, the OS's
 * own HEIF codec — reliable on real camera HEICs where nativeImage returns an
 * empty image), cached by path+mtime. Returns the PNG path, or null on failure. */
async function heicToPng(real: string, mtimeMs: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const key = `${real}:${mtimeMs}`;
  const cached = heicPngCache.get(key);
  if (cached !== undefined && existsSync(cached)) return cached;
  const out = path.join(tmpdir(), `pi-heic-${Buffer.from(key).toString('hex').slice(0, 32)}.png`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', real, '--out', out]);
    if (!existsSync(out)) return null;
    heicPngCache.set(key, out);
    return out;
  } catch (error) {
    log.warn('heic transcode failed', { real, error: String(error) });
    return null;
  }
}

/** Guarded statSync → null on any error (missing / permission). */
function statSafe(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Serve the canvas harness `{index.html,harness.js}` over `pd-preview://`.
 * `harnessDir` is resolved by the caller (main.ts, via app-paths.ts):
 * repo-relative `packages/canvas/harness` in dev, and bundle-relative inside
 * the asar when packaged. readFileSync here goes through the Electron fs shim,
 * so an asar-internal harnessDir is served transparently. Anything other than
 * the two known files 404s.
 */
export function registerCanvasProtocol(harnessDir: string): void {
  protocol.handle(PD_PREVIEW_SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== PD_PREVIEW_HARNESS_HOST) {
      return new Response('not found', { status: 404 });
    }
    const file = pathname === '/harness.js' ? 'harness.js' : 'index.html';
    const abs = path.join(harnessDir, file);
    // Fence to the harness dir: never serve outside it even if the URL is odd.
    if (!path.resolve(abs).startsWith(path.resolve(harnessDir))) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      // Read + return the bytes with an explicit content-type (don't rely on
      // net.fetch file: inference) so harness.js is served as executable JS.
      const body = readFileSync(abs);
      const contentType =
        file === 'harness.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      return new Response(body, { headers: { 'content-type': contentType } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/** Fail fast at startup if the harness assets aren't where we expect. */
export function harnessAssetsPresent(harnessDir: string): boolean {
  try {
    readFileSync(path.join(harnessDir, 'index.html'));
    readFileSync(path.join(harnessDir, 'harness.js'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire the pop-out channels. `openPopoutWindow` (injected by main.ts, which
 * owns the window scaffolding) creates-or-focuses the standalone canvas window
 * and reports whether it created a fresh one — a fresh window fetches the
 * artifact itself on mount via `canvas:get-popout`; an already-open one is
 * pushed the new artifact over the event wire.
 */
export function registerCanvasIpc(
  openPopoutWindow: () => { webContents: WebContents; created: boolean },
): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error(`[canvas] rejected "${channel}": untrusted sender`);
    }
  };

  ipcMain.handle('canvas:popout', (event, req: { artifact: CanvasArtifactPayload }) => {
    guard(event, 'canvas:popout');
    popoutArtifact = req.artifact;
    const { webContents, created } = openPopoutWindow();
    if (!created && !webContents.isDestroyed()) {
      events.send(webContents, 'canvas:popout-artifact', popoutArtifact);
    }
    return { ok: true };
  });

  ipcMain.handle('canvas:get-popout', (event) => {
    guard(event, 'canvas:get-popout');
    return { artifact: popoutArtifact };
  });

  // Browser operation bar → open the current URL in the user's real browser.
  ipcMain.handle('canvas:open-external', async (event, req: { url: string }) => {
    guard(event, 'canvas:open-external');
    // Only ever hand http(s) URLs to the OS (never file:/custom schemes).
    if (!/^https?:\/\//i.test(req.url.trim())) return { ok: false };
    // A probe clicking "Open in external browser" must not open a browser over
    // someone's work — the renderer used to skip this call under E2E, now it
    // makes it, and the line is drawn here (see openPolicy).
    if (process.env.PI_E2E === '1') {
      noteForProbes({ channel: 'canvas:open-external', argv: [req.url.trim()], ran: false });
      return { ok: true };
    }
    try {
      await shell.openExternal(req.url.trim());
      return { ok: true };
    } catch (error) {
      log.warn('open-external failed', { error: String(error) });
      return { ok: false };
    }
  });

  // File operation bar "Open with" split button → the apps that can open this
  // file (LaunchServices default + a pragmatic set), each with a system icon.
  ipcMain.handle('canvas:list-open-apps', async (event, req: { path: string }) => {
    guard(event, 'canvas:list-open-apps');
    return listOpenApps(req.path);
  });

  // File operation bar "Open ▾" → shell out to the chosen app. The answer says
  // WHY when it could not (os-open.ts) — the renderer shows it.
  ipcMain.handle(
    'canvas:open-with',
    async (event, req: { path: string; appId: CanvasOpenWithAppId }) => {
      guard(event, 'canvas:open-with');
      return openFile('canvas:open-with', req.path, req.appId);
    },
  );

  /*
   * OPEN WITH WHATEVER THE OS USES — no `duti`, no Apple Events.
   *
   * The primary "Open" used to depend on us having IDENTIFIED the default app,
   * which goes through `duti` (a Homebrew tool most machines do not have) and
   * returns null when it is missing. On such a machine there was no default to
   * open with, so the button did nothing while the dropdown's individual apps
   * worked fine — exactly what the user reported.
   *
   * `open <file>` asks LaunchServices to do what a double-click in Finder does
   * (shell.openPath off macOS). It needs no third-party tool and no Apple Events
   * permission (the osascript route asks Finder and is refused with -1743 until
   * the user grants automation access).
   */
  ipcMain.handle('canvas:open-default', async (event, req: { path: string }) => {
    guard(event, 'canvas:open-default');
    return openFile('canvas:open-default', req.path, 'default');
  });

  // File operation bar "Open in folder" / the card's Show → select it in Finder.
  ipcMain.handle('canvas:reveal', async (event, req: { path: string }) => {
    guard(event, 'canvas:reveal');
    const resolved = resolveOpenTarget(req.path, { home: homedir(), exists: existsSync });
    if (!resolved.ok) return resolved;
    return launch('canvas:reveal', { kind: 'reveal', target: resolved.target });
  });

  /*
   * COPY A GENERATED FILE. A picture goes on as pixels — the thing every app
   * with a paste target understands (a chat, a document, an editor). A clip, a
   * sound or a model has no pixel form: on macOS it goes on as the file itself
   * (`public.file-url`, which Finder, Mail and Messages paste), elsewhere as its
   * path. Electron's clipboard writes ONE representation per call (a later
   * write clears the earlier), so it is one or the other, chosen by kind.
   */
  ipcMain.handle('canvas:copy-file', (event, req: { path: string }) => {
    guard(event, 'canvas:copy-file');
    const file = path.resolve(req.path);
    if (!existsSync(file)) return { ok: false, error: 'the file is not there any more' };
    if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file)) {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) {
        clipboard.writeImage(image);
        return { ok: true, how: 'image' };
      }
    }
    if (process.platform === 'darwin') {
      clipboard.writeBuffer(
        'public.file-url',
        Buffer.from(pathToFileURL(file).href, 'utf8'),
        'clipboard',
      );
    } else {
      clipboard.writeText(file);
    }
    return { ok: true, how: 'file' };
  });

  /*
   * DRAG A GENERATED FILE STRAIGHT INTO FINDER.
   *
   * The thing a desktop app can do that a browser tab cannot, and everything the
   * model produces is already a real file at a real path — so the whole gap
   * between "it made me an image" and "it is in my Downloads folder" was one
   * unwired API call.
   *
   * `startDrag` needs an icon or it silently does nothing on macOS, and it
   * throws if the file is gone, so both are handled rather than left to fail
   * mid-gesture with no feedback.
   */
  ipcMain.handle('canvas:start-drag', (event, req: { path: string }) => {
    guard(event, 'canvas:start-drag');
    const file = path.resolve(req.path);
    if (!existsSync(file)) return { ok: false };
    try {
      // An empty image is a valid drag icon; the OS substitutes the file's own.
      event.sender.startDrag({ file, icon: nativeImage.createEmpty() });
      return { ok: true };
    } catch (error) {
      log.warn('start-drag failed', { error: String(error) });
      return { ok: false };
    }
  });

  /*
   * SAVE A COPY WHERE THE USER WANTS IT.
   *
   * A cancelled dialog is `ok:false` with NO error — a caller that treats every
   * falsy result as a failure would report "save failed" for someone who simply
   * changed their mind, which is worse than doing nothing.
   */
  ipcMain.handle('canvas:save-as', async (event, req: { path: string; suggestedName?: string }) => {
    guard(event, 'canvas:save-as');
    const from = path.resolve(req.path);
    if (!existsSync(from)) return { ok: false, error: 'that file is no longer there' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await (win === null
      ? dialog.showSaveDialog({ defaultPath: req.suggestedName ?? path.basename(from) })
      : dialog.showSaveDialog(win, {
          defaultPath: req.suggestedName ?? path.basename(from),
        }));
    if (result.canceled || result.filePath === undefined) return { ok: false };
    try {
      copyFileSync(from, result.filePath);
      return { ok: true, savedTo: result.filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('save-as failed', { error: message });
      return { ok: false, error: message };
    }
  });
  registerBytesHandlers(guard);
}

/** The 3D studio's Export and Send To — see ipc-contract for why these exist. */
function registerBytesHandlers(guard: (event: IpcMainInvokeEvent, channel: string) => void): void {
  ipcMain.handle(
    'canvas:save-bytes',
    async (event, req: { base64: string; suggestedName: string }) => {
      guard(event, 'canvas:save-bytes');
      const win = BrowserWindow.fromWebContents(event.sender);
      const opts = { defaultPath: path.join(app.getPath('downloads'), req.suggestedName) };
      const result = await (win === null
        ? dialog.showSaveDialog(opts)
        : dialog.showSaveDialog(win, opts));
      if (result.canceled || result.filePath === undefined) return { ok: false };
      try {
        writeFileSync(result.filePath, Buffer.from(req.base64, 'base64'));
        return { ok: true, savedTo: result.filePath };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('save-bytes failed', { error: message });
        return { ok: false, error: message };
      }
    },
  );
  ipcMain.handle(
    'canvas:send-bytes-to',
    async (event, req: { base64: string; fileName: string; app: string }) => {
      guard(event, 'canvas:send-bytes-to');
      // The generated-media root is inside the pd-file fence and is where every
      // other made thing lands, so the file stays findable after the hand-off.
      const dir = path.join(bobbleDir(GENERATED_DIR), '3d');
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(req.fileName));
      try {
        writeFileSync(target, Buffer.from(req.base64, 'base64'));
        await openApp(req.app, target);
        return { ok: true, savedTo: target };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('open-with failed', { app: req.app, error: message });
        return {
          ok: false,
          savedTo: target,
          error: /Unable to find application/i.test(message)
            ? `${req.app} is not installed on this Mac — the file is at ${target}`
            : message,
        };
      }
    },
  );
}

/** `open -a <app> <target>` as a promise (macOS). Rejects on a non-zero exit
 * (e.g. the app isn't installed), which drives the vscode-insiders → stable
 * fallback below. */
function openApp(appName: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', appName, target], (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Open a file with the app the user chose ('default' = whatever the OS uses).
 *
 * The path is checked BEFORE anything is launched: it must be absolute and on
 * disk (os-open.ts resolveOpenTarget) — `path.resolve` used to quietly turn a
 * relative path into one under `/`, main's cwd when launched from Finder.
 *
 * A chosen app that cannot open it is REPORTED, not swapped: this used to fall
 * back to the OS default and answer `ok: true`, so picking Photos could open
 * Preview with no word about why. Only the legacy `vscode-insiders` id keeps
 * its deliberate fallback to stable VS Code.
 */
async function openFile(channel: string, filePath: string, appId: string): Promise<OpenOutcome> {
  const resolved = resolveOpenTarget(filePath, { home: homedir(), exists: existsSync });
  if (!resolved.ok) {
    noteForProbes({ channel, argv: null, ran: false, outcome: resolved, path: filePath });
    return resolved;
  }
  const requests = openRequestsFor(appId, resolved.target, isDirectory(resolved.target));
  let outcome: OpenOutcome = { ok: false, error: 'The Mac did not say why.' };
  for (const req of requests) {
    outcome = await launch(channel, req);
    if (outcome.ok) return outcome;
  }
  log.warn('open failed', {
    appId,
    target: resolved.target,
    error: outcome.ok ? '' : outcome.error,
  });
  return outcome;
}

/**
 * Hand ONE request to the OS — or, under a probe, record it (openPolicy).
 * macOS: `open` (os-open.ts explains why one binary for everything). Elsewhere:
 * Electron's LaunchServices equivalents, which have no "with this app".
 */
async function launch(channel: string, req: OpenRequest): Promise<OpenOutcome> {
  const argv = openArgv(req);
  if (openPolicy(process.env) === 'record') {
    noteForProbes({ channel, argv, ran: false, outcome: { ok: true } });
    return { ok: true };
  }
  let outcome: OpenOutcome;
  if (process.platform !== 'darwin' && process.env.PI_E2E_FAKE_OPEN !== '1') {
    if (req.kind === 'reveal') {
      shell.showItemInFolder(req.target);
      outcome = { ok: true };
    } else {
      const error = await shell.openPath(req.target);
      outcome = error === '' ? { ok: true } : { ok: false, error: describeOpenFailure(req, error) };
    }
  } else {
    try {
      await runOpen(argv);
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error: describeOpenFailure(req, openFailureDetail(error)) };
    }
  }
  noteForProbes({ channel, argv, ran: true, outcome });
  return outcome;
}

/**
 * `open <argv>`, found on PATH — which is where a probe's fake one goes first.
 * A stripped PATH without /usr/bin must not break every Open, so ENOENT retries
 * the system binary by its full path — never under a probe, where reaching the
 * real one would launch an app over someone's work.
 *
 * The timeout is long on purpose: `open` returns once the app has taken the
 * file, and a cold launch behind Gatekeeper's first-run check can take many
 * seconds. Killing `open` would not stop that launch — it would only report a
 * failure for a file that is about to appear.
 */
function runOpen(argv: string[]): Promise<void> {
  const attempt = (bin: string): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(bin, argv, { timeout: 60_000 }, (error, _stdout, stderr) => {
        if (error === null) resolve();
        else reject(Object.assign(error, { stderr: String(stderr ?? '') }));
      });
    });
  return attempt('open').catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' && process.env.PI_E2E !== '1'
      ? attempt('/usr/bin/open')
      : Promise.reject(error),
  );
}

/**
 * E2E: every hand-to-the-OS request, the argv it became, whether it ran and
 * what came back — read by probes through Playwright's `app.evaluate`
 * (`globalThis.__pdOsOpens`). Nothing is kept outside PI_E2E.
 */
function noteForProbes(entry: {
  channel: string;
  argv: string[] | null;
  ran: boolean;
  outcome?: OpenOutcome;
  path?: string;
}): void {
  if (process.env.PI_E2E !== '1') return;
  const g = globalThis as { __pdOsOpens?: unknown[] };
  if (g.__pdOsOpens === undefined) g.__pdOsOpens = [];
  g.__pdOsOpens.push({ ...entry, at: Date.now() });
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── "Open with" app list + system icons (round-8 #14) ──────────────────────
//
// macOS only. The default handler is detected via `duti -x <ext>` when
// available (else omitted — the "Open" button still opens the OS default via
// shell.openPath). The candidate list is the default app plus a pragmatic set
// of installed editors/terminals; each app's icon is extracted from its bundle
// (Info.plist → .icns → PNG via `sips`) and returned as a data URL. Results are
// cached by extension; icons are cached by app path — the extraction shells out.

// Candidate apps by FILE CATEGORY, probed at their standard install locations —
// only the ones present on THIS machine are offered (existsSync filter in
// listOpenApps), and the LaunchServices default (duti) is prepended as primary.
// So an image offers Preview/Photos, a pptx offers Keynote/PowerPoint, a video
// offers IINA/VLC/QuickTime, etc. — never Xcode-for-everything.
type AppCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'model'
  | 'code';

const TEXT_EDITORS = [
  '/Applications/Visual Studio Code.app',
  '/Applications/Visual Studio Code - Insiders.app',
  '/Applications/Cursor.app',
  '/Applications/Zed.app',
  '/Applications/Sublime Text.app',
  '/Applications/Xcode.app',
  '/System/Applications/TextEdit.app',
];

const CATEGORY_APPS: Record<AppCategory, string[]> = {
  image: [
    '/System/Applications/Preview.app',
    '/System/Applications/Photos.app',
    '/Applications/Pixelmator Pro.app',
    '/Applications/Affinity Photo 2.app',
    '/Applications/GIMP.app',
  ],
  video: [
    '/Applications/IINA.app',
    '/Applications/VLC.app',
    '/System/Applications/QuickTime Player.app',
  ],
  audio: [
    '/System/Applications/Music.app',
    '/Applications/VLC.app',
    '/System/Applications/QuickTime Player.app',
  ],
  pdf: [
    '/System/Applications/Preview.app',
    '/Applications/Adobe Acrobat Reader.app',
    '/Applications/Adobe Acrobat.app',
  ],
  document: [
    '/Applications/Microsoft Word.app',
    '/Applications/Pages.app',
    '/System/Applications/Pages.app',
    '/System/Applications/TextEdit.app',
  ],
  presentation: [
    '/Applications/Keynote.app',
    '/System/Applications/Keynote.app',
    '/Applications/Microsoft PowerPoint.app',
  ],
  spreadsheet: [
    '/Applications/Numbers.app',
    '/System/Applications/Numbers.app',
    '/Applications/Microsoft Excel.app',
  ],
  // Preview opens usdz; Blender/Xcode handle the rest. Kept short on purpose.
  model: [
    '/Applications/Blender.app',
    '/Applications/Xcode.app',
    '/System/Applications/Preview.app',
  ],
  code: [...TEXT_EDITORS, '/System/Applications/Utilities/Terminal.app'],
};

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng',
  'heic',
  'heif',
  'tiff',
  'tif',
  'svg',
]);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff']);
const MODEL_EXTS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'usdz', 'fbx', '3mf', 'dae']);

/** Map a file extension to the app category whose candidate list we offer. */
function categoryForExt(ext: string): AppCategory {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['docx', 'doc', 'rtf', 'odt'].includes(ext)) return 'document';
  if (['pptx', 'ppt', 'key', 'odp'].includes(ext)) return 'presentation';
  if (['xlsx', 'xls', 'csv', 'tsv', 'numbers', 'ods'].includes(ext)) return 'spreadsheet';
  if (MODEL_EXTS.has(ext)) return 'model';
  return 'code';
}

/*
 * Both caches hold PROMISES, so callers asking at the same moment share one
 * build. They do ask at the same moment: one `present:show` fetches the list
 * for the card AND for the canvas tab, and two builds ran side by side — each
 * shelling out to `sips` for every icon (see extractIconDataUrl for what that
 * collided on).
 */
const appMetaCache = new Map<string, Promise<CanvasOpenApp>>();
const openAppsByExt = new Map<
  string,
  Promise<{ apps: CanvasOpenApp[]; defaultAppId: string | null }>
>();

function extOf(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Parse a small set of Info.plist keys via `plutil -convert json`. */
async function readBundleInfo(
  appPath: string,
): Promise<{ id: string; name: string; iconFile?: string }> {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const fallbackName = path.basename(appPath).replace(/\.app$/i, '');
  try {
    const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', plist]);
    const info = JSON.parse(stdout) as Record<string, unknown>;
    const id = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : appPath;
    const name =
      (typeof info.CFBundleDisplayName === 'string' && info.CFBundleDisplayName) ||
      (typeof info.CFBundleName === 'string' && info.CFBundleName) ||
      fallbackName;
    const iconFile = typeof info.CFBundleIconFile === 'string' ? info.CFBundleIconFile : undefined;
    return { id, name, iconFile };
  } catch {
    return { id: appPath, name: fallbackName };
  }
}

/** Extract an app's icon to a small PNG data URL (`sips`), or undefined. */
async function extractIconDataUrl(appPath: string, iconFile: string): Promise<string | undefined> {
  const name = /\.icns$/i.test(iconFile) ? iconFile : `${iconFile}.icns`;
  const icns = path.join(appPath, 'Contents', 'Resources', name);
  if (!existsSync(icns)) return undefined;
  /*
   * ONE FILE PER APP. The name used to be the first 12 bytes of the path in
   * hex — "/Application" or "/System/Appl" — so every app's icon went through
   * one of TWO temp files, and two lists built at once read each other's
   * icons. SEEN 2026-09-23 (open-buttons-probe): the same .md offered TextEdit
   * with a blank page and Terminal with no icon in the canvas menu, and TextEdit
   * blank with Terminal's real icon on the card beside it.
   */
  const out = path.join(
    tmpdir(),
    `pi-appicon-${createHash('sha1').update(appPath).digest('hex').slice(0, 16)}.png`,
  );
  try {
    // -Z 32: cap the longest side at 32px so the data URL stays tiny.
    await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '32', icns, '--out', out]);
    return `data:image/png;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Bundle id + display name + icon data URL for an app, cached by path.
 * Never rejects: both reads fall back (the name from the path, no icon). */
function appMeta(appPath: string): Promise<CanvasOpenApp> {
  const cached = appMetaCache.get(appPath);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<CanvasOpenApp> => {
    const info = await readBundleInfo(appPath);
    const iconDataUrl =
      info.iconFile !== undefined ? await extractIconDataUrl(appPath, info.iconFile) : undefined;
    // Prefer the bundle id (stable, `open -b`) as the app id; fall back to path.
    return { id: info.id || appPath, name: info.name, iconDataUrl };
  })();
  appMetaCache.set(appPath, pending);
  return pending;
}

/** LaunchServices default app for an extension via `duti -x` (optional tool). */
/*
 * WITHOUT `duti`, THE DEFAULT WAS NEVER FOUND — and `duti` is a Homebrew tool.
 *
 * MEASURED on a machine without it: `defaultAppPath` threw, returned null, and
 * three separate symptoms followed — the Open button showed a generic glyph, the
 * dropdown filtered nothing (so every app including Terminal was listed), and
 * there was no default to open with. the user reported all three.
 *
 * The two obvious alternatives are dead ends, both checked rather than assumed:
 *   - `osascript` asking Finder for the default application is refused with
 *     -1743 until the user grants automation access;
 *   - LaunchServices records only USER OVERRIDES (`HandlerPref: 20 units` here,
 *     none for html), so neither the plist nor `lsregister -dump` knows the
 *     system default.
 *
 * What IS available without permissions or extra tooling is the default
 * BROWSER, via Electron's own API — and for the artefacts this app presents
 * (.html pages, rendered reports, SVG) the browser IS the OS default. So the
 * browser answers the common case, and everything else falls back to the
 * generic glyph while the plain `open <file>` still opens it correctly.
 */
async function defaultAppPath(ext: string): Promise<string | null> {
  if (ext === '') return null;
  try {
    const { stdout } = await execFileAsync('duti', ['-x', ext]);
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.endsWith('.app'));
    if (line !== undefined) return line;
  } catch {
    // duti not installed — fall through to the browser fallback below.
  }
  return browserAppPathFor(ext);
}

/** Extensions a browser is the OS default for; the ones this app presents most. */
const BROWSER_EXTS = new Set(['html', 'htm', 'svg', 'xhtml', 'pdf', 'webp']);

/** The default browser's .app path, via Electron (no permissions, no duti). */
async function browserAppPathFor(ext: string): Promise<string | null> {
  if (!BROWSER_EXTS.has(ext)) return null;
  let name: string;
  try {
    name = app.getApplicationNameForProtocol('https://');
  } catch (error) {
    /* This catch previously hid a missing `app` import: the ReferenceError was
     * swallowed and reported as "no default app", which looks exactly like the
     * `duti` case it was written for. Log it so a real fault is never silent. */
    log.warn('default-browser lookup failed', { error: String(error) });
    return null;
  }
  if (name === '') return null;
  for (const dir of ['/Applications', '/System/Applications']) {
    const candidate = path.join(dir, `${name}.app`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function listOpenApps(
  filePath: string,
): Promise<{ apps: CanvasOpenApp[]; defaultAppId: string | null }> {
  if (process.platform !== 'darwin') return Promise.resolve({ apps: [], defaultAppId: null });
  const ext = extOf(filePath);
  const cached = openAppsByExt.get(ext);
  if (cached !== undefined) return cached;
  const pending = buildOpenApps(ext);
  openAppsByExt.set(ext, pending);
  // A build that failed is not remembered — the next ask tries again.
  pending.catch(() => openAppsByExt.delete(ext));
  return pending;
}

async function buildOpenApps(
  ext: string,
): Promise<{ apps: CanvasOpenApp[]; defaultAppId: string | null }> {
  // LaunchServices default first (primary "Open"), then the category's installed
  // candidates. existsSync keeps it to apps actually on this machine.
  const defPath = await defaultAppPath(ext);
  const paths: string[] = [];
  if (defPath !== null && existsSync(defPath)) paths.push(defPath);
  for (const p of CATEGORY_APPS[categoryForExt(ext)]) {
    if (existsSync(p) && !paths.includes(p)) paths.push(p);
  }

  const apps: CanvasOpenApp[] = [];
  let defaultAppId: string | null = null;
  for (const p of paths) {
    const meta = await appMeta(p);
    // Some apps ship at two paths (/Applications + /System/Applications) — dedupe
    // by bundle id so the same app isn't listed twice.
    if (apps.some((a) => a.id === meta.id)) continue;
    apps.push(meta);
    if (p === defPath) defaultAppId = meta.id;
  }
  return { apps, defaultAppId };
}
