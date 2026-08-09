/**
 * Office-editor manager: one `WebContentsView` per office canvas tab, backed by
 * the vendored GenOffice editors (vendor/genoffice, Apache-2.0).
 *
 * This is browser-manager.ts's twin. The canvas already knows how to overlay a
 * native view at a renderer-reported rect and hide it on tab switch; an office
 * tab is that same machinery pointed at an editor view instead of a web page.
 * The blank-pane recovery below is copied deliberately rather than abstracted —
 * see the note on `setBoundsFor`.
 *
 * The seam is loaded LAZILY and its absence is not fatal. A build without
 * `vendor/genoffice/embed/out` still runs; office tabs simply report
 * unavailable and the canvas falls back to the read-only mammoth preview. That
 * matters because the vendored tree is a fork of a fast-moving upstream, and a
 * broken vendor build should degrade the office feature, not brick the app.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import { app, BrowserWindow, type WebContents, type WebContentsView } from 'electron';
import type { OfficeBounds, OfficeKind } from './office-contract';
import { officeChromeCss, officeChromeScript } from './office-chrome';
import { officeThemeCss, type OfficeThemeTokens } from './office-theme';

const log = createLogger('desktop:office');
const requireCjs = createRequire(import.meta.url);

interface Entry {
  view: WebContentsView;
  owner: WebContents;
  visible: boolean;
  kind: OfficeKind;
  filePath: string;
  /** Last size pushed, so a reflow is forced only on a real size change and not
   * on the scroll/focus churn that also re-emits bounds. */
  lastW: number;
  lastH: number;
}

const entries = new Map<string, Entry>();
const wiredOwners = new Set<number>();

/** The subset of vendor/genoffice/embed we actually call. */
interface OfficeSeam {
  configureDocsRuntime(c: { preloadPath: string; rendererFile: string }): void;
  configureSheetsRuntime(c: {
    preloadPath: string;
    rendererFile: string;
    sidecarPath?: string;
  }): void;
  configureSlidesRuntime(c: {
    preloadPath: string;
    rendererFilePath: string;
    rendererDevUrl?: string;
  }): void;
  configurePdfRuntime(c: { preloadPath: string; rendererFile: string }): void;
  configureMarkdownRuntime(c: { preloadPath: string; rendererFile: string }): void;
  registerDocsIpc(): void;
  registerSheetsIpc(): void;
  createDocsView(openPath?: string): WebContentsView;
  createSheetsView(options?: { includeAiHandlers?: boolean }): WebContentsView;
  createSlidesView(openPath?: string | null): WebContentsView;
  createPdfView(openPath?: string | null): WebContentsView;
  createMarkdownView(openPath?: string | null): WebContentsView;
  setForcedWorkbookPath(path: string | undefined): void;
  setUiLang(lang: string): void;
  teardownDocsRenderer(contents: WebContents): void;
  docsQueryDirty(view: WebContentsView): Promise<boolean>;
}

/**
 * Chrome we hide inside every editor view.
 *
 * Their AI dock is Genspark-account-bound and Bobble's own chat is the chat, so
 * the dock is dead weight that was taking roughly half the canvas width. Not
 * registering its IPC (see vendor/genoffice/embed/index.ts) stops it FUNCTIONING
 * but not DRAWING — the renderer still lays it out, which is why hiding it here
 * is a second, separate step rather than a belt-and-braces duplicate.
 *
 * Done as injected CSS rather than a patch to their components so the vendored
 * tree stays as close to upstream as possible — this is a fork we have to
 * cherry-pick into, and every edited file is a future merge conflict.
 *
 * The trademark rule (Apache-2.0 §6 grants no trademark rights) is also served
 * here: `.ai-panel` / `.copilot` carry the Genspark wordmark and logo.
 */
const HIDE_AI_DOCK_CSS = `
  /* Hide the DOCK, not the panel inside it. .ai-dock is a flex item with
     flex-shrink:0 and width:var(--ai-panel-width, 360px); hiding only its child
     .ai-panel left 360px of dead space reserved and squeezed the document into
     the remainder — which looked like a broken layout rather than a hidden
     dock. Same for sheets' .copilot, which is its own flex item. */
  .ai-dock, .copilot, .ai-panel, .ai-panel-resizer, .ai-rail { display: none !important; }

  /* The ribbon's AI slot. Every editor marks these buttons .ai-entry, so hiding
     the GROUP that contains one removes the Genspark wordmark and logo from the
     ribbon without leaving an empty ribbon group behind. */
  .ai-entry { display: none !important; }
  .ribbon-group:has(.ai-entry), .ribbon-tool-group:has(.ai-entry) { display: none !important; }

  /* The COLLAPSED form of that group. At narrow widths the ribbon folds a group
     into one dropdown button, and that button carries the "Genspark AI" label
     but none of the .ai-entry classes — so the selectors above stop matching at
     exactly the widths a canvas sidebar uses, and the wordmark floats back over
     the document when opened. scripts/vendor-genoffice.sh stamps the marker,
     because CSS cannot match text content. */
  [data-rbgroup="pd-ai-suppressed"] { display: none !important; }

  /* Slides renders the AI commands a SECOND time, in a floating bar over the
     slide canvas that shares nothing with the ribbon — .stage-ai-bar inside
     .stage-zoom-box. Three container guesses failed to hide it; one DOM query
     named it. The lesson is in the commit message: query the DOM before
     theorising about which container something lives in. */
  .stage-ai-bar, [class*="ai-bar"], .stage-ai-btn { display: none !important; }

  /* The slide navigator eats roughly half of a narrow canvas, which is why a
     deck opened in the sidebar was fitting to 20% — the stage had almost no
     room left. the user: "this is absolutely tiny by the way in the UI by default,
     that can't be acceptable." Below a tablet-ish width the rail is the first
     thing to go; the tab bar and the status bar still say which slide you are
     on, and it comes back the moment the canvas is widened. */
  @media (max-width: 900px) {
    .slide-list, .thumb-resizer { display: none !important; }
  }
`;

let seam: OfficeSeam | null = null;
let seamTried = false;

/**
 * The live theme, remembered so a view created LATER is themed at birth. Without
 * this, opening a second document after a theme change gives it the default
 * light chrome — a flash of white inside a dark app, and only on some tabs.
 */
let themeCss = officeThemeCss({}, false);
let themeDark = false;

/**
 * Everything a freshly loaded view needs, in one place.
 *
 * The dark stamp has to land as an ATTRIBUTE, not just CSS: the spreadsheet grid
 * is drawn by Univer rather than the DOM, so CSS cannot reach it, and the
 * vendored sheets app reads `data-pd-dark` when it constructs Univer. The
 * runtime call after that corrects an editor that was built before we stamped —
 * creation-time alone leaves an already-open document stale the moment the app
 * theme changes.
 */
function applyToView(wc: WebContents | undefined): void {
  if (!wc || wc.isDestroyed()) return;
  void wc.insertCSS(themeCss).catch(() => undefined);
  void wc.insertCSS(officeChromeCss(themeDark)).catch(() => undefined);
  void wc
    .executeJavaScript(
      `document.documentElement.dataset.pdDark = ${JSON.stringify(themeDark ? '1' : '0')};` +
        `window.__pdSetUniverDark?.(${themeDark});` +
        officeChromeScript(),
      true,
    )
    .catch(() => undefined);
}

export function setOfficeTheme(tokens: OfficeThemeTokens, dark: boolean): void {
  themeCss = officeThemeCss(tokens, dark);
  themeDark = dark;
  for (const entry of entries.values()) applyToView(entry.view.webContents);
}

/** Root of the vendored build output — repo tree in dev, resources when packaged. */
function vendorRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'genoffice')
    : join(app.getAppPath(), '..', '..', 'vendor', 'genoffice');
}

function moduleOut(root: string, name: string): string {
  return join(root, 'apps', name, 'out');
}

/**
 * Load + configure the seam once. Returns null when the vendored tree has not
 * been built, which is a supported state — see the file header.
 */
function loadSeam(): OfficeSeam | null {
  if (seamTried) return seam;
  seamTried = true;

  const root = vendorRoot();
  const bundle = join(root, 'embed', 'out', 'index.cjs');
  if (!existsSync(bundle)) {
    log.warn('office seam not built — office tabs unavailable', { bundle });
    return null;
  }

  try {
    // A real CJS require, not a bundler-resolved import: the seam is built
    // separately from us (scripts/build-genoffice.mjs) and must stay outside
    // our main bundle, or a fork rebuild would force a Bobble rebuild.
    const mod = requireCjs(bundle) as OfficeSeam;

    // Before anything renders: upstream's i18n defaults to 'zh'.
    try {
      mod.setUiLang('en');
    } catch {
      /* older vendor build without the export — ribbons stay zh, nothing breaks */
    }

    const docs = moduleOut(root, 'docs');
    const sheets = moduleOut(root, 'sheets');
    const slides = moduleOut(root, 'slides');
    const pdf = moduleOut(root, 'pdf');
    const markdown = moduleOut(root, 'markdown');

    mod.configureDocsRuntime({
      preloadPath: join(docs, 'preload', 'index.js'),
      rendererFile: join(docs, 'renderer', 'index.html'),
    });
    mod.configureSheetsRuntime({
      preloadPath: join(sheets, 'preload', 'index.js'),
      rendererFile: join(sheets, 'renderer', 'index.html'),
      sidecarPath: join(
        root,
        'apps/sheets/native/xlsx-engine/target/release',
        process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar',
      ),
    });
    // Slides names its fields differently from the other four. Upstream
    // inconsistency, not a typo here.
    mod.configureSlidesRuntime({
      preloadPath: join(slides, 'preload', 'index.js'),
      rendererFilePath: join(slides, 'renderer', 'index.html'),
    });
    mod.configurePdfRuntime({
      preloadPath: join(pdf, 'preload', 'index.js'),
      rendererFile: join(pdf, 'renderer', 'index.html'),
    });
    mod.configureMarkdownRuntime({
      preloadPath: join(markdown, 'preload', 'index.js'),
      rendererFile: join(markdown, 'renderer', 'index.html'),
    });

    // Their AI/project/home/tabs IPC is deliberately never registered — see the
    // note in vendor/genoffice/embed/index.ts. Only the document channels.
    mod.registerDocsIpc();
    mod.registerSheetsIpc();

    seam = mod;
    log.info('office seam loaded', { root });
    return seam;
  } catch (err) {
    log.error('office seam failed to load', { err: String(err) });
    return null;
  }
}

export function officeAvailable(): boolean {
  return loadSeam() !== null;
}

/**
 * Repaint an owner's visible office views. Same root cause as the browser
 * overlay: an occluded native view can come back as a blank frame because its
 * compositor surface was dropped and nothing schedules a paint on restore.
 */
function invalidateOwned(owner: WebContents): void {
  for (const entry of entries.values()) {
    if (entry.owner === owner && entry.visible && !entry.view.webContents?.isDestroyed()) {
      entry.view.webContents.invalidate();
    }
  }
}

function wireOwner(owner: WebContents, win: BrowserWindow): void {
  if (wiredOwners.has(owner.id)) return;
  wiredOwners.add(owner.id);
  owner.once('destroyed', () => {
    wiredOwners.delete(owner.id);
    for (const [tabId, entry] of [...entries]) {
      if (entry.owner === owner) destroyView(tabId);
    }
  });
  const repaint = (): void => invalidateOwned(owner);
  win.on('show', repaint);
  win.on('restore', repaint);
  win.on('focus', repaint);
}

function makeView(s: OfficeSeam, kind: OfficeKind, filePath: string): WebContentsView {
  switch (kind) {
    case 'docs':
      return s.createDocsView(filePath);
    case 'slides':
      return s.createSlidesView(filePath);
    case 'pdf':
      return s.createPdfView(filePath);
    case 'markdown':
      return s.createMarkdownView(filePath);
    case 'sheets':
      // Queue BEFORE constructing: the renderer consumes the queued path once
      // Univer has mounted, which is after this call returns.
      s.setForcedWorkbookPath(filePath);
      return s.createSheetsView({ includeAiHandlers: false });
  }
}

export function createOfficeView(
  tabId: string,
  kind: OfficeKind,
  filePath: string,
  owner: WebContents,
): { ok: boolean; created?: boolean; error?: string } {
  const existing = entries.get(tabId);
  if (existing) return { ok: true, created: false };

  const s = loadSeam();
  if (s === null) return { ok: false, error: 'office editors are not available in this build' };

  const win = BrowserWindow.fromWebContents(owner);
  if (win === null) {
    log.warn('office:create with no owning window', { tabId });
    return { ok: false, error: 'no owning window' };
  }

  let view: WebContentsView;
  try {
    view = makeView(s, kind, filePath);
  } catch (err) {
    log.error('office view creation failed', { tabId, kind, err: String(err) });
    return { ok: false, error: String(err) };
  }

  // Inject on EVERY load, not once: their editors navigate internally (new
  // document, reload after save) and a one-shot injection silently stops
  // applying the first time that happens.
  const applyChrome = (): void => {
    void view.webContents?.insertCSS(HIDE_AI_DOCK_CSS).catch(() => undefined);
    applyToView(view.webContents);
  };
  view.webContents.on('dom-ready', applyChrome);
  // Again after load: Univer is constructed during the app's mount, which is
  // after dom-ready, so the runtime setDarkMode hook does not exist yet then.
  view.webContents.on('did-finish-load', applyChrome);
  applyChrome();

  /**
   * Force the compositor to hand this view a display surface once it has
   * loaded.
   *
   * MEASURED: the FIRST office view of a session never paints — capturePage()
   * returns an empty image forever while the view reports visible:true with
   * correct bounds. It is not format-specific; reordering the acceptance probe
   * moved the failure from docx to xlsx, which is what proved it positional.
   * The cause is that opening the first office tab is also what opens the canvas
   * panel, so the view is attached and shown while the window has not yet
   * allocated that region, and nothing later re-asserts it.
   *
   * A bare invalidate() is not enough — there is no surface to invalidate. The
   * visibility toggle is what makes Electron allocate one.
   */
  view.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const entry = entries.get(tabId);
      if (entry === undefined || !entry.visible) return;
      const wc = entry.view.webContents;
      if (!wc || wc.isDestroyed()) return;
      entry.view.setVisible(false);
      entry.view.setVisible(true);
      wc.invalidate();
    }, 120);
  });

  view.setVisible(false);
  win.contentView.addChildView(view);
  entries.set(tabId, { view, owner, visible: false, kind, filePath, lastW: 0, lastH: 0 });
  wireOwner(owner, win);
  log.info('office view created', { tabId, kind, wcId: view.webContents.id });
  return { ok: true, created: true };
}

/**
 * Make the editor re-measure itself against the view it now occupies.
 *
 * A `resize` event is the documented way in, but Univer debounces it and reads
 * the size from its own container observer, which does not always run for a
 * host-driven resize. So we do both: fire the event, and — for the sheets and
 * slides renderers — ask Univer's render units to re-size explicitly. Belt and
 * braces is right here because the failure is silent and looks like a layout
 * bug rather than a missed notification.
 */
function reflow(entry: Entry): void {
  const wc = entry.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  const js = `(() => {
    window.dispatchEvent(new Event('resize'));
    try {
      // The editors keep their instance in module scope, so the only way in is
      // the hook the vendored App.tsx installs for exactly this.
      window.__pdUniverResize?.();
    } catch { /* the editors differ; the event above is the floor */ }
    // Two frames later: the flex layout settles first, and a canvas resized
    // against a stale container is the bug we are fixing, not a fix for it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      window.__pdUniverResize?.();
    }));
  })()`;
  wc.executeJavaScript(js, true).catch(() => undefined);
}

export function setBoundsFor(tabId: string, bounds: OfficeBounds, visible: boolean): void {
  const entry = entries.get(tabId);
  if (entry === undefined) return;
  const next = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  const grew = next.width !== entry.lastW || next.height !== entry.lastH;
  entry.lastW = next.width;
  entry.lastH = next.height;
  entry.view.setBounds(next);
  // MEASURED: dragging the canvas divider took the view from 440px to 760px
  // wide and Univer's grid canvas stayed at 458.5px — 300px of dead background
  // on the right, which is exactly what the user saw. The editors size their canvas
  // once and only reflow on a `resize` event; a WebContentsView resized from
  // the main process does not reliably deliver one to the guest. We already
  // knew this — the toolbar toggle dispatches the same event for the same
  // reason — it just was never wired to the view's own geometry.
  if (grew) reflow(entry);
  if (entry.visible !== visible) {
    entry.view.setVisible(visible);
    entry.visible = visible;
    // Show edge: the hidden→visible transition can present one stale frame
    // before the next paint lands, so force a repaint the moment we reveal.
    if (visible && !entry.view.webContents?.isDestroyed()) entry.view.webContents.invalidate();
  }
}

export function destroyView(tabId: string): void {
  const entry = entries.get(tabId);
  if (entry === undefined) return;
  entries.delete(tabId);
  try {
    BrowserWindow.fromWebContents(entry.owner)?.contentView.removeChildView(entry.view);
  } catch {
    /* window already gone */
  }
  try {
    const wc = entry.view.webContents;
    // A destroyed WebContentsView leaves `webContents` UNDEFINED, not merely
    // destroyed — guard the access itself, not just isDestroyed().
    if (wc && !wc.isDestroyed()) {
      if (entry.kind === 'docs') seam?.teardownDocsRenderer(wc);
      wc.close();
    }
  } catch (err) {
    log.warn('office view teardown', { tabId, err: String(err) });
  }
  log.info('office view destroyed', { tabId });
}

/** Last capture failure reason, surfaced to probes — silence is not a diagnosis. */
export let lastCaptureError: string | null = null;

export async function captureView(tabId: string): Promise<string | null> {
  const entry = entries.get(tabId);
  if (entry === undefined) {
    lastCaptureError = `no view for tab ${tabId}`;
    return null;
  }
  const wc = entry.view.webContents;
  if (!wc || wc.isDestroyed()) {
    lastCaptureError = 'webContents gone';
    return null;
  }
  lastCaptureError = `visible=${entry.visible} bounds=${JSON.stringify(entry.view.getBounds())}`;
  try {
    // capturePage forces a renderer frame even when occluded or on another
    // Space, unlike screencapture(1) — which this host denies anyway.
    const img = await wc.capturePage();
    if (img.isEmpty()) {
      lastCaptureError = `empty image; ${lastCaptureError}`;
      return null;
    }
    lastCaptureError = null;
    return img.toDataURL();
  } catch (err) {
    lastCaptureError = `${String(err)}; ${lastCaptureError}`;
    log.warn('office capture failed', { tabId, err: String(err) });
    return null;
  }
}

export async function isDirty(tabId: string): Promise<boolean> {
  const entry = entries.get(tabId);
  if (entry === undefined || entry.kind !== 'docs' || seam === null) return false;
  try {
    return await seam.docsQueryDirty(entry.view);
  } catch {
    return false;
  }
}

/**
 * Synthesize a left click inside the editor. Playwright drives the DOM, and the
 * editor is a native view above it — without this there is no way to exercise
 * the ribbon from a probe, so "clicking around" would be a claim rather than a
 * check.
 */
export function clickView(tabId: string, x: number, y: number): boolean {
  const entry = entries.get(tabId);
  const wc = entry?.view.webContents;
  if (!wc || wc.isDestroyed()) return false;
  const at = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as const;
  // Focus first and move before pressing. A WebContentsView that has never been
  // focused drops synthetic input on the floor, and a down/up with no preceding
  // move lands without the hover state many ribbon controls key off — both look
  // identical to "the click did nothing".
  wc.focus();
  wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  wc.sendInputEvent({ ...at, type: 'mouseDown' });
  wc.sendInputEvent({ ...at, type: 'mouseUp' });
  return true;
}

/** Test seam: how many views are live right now. */
export function liveViewCount(): number {
  return entries.size;
}
