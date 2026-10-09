/**
 * THE QUICK PANEL — Bobble from anywhere.
 *
 * A global hotkey summons a small floating panel over whatever app is in
 * front: type, talk or capture, read the answer right there, keep the thread
 * going, and open it in the main window as an ordinary chat.
 *
 * ## How it stays instant
 *
 * The panel window is made ONCE, hidden, shortly after launch, with the app's
 * renderer already loaded in it (`?quickPanel=1`), so a hotkey only has to
 * place it and show it. Its chat is its own pi session, started on the first
 * summon, so the first question does not wait for a child to spawn.
 *
 * ## How it stays out of the way
 *
 * It is a non-activating panel (Electron's `type: 'panel'` — Electron 43 skips
 * app activation for panels in both `show` and `focus`). It takes the keyboard
 * WITHOUT making Bobble the active app, the way Spotlight does, so:
 *
 *   - the app you were in stays active, its menu bar stays up, and when the
 *     panel goes away the keyboard is simply back where it was;
 *   - it shows over full-screen apps and on every Space (a panel's collection
 *     behaviour), on the display under the pointer;
 *   - what was in front, and the text selected in it, are read BEFORE the panel
 *     appears, while that app still has the keyboard.
 *
 * Esc, the hotkey again, or a click outside put it away (./focus-return.ts says
 * when anything more than hiding is needed). Pinned, it stays.
 *
 * ## The main window may be closed
 *
 * On macOS closing the main window leaves Bobble running (as it always has),
 * and the panel and its hotkeys keep working: they live in this process, not
 * in the main window. "Open in Bobble" brings the main window back, making it
 * again if it was closed. Quitting Bobble (⌘Q) unregisters every hotkey.
 *
 * ## Test runs
 *
 * Under PI_E2E nothing here reaches the real Mac: no global key is registered
 * (a probe presses them through `quick:debug`), the panel and the overlays are
 * never shown, every picture is a stand-in drawn from HTML, and the selection,
 * clipboard, Finder and browser reads come from a fake a probe configures
 * (./quick-mac.ts, ./quick-capture.ts). Nothing is read from or written to the
 * real pasteboard, and nothing can trigger a permission prompt.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createIpcEventSender,
  createLogger,
  type IpcHandlers,
  registerIpcHandlers,
} from '@pi-desktop/shared';
import {
  app,
  BrowserWindow,
  type Display,
  globalShortcut,
  type IpcMain,
  type NativeImage,
  nativeTheme,
  screen,
  type WebContents,
  type WebPreferences,
} from 'electron';
import { isBackgroundMode } from '../background-mode';
import type { AppEventMap } from '../ipc-contract';
import { readSettings, subscribeSettings } from '../settings/settings-main';
import { registerTrustedSender } from '../trusted-senders';
import type { QuickContext } from './context';
import { type DismissReason, focusReturnDecision } from './focus-return';
import {
  hotkeyConflicts,
  hotkeyPlan,
  normalizeHotkey,
  QUICK_ACTIONS,
  type QuickAction,
} from './hotkeys';
import { type PanelSize, panelBounds, resizeInPlace } from './placement';
import { createFakeCapture, createRealCapture, type QuickCapture } from './quick-capture';
import type {
  QuickFrontApp,
  QuickHotkeyStatus,
  QuickInvokeMap,
  QuickMainAction,
  QuickProblem,
  QuickResult,
  QuickThread,
} from './quick-contract';
import {
  createFakeMac,
  createRealMac,
  type FakeMacState,
  type Grant,
  imageDataUrl,
  type QuickMac,
} from './quick-mac';
import {
  cropInImage,
  type DisplayGeometry,
  displayForPoint,
  isClickNotDrag,
  localToGlobal,
} from './region-math';
import { type OverlayMode, type OverlayRun, openRegionOverlays } from './region-overlay';

const log = createLogger('desktop:quick');
const events = createIpcEventSender<AppEventMap>();

export interface QuickPanelDeps {
  /** The app's shared web preferences (the preload) — the panel is app content. */
  readonly webPreferences: WebPreferences;
  /** Load the renderer into a window with extra query params. */
  readonly loadRenderer: (win: BrowserWindow, query: Record<string, string>) => void;
  /** Reload-on-crash for a window's renderer (main.ts attachRendererRecovery). */
  readonly attachRecovery: (contents: WebContents, label: string) => void;
  readonly getMainWindow: () => BrowserWindow | null;
  /** The main window, made again when it was closed. */
  readonly ensureMainWindow: () => BrowserWindow;
}

/** How long after launch the hidden panel is made — after the main window's own boot. */
const PRECREATE_DELAY_MS = 2500;
/** The window server needs a beat to repaint without the panel or an overlay. */
const SETTLE_MS = 140;
/** What the panel will wait for the app in front to say before showing anyway. */
const FRONT_READ_MS = 250;
const SELECTION_READ_MS = 220;
const MAX_THREADS = 40;

let deps: QuickPanelDeps | null = null;
let panel: BrowserWindow | null = null;
let panelLoaded: Promise<void> | null = null;
/** Shown, as far as the person is concerned (a test run never really shows it). */
let visible = false;
let pinned = false;
let size: PanelSize = 'compact';
/** The compact panel's last measured content height. */
let fitHeight: number | undefined;
/** A capture is under way: losing the keyboard to an overlay is not a dismissal. */
let busy = 0;
let quitting = false;
/** The app in front when the panel was summoned. */
let previous: QuickFrontApp | null = null;
let hotkeyStatus: QuickHotkeyStatus[] = [];
const registered = new Set<string>();
let overlay: OverlayRun | null = null;
/**
 * An area or window pick is under way — set the moment it starts, before its
 * overlays have even loaded, so a key pressed in that gap still counts.
 */
let picking = false;
/** "Never mind", said before the overlays were up: they close as they arrive. */
let pickCancelled = false;

/** Cancel the pick under way (a quick key pressed over it, or a probe). */
function cancelPick(): void {
  pickCancelled = true;
  overlay?.close();
}
/** Test runs: the last hand-off to the main window, for a probe to read. */
let lastMainAction: QuickMainAction | null = null;

const background = (): boolean => isBackgroundMode();
const ownPids = (): number[] => [process.pid];

/* The Mac and the camera — real, or the stand-ins every test run gets. */
const fakeMac = process.env.PI_E2E === '1' ? createFakeMac() : null;
/** The stand-in's Screen Recording answer; a probe flips it to see the fix card. */
const fakeCaptureState: { grant: Grant; windows: () => FakeMacState['windows'] } = {
  grant: 'granted',
  windows: () => fakeMac?.state.windows ?? [],
};
const fakeCapture = process.env.PI_E2E === '1' ? createFakeCapture(fakeCaptureState) : null;
const mac: QuickMac = fakeMac ?? createRealMac();
const capture: QuickCapture = fakeCapture ?? createRealCapture();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `p`, or `fallback` if it takes longer than `ms` (or fails). */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((r) => {
        timer = setTimeout(() => r(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function geometry(d: Display): DisplayGeometry {
  return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor };
}

function displayUnderPointer(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function send<K extends keyof AppEventMap & string>(channel: K, payload: AppEventMap[K]): void {
  const wc = panel?.webContents;
  if (wc !== undefined && !wc.isDestroyed()) events.send(wc, channel, payload);
}

function encode(img: NativeImage): { image: string; width: number; height: number } {
  const image = imageDataUrl(img);
  // The size the MODEL gets — after the long-edge cap in imageDataUrl.
  const { width, height } = img.getSize();
  const scale = Math.min(1, 1600 / Math.max(width, height, 1));
  return { image, width: Math.round(width * scale), height: Math.round(height * scale) };
}

// ── the window ──────────────────────────────────────────────────────────────

function createPanel(): BrowserWindow {
  if (deps === null) throw new Error('quick panel used before registerQuickPanel');
  const bounds = panelBounds(displayUnderPointer().workArea, size);
  const win = new BrowserWindow({
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    ...bounds,
    title: 'Bobble',
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    alwaysOnTop: true,
    // Painted by the page at once; this only covers the first frame (the
    // theme's raised surface, which is what the panel paints).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e21' : '#ffffff',
    webPreferences: { ...deps.webPreferences, backgroundThrottling: false },
  });
  // On every Space and over full-screen apps. Skipping the process-type
  // transform keeps the Dock tile from blinking.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  registerTrustedSender(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  deps.attachRecovery(win.webContents, 'quick-panel');
  panelLoaded = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve());
  });
  deps.loadRenderer(win, { quickPanel: '1' });
  win.on('blur', () => onBlur());
  // ⌘⇧W and friends put the panel away; it is made once and kept.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    void dismiss('escape');
  });
  win.on('closed', () => {
    if (panel === win) {
      panel = null;
      panelLoaded = null;
      visible = false;
    }
  });
  return win;
}

async function ensurePanel(): Promise<BrowserWindow> {
  if (panel === null || panel.isDestroyed()) {
    panel = createPanel();
    // Wake the Mac helper now, so the first hotkey's reads are not also its
    // start-up (a no-op in a test run, whose Mac is a stand-in).
    void mac.accessibility().catch(() => undefined);
  }
  await panelLoaded;
  return panel;
}

/** Show the panel (never in a test run, which only marks it shown). */
function present(): void {
  visible = true;
  if (panel === null || background()) return;
  // A panel's show() takes the keyboard without activating Bobble.
  panel.show();
  panel.focus();
}

/** Hide the panel without deciding anything about focus (a capture stepping it aside). */
function conceal(): void {
  if (panel !== null && !background() && panel.isVisible()) panel.hide();
}

function placeOnPointerDisplay(): void {
  if (panel === null || pinned) return;
  const area = displayUnderPointer().workArea;
  panel.setBounds(resizeInPlace(panelBounds(area, size), size, area, fitHeight), false);
}

function onBlur(): void {
  if (!visible || busy > 0 || pinned) return;
  if (!readSettings().quickPanel.closeOnBlur) return;
  void dismiss('blur');
}

async function dismiss(reason: DismissReason): Promise<void> {
  if (!visible) return;
  visible = false;
  conceal();
  send('quick:hidden', { reason });
  const frontmostPid =
    reason === 'escape' && !background()
      ? ((await within(mac.frontApp(ownPids()), FRONT_READ_MS, null))?.pid ?? null)
      : null;
  const decision = focusReturnDecision({
    reason,
    previous,
    ownPids: ownPids(),
    frontmostPid,
    background: background(),
  });
  if (decision.kind === 'activate-previous' && previous !== null) {
    await mac.activate(previous);
  } else if (decision.kind === 'focus-main') {
    const win = deps?.getMainWindow() ?? null;
    if (win !== null && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      app.focus({ steal: true });
      win.focus();
    }
  }
}

// ── summoning ───────────────────────────────────────────────────────────────

/**
 * A hotkey (or a probe's press of one). `summon` toggles; the capture keys go
 * straight to their picture and open the panel with it attached.
 */
/** A summon still reading the Mac: a second press in that beat is the same press. */
let summoning = false;

async function summon(action: QuickAction): Promise<void> {
  // A key pressed while an overlay is up means "never mind": the overlay goes.
  // (Checked first: the summon that opened the overlay is still in flight.)
  if (picking) {
    cancelPick();
    return;
  }
  if (summoning) return;
  summoning = true;
  try {
    await summonNow(action);
  } finally {
    summoning = false;
  }
}

async function summonNow(action: QuickAction): Promise<void> {
  const settings = readSettings().quickPanel;
  if (!settings.enabled) return;
  if (action === 'summon' && visible) {
    await dismiss('escape');
    return;
  }
  await ensurePanel();
  const wasVisible = visible;
  let selection: QuickContext | null = null;
  let selectionProblem: QuickProblem | undefined;
  if (!wasVisible) {
    // What is in front, and what is selected in it — read while it still has
    // the keyboard. The icon is fetched alongside, never in the way.
    previous = await within(mac.frontApp(ownPids()), FRONT_READ_MS, null);
    const other = previous !== null && previous.isBobble !== true ? previous : null;
    const [icon, read] = await Promise.all([
      other === null ? null : within(mac.appIcon(other), FRONT_READ_MS, null),
      other === null || !settings.readSelection
        ? null
        : within(mac.selection(other.pid), SELECTION_READ_MS, null),
    ]);
    if (other !== null && icon !== null) previous = { ...other, icon };
    if (other !== null && read?.ok && read.value.text.trim() !== '') {
      selection = {
        kind: 'selection',
        id: randomUUID(),
        app: read.value.app || other.name,
        text: read.value.text,
        editable: read.value.editable,
      };
    } else if (read !== null && !read.ok && read.problem.kind === 'secure') {
      selectionProblem = read.problem;
    }
  }

  let captured: QuickResult | undefined;
  if (action === 'region' || action === 'window' || action === 'screen') {
    captured =
      action === 'region'
        ? await captureWithOverlay('region')
        : action === 'window'
          ? await captureFrontWindow()
          : await captureScreen();
    // Esc on an overlay that a hotkey opened: nothing was asked, nothing opens.
    if (!captured.ok && captured.cancelled === true && !wasVisible) return;
  }

  if (!wasVisible) placeOnPointerDisplay();
  send('quick:summoned', {
    action,
    front: previous,
    selection,
    ...(selectionProblem !== undefined ? { selectionProblem } : {}),
    ...(captured !== undefined ? { capture: captured } : {}),
    at: Date.now(),
  });
  present();
}

// ── pictures ────────────────────────────────────────────────────────────────

function noScreenRecording(): QuickResult {
  return { ok: false, problem: { kind: 'screen-recording' } };
}

/** Bobble's own windows stay out of a whole-screen picture (best effort: the
 *  window server honours it for the capture paths that ask it). */
function protectOwnWindows(on: boolean): void {
  if (background()) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible()) continue;
    try {
      w.setContentProtection(on);
    } catch {
      /* not supported here */
    }
  }
}

async function captureWindowById(windowId: number, appName: string): Promise<QuickResult> {
  if (capture.grant() !== 'granted') return noScreenRecording();
  send('quick:capturing', { kind: 'window', active: true });
  try {
    const got = await capture.windowImage(windowId);
    if (got === null) {
      return {
        ok: false,
        problem: {
          kind: 'nothing',
          app: appName,
          detail: 'That window is not on screen any more.',
        },
      };
    }
    return {
      ok: true,
      context: {
        kind: 'window',
        id: randomUUID(),
        app: appName,
        title: got.title,
        ...encode(got.image),
      },
    };
  } finally {
    send('quick:capturing', { kind: 'window', active: false });
  }
}

async function captureFrontWindow(): Promise<QuickResult> {
  if (capture.grant() !== 'granted') return noScreenRecording();
  const front = previous;
  if (front === null || front.isBobble === true) {
    return {
      ok: false,
      problem: {
        kind: 'nothing',
        detail: 'Bobble was the app in front, so there is no other window to look at.',
      },
    };
  }
  const windows = await mac.screenWindows(ownPids());
  const w = windows.find((x) => x.pid === front.pid && x.layer === 0);
  if (w === undefined) {
    return {
      ok: false,
      problem: { kind: 'nothing', app: front.name, detail: `${front.name} has no window open.` },
    };
  }
  return captureWindowById(w.windowId, front.name);
}

async function captureScreen(): Promise<QuickResult> {
  if (capture.grant() !== 'granted') return noScreenRecording();
  const display =
    panel !== null && visible
      ? screen.getDisplayMatching(panel.getBounds())
      : displayUnderPointer();
  const wasVisible = visible;
  busy += 1;
  send('quick:capturing', { kind: 'screen', active: true });
  try {
    if (wasVisible) conceal();
    protectOwnWindows(true);
    if (!background()) await sleep(SETTLE_MS);
    const img = await capture.displayImage(geometry(display));
    if (img === null) return noScreenRecording();
    const label = display.label !== '' ? display.label : `Display ${display.id}`;
    return {
      ok: true,
      context: { kind: 'screen', id: randomUUID(), display: label, ...encode(img) },
    };
  } finally {
    protectOwnWindows(false);
    send('quick:capturing', { kind: 'screen', active: false });
    if (wasVisible) present();
    busy -= 1;
  }
}

async function captureWithOverlay(mode: OverlayMode): Promise<QuickResult> {
  if (capture.grant() !== 'granted') return noScreenRecording();
  if (picking) return { ok: false, cancelled: true };
  picking = true;
  pickCancelled = false;
  const wasVisible = visible;
  busy += 1;
  send('quick:capturing', { kind: mode, active: true });
  try {
    if (wasVisible) conceal();
    const displays = screen.getAllDisplays().map(geometry);
    const windows = await within(mac.screenWindows(ownPids()), 400, []);
    const focus = displayForPoint(screen.getCursorScreenPoint(), displays);
    overlay = await openRegionOverlays({
      displays,
      windows,
      ownPids: ownPids(),
      mode,
      focusDisplayId: focus?.id ?? displays[0]?.id ?? 0,
      background: background(),
      ...(fakeCapture !== null
        ? {
            backdropFor: async (d: DisplayGeometry) =>
              `data:image/jpeg;base64,${(await fakeCapture.desktop(d)).toJPEG(80).toString('base64')}`,
          }
        : {}),
    });
    if (pickCancelled) overlay.close();
    const answer = await overlay.answer;
    overlay = null;
    if (answer.kind === 'cancel') return { ok: false, cancelled: true };
    if (answer.kind === 'window') {
      const w = windows.find((x) => x.windowId === answer.windowId);
      return captureWindowById(answer.windowId, w?.app ?? 'the window');
    }
    const display = displays.find((d) => d.id === answer.displayId);
    if (display === undefined || isClickNotDrag(answer.rect)) return { ok: false, cancelled: true };
    if (!background()) await sleep(SETTLE_MS);
    protectOwnWindows(true);
    const img = await capture.displayImage(display);
    if (img === null) return noScreenRecording();
    const crop = cropInImage(localToGlobal(answer.rect, display), display, img.getSize());
    if (crop === null) return { ok: false, cancelled: true };
    return { ok: true, context: { kind: 'region', id: randomUUID(), ...encode(img.crop(crop)) } };
  } catch (err) {
    log.warn('area capture failed', { error: String(err) });
    return {
      ok: false,
      problem: { kind: 'failed', detail: 'The selection could not be captured.' },
    };
  } finally {
    overlay?.close();
    overlay = null;
    picking = false;
    protectOwnWindows(false);
    send('quick:capturing', { kind: mode, active: false });
    if (wasVisible) present();
    busy -= 1;
  }
}

// ── reading from the Mac ────────────────────────────────────────────────────

async function readContext(
  kind: 'selection' | 'clipboard' | 'finder' | 'browser',
): Promise<QuickResult> {
  switch (kind) {
    case 'selection': {
      if (previous === null || previous.isBobble === true) {
        return {
          ok: false,
          problem: { kind: 'nothing', detail: 'There is no other app in front to read from.' },
        };
      }
      const read = await mac.selection(previous.pid);
      if (!read.ok) return { ok: false, problem: { ...read.problem, app: previous.name } };
      if (read.value.text.trim() === '') {
        return {
          ok: false,
          problem: {
            kind: 'nothing',
            app: previous.name,
            detail: `Nothing is selected in ${previous.name}.`,
          },
        };
      }
      return {
        ok: true,
        context: {
          kind: 'selection',
          id: randomUUID(),
          app: read.value.app || previous.name,
          text: read.value.text,
          editable: read.value.editable,
        },
      };
    }
    case 'clipboard': {
      const read = mac.clipboardRead();
      if (!read.ok) return { ok: false, problem: read.problem };
      return { ok: true, context: { kind: 'clipboard', id: randomUUID(), ...read.value } };
    }
    case 'finder': {
      const read = await mac.finderSelection();
      if (!read.ok) return { ok: false, problem: read.problem };
      return { ok: true, context: { kind: 'files', id: randomUUID(), paths: read.value } };
    }
    case 'browser': {
      const name = previous?.name ?? '';
      const read = await mac.browserPage(name);
      if (!read.ok) return { ok: false, problem: read.problem };
      const { textProblem, ...page } = read.value;
      return {
        ok: true,
        context: { kind: 'browser', id: randomUUID(), ...page },
        ...(textProblem !== undefined ? { note: textProblem } : {}),
      };
    }
  }
}

async function replaceSelection(
  text: string,
): Promise<QuickInvokeMap['quick:replace-selection']['response']> {
  const prev = previous;
  if (prev === null || prev.isBobble === true) {
    return {
      ok: false,
      problem: { kind: 'nothing', detail: 'There is no other app to put the text into.' },
    };
  }
  const r = await mac.replaceSelection(prev.pid, text);
  if (!r.ok) return { ok: false, problem: { ...r.problem, app: prev.name } };
  if (r.value.replaced) {
    await dismiss('escape');
    return { ok: true, how: 'accessibility' };
  }
  // The app would not take it directly: paste it, then put the clipboard back.
  const restore = mac.clipboardSnapshot();
  mac.clipboardWrite(text);
  await dismiss('paste');
  if (!background()) await sleep(SETTLE_MS);
  const pasted = await mac.pasteKeystroke();
  setTimeout(restore, background() ? 0 : 700);
  return pasted
    ? { ok: true, how: 'paste' }
    : {
        ok: false,
        problem: {
          kind: 'failed',
          app: prev.name,
          detail: 'The text is on the clipboard: press ⌘V to paste it.',
        },
      };
}

// ── the main window's half ─────────────────────────────────────────────────

function deliverToMain(win: BrowserWindow, action: QuickMainAction): void {
  lastMainAction = action;
  const go = () => {
    if (!win.isDestroyed()) events.send(win.webContents, 'quick:main-action', action);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go);
  else go();
}

// ── history ─────────────────────────────────────────────────────────────────

function historyFile(): string {
  return path.join(os.homedir(), '.pi', 'desktop', 'quick-panel.json');
}

function readHistory(): QuickThread[] {
  try {
    const raw = JSON.parse(readFileSync(historyFile(), 'utf8')) as { threads?: unknown };
    if (!Array.isArray(raw.threads)) return [];
    return raw.threads.filter(
      (t): t is QuickThread =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as QuickThread).file === 'string' &&
        typeof (t as QuickThread).title === 'string' &&
        typeof (t as QuickThread).at === 'number',
    );
  } catch {
    return [];
  }
}

function writeHistory(threads: QuickThread[]): void {
  try {
    mkdirSync(path.dirname(historyFile()), { recursive: true });
    writeFileSync(historyFile(), `${JSON.stringify({ threads }, null, 2)}\n`);
  } catch (err) {
    log.warn('quick panel history not saved', { error: String(err) });
  }
}

// ── hotkeys ─────────────────────────────────────────────────────────────────

function unregisterHotkeys(): void {
  for (const accel of registered) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* already gone */
    }
  }
  registered.clear();
}

/**
 * (Re)register every key from Settings. A test run computes the same plan and
 * registers NOTHING: a real global key would swallow the keystrokes of whoever
 * is using this Mac.
 */
function applyHotkeys(): void {
  unregisterHotkeys();
  const s = readSettings().quickPanel;
  const plan = s.enabled ? hotkeyPlan(s.hotkeys) : [];
  const status: QuickHotkeyStatus[] = [];
  for (const action of QUICK_ACTIONS) {
    const accelerator = normalizeHotkey(s.hotkeys[action]);
    if (!s.enabled || accelerator === null) {
      status.push({ action, accelerator, state: 'off' });
      continue;
    }
    if (!plan.some((p) => p.action === action)) {
      const block = hotkeyConflicts(accelerator, { action, assigned: s.hotkeys }).find(
        (c) => c.severity === 'block',
      );
      status.push({
        action,
        accelerator,
        state: 'blocked',
        ...(block ? { reason: block.reason } : {}),
      });
      continue;
    }
    if (background()) {
      status.push({ action, accelerator, state: 'test' });
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => void summon(action));
    } catch (err) {
      log.warn('hotkey registration threw', { accelerator, error: String(err) });
    }
    if (ok) registered.add(accelerator);
    status.push(
      ok
        ? { action, accelerator, state: 'registered' }
        : { action, accelerator, state: 'taken', reason: 'Another app is already using it.' },
    );
  }
  hotkeyStatus = status;
  log.info('quick panel hotkeys', {
    keys: status.map((h) => `${h.action}=${h.accelerator ?? '-'}:${h.state}`).join(' '),
  });
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function e2eOnly(): { ok: false; error: string } | null {
  return process.env.PI_E2E === '1' ? null : { ok: false, error: 'test runs only' };
}

const handlers: IpcHandlers<QuickInvokeMap> = {
  'quick:dismiss': async (req) => {
    await dismiss(req.reason);
    return { ok: true };
  },
  'quick:reveal': () => {
    if (visible || !readSettings().quickPanel.enabled) return { ok: true };
    send('quick:revealed', { at: Date.now() });
    present();
    return { ok: true };
  },
  'quick:resize': (req) => {
    size = req.size;
    if (req.height !== undefined) fitHeight = req.height;
    if (panel !== null && !panel.isDestroyed()) {
      const area = screen.getDisplayMatching(panel.getBounds()).workArea;
      const next = resizeInPlace(panel.getBounds(), size, area, req.height);
      const now = panel.getBounds();
      // Growing to hug the content is not worth an animation; a size change is.
      const animate = !background() && (next.width !== now.width || req.height === undefined);
      panel.setBounds(next, animate);
    }
    return { ok: true, size };
  },
  'quick:set-pinned': (req) => {
    pinned = req.pinned;
    return { ok: true };
  },
  'quick:capture': async (req) => {
    switch (req.kind) {
      case 'front-window':
        return captureFrontWindow();
      case 'window': {
        const windows = await mac.screenWindows(ownPids());
        const w = windows.find((x) => x.windowId === req.windowId);
        return captureWindowById(req.windowId ?? 0, w?.app ?? 'the window');
      }
      case 'screen':
        return captureScreen();
      case 'region':
        return captureWithOverlay('region');
      case 'pick':
        return captureWithOverlay('pick');
    }
  },
  'quick:list-windows': async () => {
    if (capture.grant() !== 'granted') {
      return { ok: false, windows: [], problem: { kind: 'screen-recording' } };
    }
    const [sources, onScreen] = await Promise.all([
      capture.windowSources(),
      within(mac.screenWindows(ownPids()), 400, []),
    ]);
    const owner = new Map(onScreen.map((w) => [w.windowId, w]));
    // Front to back as the window server orders them; any it did not list go last.
    const rank = new Map(onScreen.map((w, i) => [w.windowId, i]));
    const windows = sources
      .filter((s) => {
        const w = owner.get(s.windowId);
        return w === undefined || (w.layer === 0 && !ownPids().includes(w.pid));
      })
      .sort((a, b) => (rank.get(a.windowId) ?? 1e6) - (rank.get(b.windowId) ?? 1e6))
      .map((s) => ({
        windowId: s.windowId,
        app: owner.get(s.windowId)?.app ?? '',
        title: s.title,
        icon: s.icon === null ? null : s.icon.resize({ width: 64, height: 64 }).toDataURL(),
        thumbnail: s.thumbnail === null ? null : s.thumbnail.toDataURL(),
      }));
    return { ok: true, windows };
  },
  'quick:read': (req) => readContext(req.kind),
  'quick:replace-selection': (req) => replaceSelection(req.text),
  'quick:copy': (req) => {
    mac.clipboardWrite(req.text);
    return { ok: true };
  },
  'quick:open-in-main': async (req) => {
    if (deps === null) return { ok: false };
    const win = deps.ensureMainWindow();
    deliverToMain(win, req.action);
    if (visible) await dismiss('open-in-main');
    else if (!background()) {
      if (win.isMinimized()) win.restore();
      win.show();
      app.focus({ steal: true });
    }
    return { ok: true };
  },
  'quick:open-system-settings': async (req) => {
    const ok = await mac.openSystemSettings(req.pane);
    return { ok };
  },
  'quick:status': async () => ({
    enabled: readSettings().quickPanel.enabled,
    permissions: {
      screen: capture.grant(),
      accessibility: await within(mac.accessibility(), 800, 'unknown'),
    },
    hotkeys: hotkeyStatus,
    front: previous,
  }),
  'quick:suspend-hotkeys': (req) => {
    if (req.suspended) unregisterHotkeys();
    else applyHotkeys();
    return { ok: true };
  },
  'quick:history': () => ({ threads: readHistory() }),
  'quick:remember-thread': (req) => {
    const rest = readHistory().filter((t) => t.file !== req.file);
    writeHistory([{ file: req.file, title: req.title, at: req.at }, ...rest].slice(0, MAX_THREADS));
    return { ok: true };
  },
  'quick:forget-thread': (req) => {
    writeHistory(readHistory().filter((t) => t.file !== req.file));
    return { ok: true };
  },
  'quick:debug': async (req) => {
    const refused = e2eOnly();
    if (refused !== null) return refused;
    const params = req.params ?? {};
    switch (req.op) {
      // A hotkey press, without a hotkey. Not awaited: an area capture waits
      // for the probe to drag on the overlay.
      case 'press': {
        const action = String(params.action ?? 'summon') as QuickAction;
        if (!QUICK_ACTIONS.includes(action)) return { ok: false, error: `no action ${action}` };
        void summon(action);
        return { ok: true };
      }
      case 'state':
        return {
          ok: true,
          result: {
            visible,
            pinned,
            size,
            busy,
            overlay: picking,
            overlayShownOnScreen:
              overlay?.windows.some((w) => !w.isDestroyed() && w.isVisible()) ?? false,
            lastMainAction,
            mainWindowAlive: (() => {
              const w = deps?.getMainWindow() ?? null;
              return w !== null && !w.isDestroyed();
            })(),
            bounds: panel?.getBounds() ?? null,
            panelShownOnScreen: panel?.isVisible() ?? false,
            previous,
            hotkeys: hotkeyStatus,
            calls: fakeMac?.calls ?? [],
            registeredGlobally: [...registered],
          },
        };
      case 'set-mac':
        fakeMac?.set(params as Partial<FakeMacState>);
        return { ok: true };
      case 'set-grant': {
        const g = String(params.screen ?? 'granted');
        if (g === 'granted' || g === 'denied' || g === 'unknown') fakeCaptureState.grant = g;
        return { ok: true };
      }
      // A click outside, which a never-shown window cannot receive.
      case 'blur':
        onBlur();
        return { ok: true };
      case 'cancel-overlay':
        cancelPick();
        return { ok: true };
      default:
        return { ok: false, error: `unknown op ${req.op}` };
    }
  },
};

/**
 * Register the panel's channels and hotkeys, and make the hidden panel. Called
 * from main.ts once the main window exists.
 */
export function registerQuickPanel(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  d: QuickPanelDeps,
): void {
  deps = d;
  registerIpcHandlers<QuickInvokeMap>(ipcMain, handlers, { allowSender });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => unregisterHotkeys());
  subscribeSettings('quickPanel', (next, before) => {
    applyHotkeys();
    if (!next.quickPanel.enabled && before.quickPanel.enabled && visible) void dismiss('escape');
  });
  applyHotkeys();
  /*
   * Made ahead of the first hotkey, after the main window has had its start.
   * NOT in a test run: every probe takes `app.firstWindow()` for the main
   * window and some count the windows, so a test run makes the panel only when
   * a probe presses one of its keys.
   */
  if (process.env.PI_E2E !== '1') {
    setTimeout(() => {
      if (!quitting && readSettings().quickPanel.enabled) void ensurePanel();
    }, PRECREATE_DELAY_MS);
  }
}
