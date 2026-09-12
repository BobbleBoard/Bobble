import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { claudePaths, parseClaudeWindowState } from '@pi-desktop/importers';
import { excludeCacheFromIndexing } from '@pi-desktop/inference';
import { createIpcEventSender, createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type NativeImage,
  Notification,
  nativeImage,
  screen,
  session,
  type WebContents,
  type WebPreferences,
} from 'electron';
import { registerAfmIpc } from './afm/afm-main';
import { resolveBundledPackageAsset } from './app-paths';
import { isBackgroundMode, isHiddenMode } from './background-mode';
import { registerBrowserAgentIpc } from './canvas/browser-agent';
import { registerBrowserIpc } from './canvas/browser-manager';
import {
  harnessAssetsPresent,
  registerCanvasIpc,
  registerCanvasProtocol,
  registerCanvasSchemesAsPrivileged,
  registerFileProtocol,
} from './canvas/canvas-main';
import { registerConnectorsIpc } from './connectors/connectors-main';
import { registerCorpIpc } from './corp/corp-main';
import { fsHandlers } from './fs-handlers';
import {
  disposeGen,
  type GenQueueControl,
  registerGenCatalogIpc,
  registerGenIpc,
} from './gen/gen-manager';
import { startGuardian } from './gen/guardian-main';
import { genWorkerCandidates, resolveGenWorkerScript } from './gen/worker-path';
import { registerGen3dIpc } from './gen3d/gen3d-main';
import { registerImportIpc } from './import/import-main';
import {
  getInferenceUtility,
  getLoadedModel,
  heavyJobEco,
  parkChatModel,
  pushPowerSettings,
  registerLlmIpc,
  resumeChatModel,
  shutdownInference,
} from './inference/llm-main';
import type { AppEventMap, CoreInvokeMap, FsInvokeMap } from './ipc-contract';
import { disposeMacAgent, registerMacAgentIpc } from './mac/mac-agent';
import { registerStoreIpc } from './model-store/store-main';
import { notifyDecision } from './notify-gate';
import { registerOfficeIpc } from './office/office-ipc';
import { createScheduledRunBridge, registerPiIpc } from './pi/pi-main';
import { registerProjectIpc } from './project/project-main';
import { createRendererRecovery } from './renderer-recovery';
import { registerScheduledHandlers } from './scheduled/scheduled-main';
import {
  applySettingsEnvFromDisk,
  readSettings,
  registerSettingsIpc,
} from './settings/settings-main';
import { registerSkillsIpc } from './skills/skills-main';
import { comfyOrigin, disposeStudio, registerStudioIpc } from './studio/studio-main';
import { disposeAllPtys, registerPtyIpc } from './terminal/pty-manager';
import {
  isTrustedIpcEvent,
  isTrustedWebContents,
  registerTrustedSender,
  type ValidatableIpcEvent,
} from './trusted-senders';
import { TRAFFIC_LIGHTS } from './window-chrome';
import { resolveRendererTarget, resolveSecondInstanceWindow } from './window-policy';

// dist-electron is bundled to CJS (sandboxed preloads must be CommonJS), so
// __dirname is available at runtime.
const DIST_ELECTRON = __dirname;
const DIST_RENDERER = path.join(__dirname, '../dist');

const log = createLogger('desktop:main');
const events = createIpcEventSender<AppEventMap>();

/*
 * HEADED, BUT NOT IN YOUR FACE (the user: "is it possible for you to open the app in
 * a non focus stealing background way but still headed window?").
 *
 * A probe run needs a real window — GPU rendering, honest screenshots — but it
 * should not yank the keyboard away, repeatedly, for the length of a run.
 *
 * This has to happen HERE, at module scope, not in `whenReady`. macOS decides
 * whether an app becomes the active application during launch, and by the time
 * the ready event fires it already has: setting the policy there fixed the Dock
 * tile and nothing else (measured — the user: "that still stole focus"). 'accessory'
 * set before ready means the app owns windows but never activates.
 *
 * Playwright still drives it normally: its input is synthesised into the
 * webContents over CDP, not routed through the OS focus.
 */
if (process.platform === 'darwin' && isBackgroundMode()) {
  app.setActivationPolicy?.('accessory');
  app.dock?.hide();
}

// The `pd-preview://` canvas harness scheme must be registered privileged
// BEFORE app 'ready' (Electron requirement); the handler is attached in
// whenReady. The harness dir is resolved repo-relative in dev and
// bundle-relative (inside the asar) when packaged, mirroring pi-main.ts's
// extension resolution (see app-paths.ts). The main process reads these files
// with readFileSync, which the Electron fs shim serves straight from the asar.
const HARNESS_DIR = resolveBundledPackageAsset('canvas', 'harness');
registerCanvasSchemesAsPrivileged();

let mainWindow: BrowserWindow | null = null;
let canvasPopoutWindow: BrowserWindow | null = null;

// The "Pi caret" app mark (build/icon.png). Packaged builds get their bundle
// icon from build/icon.icns (electron-builder mac.icon), but that does not set
// the RUNTIME dock/window image in dev, so load the PNG here for the dev window
// + dock. build/ is a sibling of dist-electron (apps/desktop/build) in dev; it
// is not shipped inside the asar, so the packaged path simply resolves empty
// and the .icns bundle icon stands.
const ICON_PATH = path.join(DIST_ELECTRON, '../build/icon.png');

function appIconImage(): NativeImage | null {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

/**
 * On first run only (no onboarding.json yet), size the initial window from the
 * user's Claude Desktop window bounds so it "opens where they left Claude". Pure
 * read of window-state.json via the importers parser (never touches auth). E2E
 * is skipped so probe window geometry stays deterministic.
 */
function firstRunClaudeBounds(): Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'x' | 'y'
> | null {
  if (process.env.PI_E2E === '1') return null;
  const home = os.homedir();
  try {
    if (fs.existsSync(path.join(home, '.pi', 'desktop', 'onboarding.json'))) return null;
  } catch {
    return null;
  }
  let text: string | null = null;
  try {
    text = fs.readFileSync(claudePaths(home).windowState, 'utf8');
  } catch {
    return null;
  }
  const { bounds } = parseClaudeWindowState(text);
  if (bounds === null || bounds.isMaximized || bounds.isFullScreen) return null;
  /*
   * CLAMP TO THE SCREEN, not just to our own minimums.
   *
   * This adopted Claude Desktop's saved size and position verbatim. When those
   * bounds are taller than the usable area — or low enough that the bottom falls
   * under the dock — Bobble opens with its bottom edge off-screen, and the two
   * things pinned there go with it. the user: "odd UI bug squishing the should be
   * pinned bottom left area to the bottom." The sidebar's profile footer and the
   * composer's model row were both cut off on the same line, which is the shape
   * of a window hanging off the display rather than of a layout squeezing (the
   * footer measures a correct 48px inside the viewport at every size we tested).
   */
  const area = screen.getDisplayMatching({
    x: Math.round(bounds.x ?? 0),
    y: Math.round(bounds.y ?? 0),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }).workArea;
  const width = Math.min(Math.max(640, Math.round(bounds.width)), area.width);
  const height = Math.min(Math.max(480, Math.round(bounds.height)), area.height);
  const out: Pick<BrowserWindowConstructorOptions, 'width' | 'height' | 'x' | 'y'> = {
    width,
    height,
  };
  if (bounds.x !== undefined && bounds.y !== undefined) {
    // Slide it back on-screen rather than dropping the position entirely — the
    // point of adopting these bounds is that the window lands where they expect.
    out.x = Math.min(Math.max(Math.round(bounds.x), area.x), area.x + area.width - width);
    out.y = Math.min(Math.max(Math.round(bounds.y), area.y), area.y + area.height - height);
  }
  return out;
}

/**
 * Chromium's permission names for writing the clipboard. `writeText` asks for
 * `clipboard-sanitized-write`; the unsanitised name appears on older builds and
 * for richer payloads, so both are listed rather than guessing which one this
 * Electron will send. Granted ONLY to our own windows (see the handler below).
 */
const CLIPBOARD_WRITE_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'clipboard-write',
]);

const SHARED_WEB_PREFERENCES: WebPreferences = {
  preload: path.join(DIST_ELECTRON, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

/** Load index.html (packaged) or the dev server, threading the E2E opt-in plus
 * any window-specific query (e.g. the canvas pop-out flag). */

/**
 * Shrink and nudge a window until it lies inside the display's usable area.
 * A window taller than the screen has its chrome behind the menu bar and its
 * footer under the dock, and no amount of CSS can help.
 */
export function fitToWorkArea(win: BrowserWindow): void {
  try {
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, area.width);
    const height = Math.min(b.height, area.height);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
    if (width !== b.width || height !== b.height || x !== b.x || y !== b.y) {
      log.info('window clamped to the usable area', { from: b, to: { x, y, width, height } });
      win.setBounds({ x, y, width, height });
    }
  } catch {
    // A display we cannot read is not a reason to fail to open a window.
  }
}

function loadRenderer(win: BrowserWindow, extraQuery?: Record<string, string>): void {
  const target = resolveRendererTarget({
    isPackaged: app.isPackaged,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    e2e: process.env.PI_E2E === '1',
    noServer: process.env.PI_E2E_NO_SERVER === '1',
  });
  if (target.kind === 'dev-server') {
    const url = new URL(target.url);
    for (const [key, value] of Object.entries(extraQuery ?? {})) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    const query = { ...(target.query ?? {}), ...(extraQuery ?? {}) };
    const options = Object.keys(query).length === 0 ? undefined : { query };
    void win.loadFile(path.join(DIST_RENDERER, 'index.html'), options);
  }
}

/**
 * Bind {@link createRendererRecovery} to a WebContents so a dead renderer
 * reloads itself instead of leaving a blank, unreloadable window. Also logs the
 * exact `reason`/`exitCode` — that is the signal that tells an OOM apart from a
 * GPU reset or a native crash when diagnosing what killed it.
 */
function attachRendererRecovery(contents: WebContents, label: string): void {
  const recovery = createRendererRecovery({
    reload: () => contents.reload(),
    isDestroyed: () => contents.isDestroyed(),
    now: () => Date.now(),
    log: (message, meta) => log.warn(message, { window: label, ...meta }),
  });
  contents.on('render-process-gone', (_event, details) => {
    recovery.onRenderProcessGone({ reason: details.reason, exitCode: details.exitCode });
  });
  // A hung (not dead) renderer is a different failure — don't reload it out from
  // under the user, but do surface it so a freeze is never silent.
  contents.on('unresponsive', () => log.warn('renderer unresponsive', { window: label }));
  contents.on('responsive', () => log.info('renderer responsive again', { window: label }));
}

function createMainWindow(): BrowserWindow {
  const icon = appIconImage();
  const win = new BrowserWindow({
    title: 'Bobble',
    // Roomier default so the chat + canvas (situation room, live files/terminal)
    // aren't squished side-by-side on first launch.
    width: 1440,
    height: 940,
    // 640 was below what the 3D studio can physically lay out: its rail (74) +
    // panel (232 min) + viewport (200 min) + assets panel (240 min) = 746, so
    // dragging the window narrower pushed the Assets panel out past the right
    // edge and clipped it silently (.tp is overflow:hidden, so nothing
    // scrolled to reveal it). Covered by tests/e2e/tripo-resize-probe.mjs.
    minWidth: 760,
    minHeight: 560,
    // First run: adopt the user's Claude Desktop window size/position if present.
    ...firstRunClaudeBounds(),
    // macOS shows the dock image (set in whenReady); icon is used on win/linux.
    ...(icon !== null ? { icon } : {}),
    titleBarStyle: 'hiddenInset',
    /*
     * The cluster's position comes from `window-chrome.ts`, which the RENDERER
     * imports too — that shared module is what keeps the sidebar toggle beside
     * the lights instead of under them. The arithmetic and the reason for it
     * live there; nothing here should be nudged by feel.
     */
    trafficLightPosition: { x: TRAFFIC_LIGHTS.x, y: TRAFFIC_LIGHTS.y },
    // Claude-dark bg-base; avoids a white flash before the renderer paints.
    backgroundColor: '#262624',
    // In background mode the window is created hidden. A window shown the
    // ordinary way asks to become key, which pulls focus even under the
    // 'accessory' activation policy — and by default it is not shown at all
    // (see background-mode.ts: a hidden window still renders, animates and
    // screenshots).
    ...(isBackgroundMode() ? { show: false } : {}),
    webPreferences: SHARED_WEB_PREFERENCES,
  });
  if (isBackgroundMode() && !isHiddenMode()) {
    // PI_E2E_VISIBLE — someone wants to watch. Inactive, so it still never
    // takes focus.
    win.once('ready-to-show', () => win.showInactive());
  }

  /*
   * DID APPKIT ACTUALLY PUT THEM THERE?
   *
   * The renderer positions its top-left chrome from the same constants we asked
   * for above, so if the platform ever declines the request — a future Electron,
   * a different title-bar style, a full-screen transition — the two would part
   * company silently and a control would end up under the zoom button. Reading
   * the position back is the cheapest way to make that loud instead.
   *
   * A warning, not a throw: a misplaced toggle is a cosmetic bug, and refusing
   * to open the app over one would be worse than the bug.
   */
  if (process.platform === 'darwin') {
    const actual = win.getWindowButtonPosition();
    if (actual !== null && (actual.x !== TRAFFIC_LIGHTS.x || actual.y !== TRAFFIC_LIGHTS.y)) {
      log.warn('traffic lights are not where we put them — top-left chrome may overlap', {
        asked: TRAFFIC_LIGHTS,
        actual,
      });
    }
  }

  // Only IPC events from this window's main frame pass the invoke gates
  // (trusted-senders.ts); anything else that ever gets webContents is out.
  registerTrustedSender(win.webContents);

  // The renderer never opens windows or navigates; deny both outright.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // The app must never need a force quit: a dead renderer leaves the window
  // painting `backgroundColor` forever with Cmd+R inert (the process that would
  // service it is gone), so recovery has to come from here. See renderer-recovery.
  attachRendererRecovery(win.webContents, 'main-window');

  win.webContents.on('did-finish-load', () => {
    // Sent before React mounts; delivery relies on the preload pre-mount buffer.
    events.send(win.webContents, 'app:boot', { sentAt: Date.now() });
  });

  // DEV diagnostic: mirror renderer `[pi-diag]` console lines into the terminal so
  // the server-start / model-load DECISIONS (which live in the renderer, not the
  // main process) are visible next to the main logs — otherwise a "no server
  // started, no log" failure is invisible. Handles both Electron console-message
  // signatures. Dev only; gated on the prefix so it never mirrors general noise.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const msg =
        typeof args[2] === 'string'
          ? (args[2] as string)
          : ((args[0] as { message?: string })?.message ?? '');
      if (msg.includes('[pi-diag]')) log.info(`renderer ${msg}`);
    });
  }

  // Dev overrides for the experimental features: `PI_DESKTOP_CORP=1` surfaces a
  // `?corp=1` param (settings-store `productionHarnessEnabled`) so a dev launch
  // drives the corp flow, and `PI_DESKTOP_GEN=1` surfaces `?gen=1`
  // (`generationEnabled`) so a dev launch mounts the live gen surface + hook —
  // both without toggling the persisted settings. No env ⇒ no param ⇒ default app.
  const devQuery: Record<string, string> = {};
  if (process.env.PI_DESKTOP_CORP === '1') devQuery.corp = '1';
  // Testing only: force the first message of a chat into a corporation, so a probe
  // can exercise a corp run without depending on the model choosing to promote.
  if (process.env.PI_DESKTOP_CORP_FORCE === '1') devQuery.corpForce = '1';
  if (process.env.PI_DESKTOP_GEN === '1') devQuery.gen = '1';
  // Separate opt-in for the live activity HUD (CorpDebugHud) — decoupled from the
  // corp feature flag so a normal `PI_DESKTOP_CORP=1` run shows no debug overlay.
  if (process.env.PI_DESKTOP_CORP_HUD === '1') devQuery.corphud = '1';
  // Tripo 3D workspace preview (UI-only view): PI_DESKTOP_TRIPO=1 surfaces `?tripo=1`.
  if (process.env.PI_DESKTOP_TRIPO === '1') devQuery.tripo = '1';
  /*
   * Candidate designs for a screen, off to one side of the shipping one:
   * PI_DESKTOP_CANDIDATES=schedule → `?candidates=schedule`. Dev/probe only —
   * nothing in the app links to it, so the real Scheduled and Connectors
   * screens keep working while a replacement is being drawn.
   */
  const candidates = process.env.PI_DESKTOP_CANDIDATES;
  if (candidates === 'schedule' || candidates === 'connectors') devQuery.candidates = candidates;
  if (process.env.PI_DESKTOP_CANDIDATE_V !== undefined)
    devQuery.v = process.env.PI_DESKTOP_CANDIDATE_V;
  /*
   * CLAMP TO THE SCREEN — the DEFAULT size too, not just adopted bounds.
   *
   * MEASURED on the user's machine: work area 1512x868, window created at 1440x940.
   * Electron centres what does not fit, so y came out at -31 — the title bar
   * behind the menu bar AND the bottom 8px below the usable area. Both ends
   * clipped, permanently, and resizing cannot recover it because the size is
   * re-applied on every launch. the user: "the bottom left is cut off again … the
   * whole chat input bar is cut off also when I try resizing."
   *
   * `firstRunClaudeBounds` already clamps the bounds it adopts; this clamps
   * whatever the window actually ended up with, which is the only place that
   * catches a default taller than somebody's screen.
   */
  fitToWorkArea(win);
  loadRenderer(win, Object.keys(devQuery).length > 0 ? devQuery : undefined);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

/**
 * The standalone canvas pop-out window: the SAME trusted app renderer, loaded
 * with `?canvasPopout=1` so it mounts only the canvas (no pi session). It
 * legitimately carries the app preload (it is app content, not the sandboxed
 * canvas iframe); the artifact iframe inside it stays isolated as always.
 * Returns whether a fresh window was created so the caller knows to push vs.
 * let the new window fetch the artifact itself.
 */
function openCanvasPopoutWindow(): { webContents: BrowserWindow['webContents']; created: boolean } {
  if (canvasPopoutWindow !== null && !canvasPopoutWindow.isDestroyed()) {
    if (canvasPopoutWindow.isMinimized()) canvasPopoutWindow.restore();
    if (!isBackgroundMode()) canvasPopoutWindow.focus();
    return { webContents: canvasPopoutWindow.webContents, created: false };
  }
  const win = new BrowserWindow({
    title: 'Canvas',
    width: 720,
    height: 680,
    minWidth: 360,
    minHeight: 320,
    backgroundColor: '#262624',
    webPreferences: SHARED_WEB_PREFERENCES,
  });
  registerTrustedSender(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  attachRendererRecovery(win.webContents, 'canvas-popout');
  loadRenderer(win, { canvasPopout: '1' });
  canvasPopoutWindow = win;
  win.on('closed', () => {
    if (canvasPopoutWindow === win) canvasPopoutWindow = null;
  });
  return { webContents: win.webContents, created: true };
}

/**
 * Application menu. The ONE customization over the platform defaults is the Close
 * accelerator (blind-test round-2 #5): ⌘W is remapped to a renderer "close the
 * active canvas tab / current chat" action instead of closing the WINDOW, and
 * ⌘⇧W (plus the red traffic-light) closes the window. Standard role-based
 * submenus (edit/view/window) are kept so copy/paste/select-all/minimize/zoom
 * keep their usual shortcuts.
 *
 * ROOT CAUSE of the reported "⌘W quits the app": with NO application menu set,
 * Electron installs its default menu whose Window → Close item carries ⌘W and
 * closes the focused window; on the single-window app that reads as quitting.
 */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const sendCloseTab = (win: BrowserWindow | undefined): void => {
    const target = win ?? mainWindow ?? undefined;
    if (target !== undefined && target !== null && !target.isDestroyed()) {
      events.send(target.webContents, 'app:accelerator', { action: 'close-tab' });
    }
  };
  const closeWindowItem: MenuItemConstructorOptions = {
    label: 'Close Window',
    accelerator: 'CmdOrCtrl+Shift+W',
    role: 'close',
  };
  /*
   * ⌘R IS NOT A DOCUMENT RELOAD ANY MORE.
   *
   * the user: "⌘R clears really everything." It does — Electron's stock `reload`
   * role throws the document away, and with it the thread on screen, the canvas
   * tabs and where you were scrolled to. Almost none of that is the document's
   * to lose: the conversation lives in the pi child and on disk, and the app's
   * stores are module state a re-mount keeps. Only the React tree is broken
   * when someone reaches for ⌘R, so only the React tree needs rebuilding.
   *
   * So ⌘R asks the renderer to RE-MOUNT and put back what was on screen
   * (src/app-reload.ts), and ⌘⇧R remains the real, nothing-survives reload for
   * when the renderer is too far gone to answer.
   */
  const softReload = (win: BrowserWindow | undefined): void => {
    const target = win ?? mainWindow ?? undefined;
    if (target === undefined || target === null || target.isDestroyed()) return;
    events.send(target.webContents, 'app:accelerator', { action: 'soft-reload' });
  };
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        // `id` so a probe can invoke the item itself: a synthetic ⌘R from
        // Playwright never reaches the native menu, so driving the accelerator
        // is the only way to test what the accelerator actually does.
        id: 'safe-reload',
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: (_item, win) => softReload(win instanceof BrowserWindow ? win : undefined),
      },
      {
        id: 'hard-reload',
        label: 'Reload Window',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: (_item, win) => {
          const target = win instanceof BrowserWindow ? win : mainWindow;
          if (target !== null && !target.isDestroyed()) target.webContents.reload();
        },
      },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    ...(isMac
      ? []
      : [
          {
            label: 'File',
            submenu: [closeWindowItem, { type: 'separator' }, { role: 'quit' }],
          } as MenuItemConstructorOptions,
        ]),
    { role: 'editMenu' },
    viewMenu,
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          // ⌘W → close the active canvas tab / current chat in the renderer,
          // never the window (see AppEventMap 'app:accelerator').
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, win) => sendCloseTab(win instanceof BrowserWindow ? win : undefined),
        },
        closeWindowItem,
        ...(isMac
          ? [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'front' } as MenuItemConstructorOptions,
            ]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Reap every NON-pi child process on app quit, in the pi quit-hold's held
 * window (so it completes before `app.exit()`):
 *   - the inference utilityProcess + its llama-server grandchild (shutdownInference),
 *   - the long-lived pi-mac computer-use helper (disposeMacAgent), and
 *   - any terminal PTY/shell sessions (disposeAllPtys), and
 *   - the ComfyUI server, when the studio started one (disposeStudio).
 * The pi children (and, via their process group, their subagent grandchildren)
 * are reaped by the quit-hold's own `disposeAll`. `allSettled` so one slow/failed
 * teardown never blocks the others; the quit-hold's grace cap bounds the whole
 * wait. Guaranteed: no llama-server, pi, subagent-pi, or helper survives quit.
 */
async function reapChildProcesses(): Promise<void> {
  await Promise.allSettled([
    shutdownInference(),
    (async () => disposeMacAgent())(),
    (async () => disposeAllPtys())(),
    // Close the gen bridge socket server if the experimental stack stood it up.
    (async () => disposeGen())(),
    // The ComfyUI server is a Python process holding a model resident — the same
    // kind of survivor as an orphaned llama-server, and reaped the same way.
    (async () => disposeStudio())(),
  ]);
}

function registerAppIpc(): void {
  // ipcMain.handle always passes an IpcMainInvokeEvent (registration-side
  // guarantee), which satisfies the structural ValidatableIpcEvent slice.
  const allowSender = (event: unknown): boolean => isTrustedIpcEvent(event as ValidatableIpcEvent);

  registerIpcHandlers<CoreInvokeMap>(
    ipcMain,
    {
      'app:get-info': () => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        chromeVersion: process.versions.chrome ?? 'unknown',
        nodeVersion: process.versions.node ?? 'unknown',
        platform: process.platform,
        arch: process.arch,
        totalMemoryBytes: os.totalmem(),
        cpuCount: os.cpus().length,
      }),

      /*
       * TELL THE USER WHEN THEY ARE NOT LOOKING.
       *
       * A background chat could finish, or block on a question, with the only
       * sign being a dot in a sidebar the user is not on — or is not in the app
       * to see at all. The dot is right for "you are here"; this is for "you
       * are not".
       *
       * MAIN DECIDES WHETHER TO SHOW IT, because main is the side that knows.
       * `document.hasFocus()` in the renderer is true for a window sitting
       * behind another application on some platforms, which is exactly the case
       * a notification is for.
       *
       * A notification the OS refuses (permission not granted — and under a
       * per-checkout dev identity it silently never appears) reports
       * `shown:false` with the reason rather than pretending.
       */
      'app:notify': (req) => {
        /* Whether to interrupt is a pure decision (notify-gate.ts) — including
           the rule that a test suite must never post banners over the user's
           screen, which is the most literal form of "taking notice" there is. */
        const win = mainWindow;
        const decision = notifyDecision({
          backgroundMode: isBackgroundMode(),
          windowFocused: win !== null && !win.isDestroyed() && win.isFocused(),
          supported: Notification.isSupported(),
        });
        if (!decision.shown) return decision;
        try {
          const n = new Notification({ title: req.title, body: req.body });
          n.on('click', () => {
            const target = mainWindow;
            if (target === null || target.isDestroyed()) return;
            if (target.isMinimized()) target.restore();
            target.show();
            target.focus();
            events.send(target.webContents, 'app:notification-click', {
              sessionFile: req.sessionFile,
            });
          });
          n.show();
          return { shown: true };
        } catch (error) {
          log.warn('notify failed', { error: String(error) });
          return { shown: false, reason: String(error) };
        }
      },

      /* The dock badge is a COUNT, not a dot: "three chats want you" is worth
         more than "something wants you", and it is the only signal left once
         the app is hidden entirely. macOS-only; a no-op elsewhere. */
      'app:set-badge': (req) => {
        if (process.platform !== 'darwin' || app.dock === undefined) return { ok: false };
        app.dock.setBadge(req.count > 0 ? String(req.count) : '');
        return { ok: true };
      },

      /*
       * THE RELOAD THE CRASH CARD'S BUTTONS PRESS.
       *
       * They used to call `window.location.reload()` and assign
       * `window.location.search`, and BOTH are renderer-initiated navigations —
       * which `will-navigate` refuses a few lines above, deliberately. So the
       * one screen in the app whose entire job is to get you out of a broken
       * state had two buttons that did nothing, and the user had to reach for ⌘R.
       *
       * From here it is `webContents.reload()` / `loadRenderer()`: programmatic,
       * and therefore not a navigation for the guard to catch.
       */
      'app:reload-window': (req) => {
        const focused = BrowserWindow.getFocusedWindow();
        const win = focused !== null && !focused.isDestroyed() ? focused : mainWindow;
        if (win === null || win.isDestroyed()) return { ok: false };
        // `fresh` drops the query the window was loaded with (dev route params,
        // `?canvasPopout`) as well as every scrap of renderer state — the
        // "fresh window" the card offers. Plain reload keeps the same URL.
        if (req.fresh === true) loadRenderer(win);
        else win.webContents.reload();
        return { ok: true };
      },
    },
    { allowSender },
  );

  // Read-only fs channels (composer @-mention picker + session sidebar).
  registerIpcHandlers<FsInvokeMap>(ipcMain, fsHandlers, { allowSender });

  // Importer + onboarding channels (Claude/Codex config → pi; first-run gate).
  registerImportIpc(ipcMain, allowSender);

  // Inference supervisor (utilityProcess) proxy channels.
  registerLlmIpc(ipcMain, allowSender);

  // Generation modality catalog → renderer DTOs (gen:modality-catalog). Read-only
  // surfacing of the vetted image/audio/video/3d models the model browser lists;
  // always registered (harmless read-only enumeration).
  registerGenCatalogIpc(ipcMain, allowSender);

  // Bobble 3D studio engine (gen3d): catalog/downloads/generation for the
  // TRELLIS-2 / Mage-Flow / Hunyuan Paint / CubePart / AutoRemesher pipeline.
  // Currently the honest stub (real sizes, engineReady:false) — the sidecar
  // wave swaps the internals behind the same contract.
  registerGen3dIpc(ipcMain, allowSender, () => mainWindow?.webContents ?? null);

  /*
   * THE UNIFIED MODEL STORE. the user: "we need to be able to download anything and
   * store it properly in an organized format so that no matter what we add
   * either now or later we have an easy way to list relevant models and know
   * where their weights are stored their names relevant info etc."
   *
   * `llm:*` keeps the GGUF case (one file of a ladder, feeding a running
   * server). These channels take a whole Hugging Face repo of any modality into
   * `<cache>/store/<kind>/<slug>/`, with a manifest beside the weights — and
   * `store:list` answers across all three places weights currently live, so a
   * studio added later asks one question rather than inventing a fourth cache.
   */
  registerStoreIpc(
    ipcMain,
    allowSender,
    (channel, payload) => {
      const wc = mainWindow?.webContents;
      if (wc !== undefined) events.send(wc, channel, payload);
    },
    () => readSettings().hfToken || undefined,
  );

  /*
   * THE IMAGE & VIDEO STUDIO, on ComfyUI. the user: "let's have comfy as a
   * downloadable inference engine and then wire up a primitive for now
   * image/video studio) and have those run through it."
   *
   * The engine installs from Settings › Engines like any other; this is the part
   * that starts it and runs one graph. Registered unconditionally because it is
   * honest when the engine is absent — `studio:status` says so and the panel
   * offers the install rather than the app pretending the surface is missing.
   */
  registerStudioIpc(ipcMain, allowSender, (channel, payload) => {
    const wc = mainWindow?.webContents;
    if (wc !== undefined) events.send(wc, channel, payload);
  });

  // EXPERIMENTAL generation stack (default OFF). The full generation socket
  // bridge (`generate_image` / `generate_video` → JobQueue → mflux/MLX/ComfyUI,
  // progress streamed to the gen-image canvas surface) stands up ONLY when the
  // `experimentalGeneration` flag / `PI_DESKTOP_GEN=1` gate is on — so a signed
  // /Applications build with the flag off is byte-for-byte its current self (no
  // gen socket, no gen env published, and pi-main omits the `gen-tools`
  // extension too). Sibling to the corp gate. Standing this up BEFORE the first
  // pi spawn publishes PI_GEN_SOCK/PI_GEN_TOKEN for the gen-tools extension.
  // ComfyUI comes from the STUDIO's supervisor (`comfyOrigin`), which already
  // spawns and health-checks it — passing it here is what makes music, sound
  // effects and photoreal video reachable from the tools at all. Without it the
  // ComfyClient fell back to a rejection, and `generate_music` failed earlier
  // still, with `unknown or non-audio model ""`, because every ComfyUI audio
  // entry is `reserved` and so absent from `activeModels()`.
  //
  // NEXT (video pillar): pass `comfyInstall` (a real ComfyInstallManager whose
  // `emit` → `events.send('gen:comfy-install')`) to answer the modular-download
  // UI + drive the download-then-continue gate end-to-end.
  /*
   * ALWAYS, not only under the generation experiment.
   *
   * This IPC is a socket server and a job queue — no model, no worker, nothing
   * resident until a job runs — and the OmniSVG connector needs it in a default
   * build: a person installs OmniSVG from the Connectors page and expects `svg`
   * to work, experiment flag or no. What the experiment still gates is WHICH
   * TOOLS pi registers (pi-main publishes that as PI_DESKTOP_GEN_MEDIA), so a
   * default build's model surface stays exactly as clean as before unless the
   * user installs something that adds to it.
   */
  {
    /*
     * THE GUARDIAN — see gen/guardian-main.ts. Started before the queue exists
     * and handed it lazily, because admission closes over the guardian and the
     * guardian's levers close over the queue.
     */
    let genQueueRef: GenQueueControl | null = null;
    const guardian = startGuardian({
      queue: () => genQueueRef,
      mode: () => readSettings().powerMode,
      reserveGB: () => readSettings().powerReserveGB,
      announce: (event) => {
        const wc = mainWindow?.webContents ?? null;
        if (wc !== null && !wc.isDestroyed()) events.send(wc, 'gen:guardian', event);
      },
      log: (line) => log.info('guardian', { line }),
    });
    app.on('before-quit', () => guardian.stop());

    const genWorker = resolveGenWorkerScript({
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
    if (genWorker === undefined) {
      log.warn('gen worker script NOT FOUND — image generation will fail', {
        tried: genWorkerCandidates({
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        }),
      });
    }
    const genQueue = registerGenIpc({
      /*
       * Hold a heavy generation while the machine is struggling.
       *
       * the user: "leave a certain amount of memory available as a buffer so the
       * user can use computer as normal while generation and such occurs." An
       * image or video job is gigabytes of extra resident memory beside an
       * already-resident chat model, and under real pressure it is the single
       * worst thing to start — so it WAITS rather than being refused, and light
       * jobs still go through. See packages/inference/src/power-policy.ts.
       *
       */
      /*
       * NOT A GATE ANY MORE. the user: "low can't stop image generation requests,
       * it just has to lessen compute intensivity in some way sacrificing
       * speed to keep headroom." The policy's `allowHeavyJobs` used to refuse
       * every generation under 'low' with "the machine is under pressure";
       * now the policy says how GENTLY to run (`eco` below) and only the
       * guardian's per-job measurement — does THIS footprint fit beside the
       * reserve right now — can hold a job, or refuse one that can never fit.
       */
      heavyAllowed: (footprintGB) => guardian.admit(footprintGB),
      eco: () => heavyJobEco(),
      /*
       * …and when a job does not fit beside the chat model, the chat model is
       * the thing to give up for it (gen/make-room.ts): parked for the render,
       * back on the same URL before the caller hears the result.
       */
      room: {
        park: () => parkChatModel(),
        resume: () => resumeChatModel(),
        refresh: () => guardian.refresh(),
      },
      freshReading: () => guardian.refresh(),
      getWindow: () => (mainWindow !== null ? mainWindow.webContents : null),
      ...(genWorker !== undefined ? { workerScript: genWorker } : {}),
      comfyResolveOrigin: comfyOrigin,
      // gen event channels are a subset of AppEventMap; forward through the
      // app-wide sender (the cast only bridges the two generic key domains).
      sendEvent: (wc, channel, payload) =>
        events.send(wc, channel as keyof AppEventMap & string, payload as never),
      isTrusted: (event) => isTrustedIpcEvent(event),
      /*
       * THE PROMPT ENHANCER'S MODEL.
       *
       * `PI_DESKTOP_ENHANCER_BASE_URL` first, so a dedicated tiny model can be
       * pointed at without touching the chat model at all — that is the intended
       * shape, because the rewrite is a one-second job and the chat model is
       * often 27B and mid-conversation.
       *
       * Falling back to the RUNNING server keeps the feature alive out of the
       * box rather than dead until someone downloads a second model. The cost is
       * one short, user-initiated request against a server that is idle at that
       * moment (the user is looking at a studio, not chatting) — not the
       * per-turn background call that has repeatedly wrecked TTFT here.
       */
      resolveEnhancerEndpoint: () => {
        const base = process.env.PI_DESKTOP_ENHANCER_BASE_URL;
        if (base !== undefined && base !== '') {
          return { baseUrl: base, model: process.env.PI_DESKTOP_ENHANCER_MODEL ?? 'utility' };
        }
        return getInferenceUtility();
      },
    });
    genQueueRef = genQueue;
    log.info('experimental generation stack wired (gen bridge live)');
  }

  // Apple Foundation Models (on-device) capability gate + set-active. Also
  // publishes PI_AFM_HELPER_PATH so the pi child's provider-afm finds the helper.
  registerAfmIpc(ipcMain, allowSender);

  // Browser-agent bridge: stands up the local socket the browser-use extension
  // drives the canvas browser through, publishing PI_BROWSER_AGENT_SOCK/_TOKEN
  // for the pi child BEFORE its first spawn. Targets the main window for the
  // agent's browser tab.
  registerBrowserAgentIpc(() => (mainWindow !== null ? mainWindow.webContents : null));

  // Mac computer-use bridge: stands up the local socket the mac-computer-use
  // extension drives ANY Mac app through, publishing PI_MAC_SOCK/_TOKEN for the
  // pi child BEFORE its first spawn. The pi-mac Accessibility/CGEvent helper is
  // spawned from MAIN so the Accessibility + Screen-Recording TCC grants bind to
  // the signed Bobble.app bundle (never the pi child's exec path).
  registerMacAgentIpc();

  // Desktop settings (theme/permissions/effort/search keys/mcp mode/capabilities).
  registerSettingsIpc(ipcMain, allowSender, {
    // The power choice acts in the inference worker; settings is only where it
    // is kept. See pushPowerSettings.
    onPowerChanged: () => pushPowerSettings(),
  });

  // Projects (working folders): list/set/new/clear, persisted to projects.json.
  registerProjectIpc(ipcMain, allowSender);

  /* Scheduled tasks: storage + a 30s tick + HEADLESS execution. A due (or
     run-now) task runs in a throwaway top-level pi bridge here in main — no
     chat, no sidebar entry — and leaves only a run record. See
     scheduled/scheduled-runner.ts. */
  registerScheduledHandlers(ipcMain, {
    allowSender,
    getWindow: () => mainWindow ?? null,
    createRunBridge: createScheduledRunBridge,
    // So a run record can say what ran it ("41s · Gemma 4 12B").
    currentModel: getLoadedModel,
  });

  // Connectors gallery: catalog + registry read/mutate + /Applications scan.
  // Owns ~/.pi/desktop/mcp-connectors.json (the file the mcp-lite pi extension
  // reads); the model sees changes on the next pi session/spawn.
  registerConnectorsIpc(ipcMain, allowSender);

  // Skills: bundled catalog + install/remove into ~/.pi/agent/skills (the dir
  // the pi engine auto-discovers skills from); copies from app resources.
  registerSkillsIpc(ipcMain, allowSender);

  // EXPERIMENTAL coordination harness (CorpEngine): runs the harness `runCorp`
  // behind the local model server and streams situation-room events to the
  // window. Channels are always registered but only reached when the
  // experimental flag / `PI_DESKTOP_CORP=1` gate is on (sender-gated internally).
  registerCorpIpc();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow = resolveSecondInstanceWindow({
      isReady: app.isReady(),
      window: mainWindow,
      createWindow: createMainWindow,
    });
    // window.focus() alone does not reliably foreground across app
    // activations on macOS. Never in background mode: stealing focus is the
    // one thing that mode exists to prevent.
    if (mainWindow !== null && !isBackgroundMode()) app.focus({ steal: true });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  // Mirror any persisted web-search keys onto the env BEFORE the first pi spawn
  // so the initial session's web-tools extension sees them (it reads env once).
  applySettingsEnvFromDisk();

  void app.whenReady().then(() => {
    /*
     * Spotlight must not index 376 GB of model weights — see
     * packages/inference/src/paths.ts. Done here, once per launch, because the
     * cache root is created lazily by whichever engine first needs it.
     */
    void excludeCacheFromIndexing({
      mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
      writeFile: (file, data) => fs.promises.writeFile(file, data),
      exists: (file) =>
        fs.promises.access(file).then(
          () => true,
          () => false,
        ),
    }).then((r) => log.info('spotlight exclusion', { marker: r }));
    // Dev dock icon: show the Pi caret mark on macOS (packaged uses the .icns
    // bundle icon; this covers the unsigned dev/electron-run window).
    if (process.platform === 'darwin' && app.dock !== undefined) {
      const icon = appIconImage();
      if (icon !== null) app.dock.setIcon(icon);
    }
    // MICROPHONE. Chromium denies getUserMedia by default in Electron, and a
    // denial with no handler simply never resolves — the dictation button
    // looked dead rather than blocked (measured: click, no waveform, no error).
    // Grant ONLY audio capture, and only to our own windows; everything else a
    // page might ask for (camera, geolocation, notifications, MIDI…) stays
    // denied, so this widens the app's surface by exactly one capability.
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (!isTrustedWebContents(contents)) {
          callback(false);
          return;
        }
        // COPY BUTTONS. the user: "copy buttons don't actually copy to clipboard."
        // MEASURED: navigator.clipboard.writeText rejected with
        // "NotAllowedError: Write permission denied" in our own window, because
        // this handler denied every permission that was not 'media' — and every
        // call site wrote `void navigator.clipboard?.writeText(…)`, so the
        // rejection was swallowed and the button still flipped to a check.
        // Writing text the user just asked to copy, from our own UI, is the
        // whole interaction; it is granted here and nowhere else.
        if (CLIPBOARD_WRITE_PERMISSIONS.has(permission)) {
          callback(true);
          return;
        }
        if (permission !== 'media') {
          callback(false);
          return;
        }
        // 'media' covers camera AND microphone; the requested types say which.
        // Dictation needs audio only, so a request that also asks for video is
        // refused rather than quietly granted alongside it.
        const types = (details as { mediaTypes?: readonly string[] }).mediaTypes ?? [];
        callback(types.includes('audio') && !types.includes('video'));
      },
    );
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
      if (!isTrustedWebContents(contents)) return false;
      if (CLIPBOARD_WRITE_PERMISSIONS.has(permission)) return true;
      if (permission !== 'media') return false;
      const kind = (details as { mediaType?: string }).mediaType;
      return kind === 'audio' || kind === undefined;
    });
    registerAppIpc();
    registerPiIpc({
      extraTeardown: reapChildProcesses,
      // The window subagents run under: spawn_subagent routes to the app bridge,
      // which spawns each subagent as its own pi + streams it to the dropdown.
      getWindow: () => (mainWindow !== null ? mainWindow.webContents : null),
    });
    // Native canvas surfaces (Phase 2b): per-tab WebContentsView + PTY managers.
    registerBrowserIpc();
    registerOfficeIpc();
    registerPtyIpc();
    // Canvas: serve the pd-preview harness + wire the artifact pop-out window.
    if (!harnessAssetsPresent(HARNESS_DIR)) {
      log.warn('canvas harness assets missing; HTML artifacts will not render', {
        dir: HARNESS_DIR,
      });
    }
    registerCanvasProtocol(HARNESS_DIR);
    // Media scheme: stream project-file bytes (images/video/audio/pdf/3D/docs) to
    // the canvas surfaces, fenced to the app's working roots (see canvas-main.ts).
    registerFileProtocol();
    registerCanvasIpc(openCanvasPopoutWindow);
    // ⌘W closes the active tab, not the window (blind-test round-2 #5).
    installAppMenu();
    mainWindow = createMainWindow();
    log.info('main window created', {
      dev: !app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL),
    });
  });
}
