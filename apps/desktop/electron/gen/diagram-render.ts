/**
 * The Electron half of the `diagram` renderer (VQ-10): a hidden window with
 * Mermaid in it. Everything that can be reasoned about without a window —
 * preparing the source, repairing labels, the kit's colours, the post-pass —
 * is in ./diagram-page.ts and unit-tested; this file only hosts the page.
 *
 * MERMAID IS BUNDLED, not fetched: `resources/mermaid/mermaid.min.js`, 11.17.2,
 * MIT (the user approved bundling it — PLAN.md Q28), shipped to
 * `<Resources>/mermaid` by electron-builder. Offline by construction, and the
 * same bytes in dev and in the packaged app (the test pins its sha256).
 *
 * THE WINDOW NEVER SHOWS AND NEVER TAKES FOCUS. the user, on every test run and
 * every background job: "I can use the computer without any notice". It is
 * created hidden, offscreen, unfocusable and out of the task switcher, lives
 * for one render (a parse and two draws, ~0.2 s once Mermaid is loaded) and
 * is destroyed — a window left open would count as the app's window when the
 * dock icon asks whether any is open, and would keep a Windows or Linux build
 * from quitting when the user closes the real one.
 *
 * AND IT RUNS A MODEL'S SOURCE, so it is given nothing: sandboxed, no node, its
 * own in-memory session with every request refused but the page itself, no
 * navigation, no new windows. Mermaid's `securityLevel: 'strict'` escapes the
 * labels on top of that.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import { app, BrowserWindow, session } from 'electron';
import {
  asStatement,
  type DiagramPage,
  type DiagramRenderReply,
  type DiagramRenderRequest,
  MERMAID_SHA256,
  MERMAID_VERSION,
  PAGE_HTML,
  PAGE_SCRIPT,
  pageCall,
  runDiagram,
} from './diagram-page.js';

const log = createLogger('desktop:diagram');

/** A render that takes longer than this is a pathological graph, not a slow one. */
const RENDER_TIMEOUT_MS = 20_000;
const TOO_LONG = 'laying the diagram out took too long';

/** Where the bundled Mermaid is: beside the asar when packaged, in the repo in dev. */
export function mermaidPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mermaid', 'mermaid.min.js')
    : path.join(app.getAppPath(), 'resources', 'mermaid', 'mermaid.min.js');
}

let mermaidSource: Promise<string> | null = null;

/** Read once per app run, and checked against the pin — a swapped file is refused, not run. */
function loadMermaid(): Promise<string> {
  mermaidSource ??= readFile(mermaidPath(), 'utf8').then((text) => {
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest !== MERMAID_SHA256) {
      mermaidSource = null;
      throw new Error(`the bundled Mermaid does not match ${MERMAID_VERSION} (sha256 ${digest})`);
    }
    return text;
  });
  return mermaidSource;
}

const PARTITION = 'pd-diagram';
let sessionReady = false;

function diagramSession(): Electron.Session {
  const s = session.fromPartition(PARTITION, { cache: false });
  if (!sessionReady) {
    // The page is a data: URL and everything else is put in by executeJavaScript:
    // nothing it could ask the network for is ours to give.
    s.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('data:') && details.url !== 'about:blank' });
    });
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    sessionReady = true;
  }
  return s;
}

/**
 * A hidden Mermaid window with the page and Mermaid in it. One per final
 * render here; the live card keeps one open while a diagram streams in
 * (diagram-live.ts).
 */
export async function openDiagramWindow(): Promise<{ page: DiagramPage; dispose: () => void }> {
  const win = new BrowserWindow({
    width: 1600,
    height: 1200,
    show: false,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      session: diagramSession(),
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  const dispose = (): void => {
    if (!win.isDestroyed()) win.destroy();
  };
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`);
    // asStatement: the library's last statement is the mermaid object, and a
    // script's value is cloned back to main — it could not be (diagram-page.ts).
    await win.webContents.executeJavaScript(asStatement(await loadMermaid()), true);
    await win.webContents.executeJavaScript(asStatement(PAGE_SCRIPT), true);
  } catch (err) {
    dispose();
    throw err;
  }
  const call = async <T>(fn: '__pdParse' | '__pdRender', arg: unknown): Promise<T> =>
    JSON.parse((await win.webContents.executeJavaScript(pageCall(fn, arg), true)) as string) as T;
  return {
    page: {
      parse: (source) => call('__pdParse', source),
      render: (req) => call('__pdRender', req),
    },
    dispose,
  };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Draw a diagram, both modes, in a fresh hidden window. One at a time — two
 * diagrams in one answer queue behind each other rather than open two windows.
 */
export function renderDiagram(req: DiagramRenderRequest): Promise<DiagramRenderReply> {
  const job = queue.then(async (): Promise<DiagramRenderReply> => {
    const started = Date.now();
    let opened: { page: DiagramPage; dispose: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      opened = await openDiagramWindow();
      const page = opened.page;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(TOO_LONG)), RENDER_TIMEOUT_MS);
      });
      const reply = await Promise.race([runDiagram(page, req), timeout]);
      log.info('diagram', {
        ms: Date.now() - started,
        ok: reply.ok,
        ...(reply.ok ? { kind: reply.kind, nodes: reply.nodes.length } : { line: reply.line }),
      });
      return reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('diagram failed', { message });
      // A layout that runs past the limit is the graph's doing — say so to the
      // model. Anything else threw in the window or on the way to it, and is
      // ours: "simplify the source" would send it rewriting a good one.
      const tooBig = err instanceof Error && err.message === TOO_LONG;
      return {
        ok: false,
        error: message,
        line: null,
        lineText: null,
        hint: tooBig
          ? 'Mermaid could not lay it out in time; draw fewer steps per diagram (split it in two) and try again.'
          : '',
        ...(tooBig ? {} : { cause: 'app' as const }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      opened?.dispose();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
