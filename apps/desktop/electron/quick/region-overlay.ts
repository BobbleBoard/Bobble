/**
 * THE SELECTION OVERLAY — drag out an area, or click a window.
 *
 * One overlay per display, each covering its display exactly (menu bar and Dock
 * included), the way macOS's own ⇧⌘4 works: a selection belongs to the display
 * it was drawn on, so its pixels are always one capture's pixels (the math is
 * ./region-math.ts).
 *
 * The overlay is LIVE, not a frozen screenshot: it appears the instant the key
 * is pressed, dims the screen, and the capture is taken after it has gone. It
 * is a non-activating panel (Electron's `type: 'panel'`), so the app you were
 * in stays the active app and gets the keyboard back when it closes.
 *
 * Two modes, swapped with Space exactly as in ⇧⌘4: drag an area, or click a
 * window — the hovered window lights up, using the window server's frames (the
 * helper's `screenWindows`), Bobble's own never among them.
 *
 * The page is plain HTML with no preload and no bridge: main hands it its setup
 * and awaits its answer through `executeJavaScript`, and the page reports a mode
 * change through its title, which main relays to the other displays.
 */
import { BrowserWindow } from 'electron';
import {
  type DisplayGeometry,
  MIN_SELECTION_POINTS,
  pickableWindowsOn,
  type Rect,
  type ScreenWindow,
} from './region-math';

export type OverlayMode = 'region' | 'pick';

export type OverlayAnswer =
  | { readonly kind: 'region'; readonly displayId: number; readonly rect: Rect }
  | { readonly kind: 'window'; readonly displayId: number; readonly windowId: number }
  | { readonly kind: 'cancel' };

/** What one overlay is told: its display, the windows on it, and how to look. */
interface OverlaySetup {
  readonly displayId: number;
  readonly mode: OverlayMode;
  /** Windows in overlay-local points, front to back. */
  readonly windows: ReadonlyArray<{ windowId: number; app: string; rect: Rect }>;
  /** Test runs only: a picture behind the dim layer, so a screenshot shows something. */
  readonly backdrop?: string;
}

/* The accent is the app's teal; the rest is neutral ink so it reads over any
   wallpaper. No brand marks, no emoji. */
const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>mode:region</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent;cursor:crosshair;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-user-select:none;user-select:none}
  body.pick{cursor:default}
  #backdrop{position:fixed;inset:0;background-size:100% 100%;background-repeat:no-repeat}
  #dim{position:fixed;inset:0;background:rgba(12,14,16,.38)}
  #sel{position:fixed;display:none;border:1px solid #fff;outline:1px solid rgba(22,163,163,.95);
    box-shadow:0 0 0 9999px rgba(12,14,16,.38);background:transparent}
  body.dragging #dim{display:none}
  #size{position:fixed;display:none;padding:3px 7px;border-radius:6px;background:rgba(20,22,24,.86);color:#fff;
    font:500 11px/1.3 -apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums;pointer-events:none}
  #hover{position:fixed;inset:0;display:none;pointer-events:none}
  #hover svg{position:absolute;inset:0;width:100%;height:100%}
  #hoverLabel{position:fixed;padding:4px 9px;border-radius:7px;background:rgba(20,22,24,.86);
    color:#fff;font:500 12px/1.3 -apple-system,system-ui,sans-serif}
  #hint{position:fixed;left:50%;top:40px;transform:translateX(-50%);display:flex;gap:14px;align-items:center;
    padding:9px 16px;border-radius:999px;background:rgba(20,22,24,.86);color:#fff;
    font:500 13px/1.3 -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;white-space:nowrap}
  #hint .dot{width:8px;height:8px;border-radius:50%;background:#16a3a3;box-shadow:0 0 0 3px rgba(22,163,163,.3)}
  #hint kbd{font:600 11px/1 -apple-system,system-ui,sans-serif;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,.16)}
  #hint .sub{color:rgba(255,255,255,.72)}
</style></head>
<body>
<div id="backdrop"></div><div id="dim"></div><div id="hover"><svg id="hoverSvg" xmlns="http://www.w3.org/2000/svg"></svg><span id="hoverLabel"></span></div><div id="sel"></div><div id="size"></div>
<div id="hint"><span class="dot"></span><span id="hintText">Drag over what you want to ask about</span>
  <span class="sub"><kbd>space</kbd> <span id="hintSwap">pick a window</span></span><span class="sub"><kbd>esc</kbd> cancel</span></div>
<script>
(() => {
  let cfg = { displayId: 0, mode: 'region', windows: [] };
  let mode = 'region';
  let start = null, done = false, pressed = null;
  let settle;
  const result = new Promise((r) => { settle = r; });
  const $ = (id) => document.getElementById(id);
  const finish = (answer) => { if (done) return; done = true; settle(answer); };
  function setMode(m, announce) {
    mode = m;
    document.body.classList.toggle('pick', m === 'pick');
    $('hintText').textContent = m === 'pick' ? 'Click the window you want to ask about' : 'Drag over what you want to ask about';
    $('hintSwap').textContent = m === 'pick' ? 'drag an area' : 'pick a window';
    $('sel').style.display = 'none'; $('size').style.display = 'none';
    $('dim').style.display = '';
    $('hover').style.display = 'none';
    if (announce) document.title = 'mode:' + m;
  }
  function windowAt(x, y) {
    for (const w of cfg.windows) {
      const r = w.rect;
      if (x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height) return w;
    }
    return null;
  }
  function drawRect(r) {
    const s = $('sel');
    s.style.display = 'block';
    s.style.left = r.x + 'px'; s.style.top = r.y + 'px';
    s.style.width = r.width + 'px'; s.style.height = r.height + 'px';
    const label = $('size');
    label.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    label.style.display = 'block';
    const below = r.y + r.height + 8;
    label.style.left = r.x + 'px';
    label.style.top = (below + 24 < innerHeight ? below : Math.max(4, r.y - 26)) + 'px';
  }
  const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || done) return;
    // A window is picked on release, as a click is; the press only arms it.
    if (mode === 'pick') { pressed = windowAt(e.clientX, e.clientY); return; }
    start = { x: e.clientX, y: e.clientY };
    document.body.classList.add('dragging');
    drawRect({ x: start.x, y: start.y, width: 0, height: 0 });
  });
  addEventListener('mousemove', (e) => {
    if (done) return;
    if (mode === 'pick') {
      const w = windowAt(e.clientX, e.clientY);
      const h = $('hover');
      if (!w) { h.style.display = 'none'; return; }
      h.style.display = 'block';
      // Only the part of the window you can see lights up: the windows in
      // front of it are cut out of the highlight, as macOS's own picker does.
      const front = cfg.windows.slice(0, cfg.windows.indexOf(w));
      const r = w.rect;
      const holes = front.map((f) => '<rect x="' + f.rect.x + '" y="' + f.rect.y + '" width="' + f.rect.width + '" height="' + f.rect.height + '" rx="10" fill="black"/>').join('');
      $('hoverSvg').innerHTML =
        '<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="' + innerWidth + '" height="' + innerHeight + '">' +
        '<rect x="0" y="0" width="' + innerWidth + '" height="' + innerHeight + '" fill="black"/>' +
        '<rect x="' + (r.x - 2) + '" y="' + (r.y - 2) + '" width="' + (r.width + 4) + '" height="' + (r.height + 4) + '" rx="12" fill="white"/>' + holes +
        '</mask></defs>' +
        '<rect mask="url(#m)" x="' + (r.x + 1) + '" y="' + (r.y + 1) + '" width="' + (r.width - 2) + '" height="' + (r.height - 2) + '" rx="10" fill="rgba(22,163,163,.18)" stroke="rgb(22,163,163)" stroke-width="2"/>';
      // The label sits in the window's first visible corner.
      const label = $('hoverLabel');
      label.textContent = w.app;
      let lx = r.x + 10, ly = r.y + 10;
      for (const f of front) {
        const fr = f.rect;
        if (lx >= fr.x && lx < fr.x + fr.width && ly >= fr.y && ly < fr.y + fr.height) { ly = Math.min(r.y + r.height - 34, fr.y + fr.height + 10); }
      }
      label.style.left = lx + 'px'; label.style.top = ly + 'px';
      return;
    }
    if (start) drawRect(norm(start, { x: e.clientX, y: e.clientY }));
  });
  addEventListener('mouseup', (e) => {
    if (done) return;
    if (mode === 'pick') {
      const w = windowAt(e.clientX, e.clientY);
      if (w && pressed && w.windowId === pressed.windowId) finish({ kind: 'window', displayId: cfg.displayId, windowId: w.windowId });
      pressed = null;
      return;
    }
    if (mode !== 'region' || !start) return;
    const r = norm(start, { x: e.clientX, y: e.clientY });
    start = null;
    document.body.classList.remove('dragging');
    if (r.width < ${MIN_SELECTION_POINTS} || r.height < ${MIN_SELECTION_POINTS}) { $('sel').style.display = 'none'; $('size').style.display = 'none'; return; }
    finish({ kind: 'region', displayId: cfg.displayId, rect: r });
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish({ kind: 'cancel' }); }
    else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); start = null; document.body.classList.remove('dragging'); setMode(mode === 'pick' ? 'region' : 'pick', true); }
  });
  addEventListener('contextmenu', (e) => { e.preventDefault(); finish({ kind: 'cancel' }); });
  window.__pdRegion = {
    setup(next) {
      cfg = next;
      if (next.backdrop) $('backdrop').style.backgroundImage = 'url(' + next.backdrop + ')';
      setMode(next.mode, false);
      document.title = 'mode:' + next.mode;
      return true;
    },
    setMode(m) { if (!done) setMode(m, false); return true; },
    cancel() { finish({ kind: 'cancel' }); return true; },
    result,
  };
})();
</script></body></html>`;

/** One display's overlay window. */
interface Overlay {
  readonly display: DisplayGeometry;
  readonly win: BrowserWindow;
}

export interface OverlayRun {
  /** The person's answer; `cancel` for Esc, a right-click, or another overlay finishing. */
  readonly answer: Promise<OverlayAnswer>;
  /** Every overlay window, for a probe to drive (test runs only). */
  readonly windows: readonly BrowserWindow[];
  /** Tear the overlays down now. */
  close(): void;
}

/**
 * Put an overlay on every display and wait for one of them to answer.
 *
 * `focusDisplayId` is the display under the pointer: its overlay takes the
 * keyboard (for Esc and Space) — as a panel, without activating Bobble.
 */
export async function openRegionOverlays(input: {
  readonly displays: readonly DisplayGeometry[];
  readonly windows: readonly ScreenWindow[];
  readonly ownPids: readonly number[];
  readonly mode: OverlayMode;
  readonly focusDisplayId: number;
  /** Test runs: never shown, and a backdrop picture per display. */
  readonly background: boolean;
  readonly backdropFor?: (display: DisplayGeometry) => Promise<string | undefined>;
}): Promise<OverlayRun> {
  const overlays: Overlay[] = [];
  let closed = false;
  /*
   * Closing IS an answer — "cancel". A page torn down mid-`executeJavaScript`
   * leaves that promise pending for good, so the race below would never settle
   * on its own and the pick would stay "under way" forever.
   */
  let closedAnswer: (a: OverlayAnswer) => void = () => undefined;
  const whenClosed = new Promise<OverlayAnswer>((resolve) => {
    closedAnswer = resolve;
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    closedAnswer({ kind: 'cancel' });
    for (const o of overlays) if (!o.win.isDestroyed()) o.win.destroy();
  };

  for (const display of input.displays) {
    const win = new BrowserWindow({
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      x: Math.round(display.bounds.x),
      y: Math.round(display.bounds.y),
      width: Math.round(display.bounds.width),
      height: Math.round(display.bounds.height),
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Above the menu bar and the Dock, over full-screen apps, on every Space.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    overlays.push({ display, win });
  }

  const pageReady = overlays.map(async ({ display, win }) => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
    const local = pickableWindowsOn(display, input.windows, input.ownPids);
    const backdrop = input.backdropFor === undefined ? undefined : await input.backdropFor(display);
    const setup: OverlaySetup = {
      displayId: display.id,
      mode: input.mode,
      windows: local,
      ...(backdrop !== undefined ? { backdrop } : {}),
    };
    await win.webContents.executeJavaScript(
      `window.__pdRegion.setup(${JSON.stringify(setup)})`,
      true,
    );
  });
  await Promise.all(pageReady);

  // A mode switch on one display switches them all (the page says so in its title).
  for (const { win } of overlays) {
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      const m = /^mode:(region|pick)$/.exec(title)?.[1];
      if (m === undefined) return;
      for (const other of overlays) {
        if (other.win === win || other.win.isDestroyed()) continue;
        void other.win.webContents
          .executeJavaScript(`window.__pdRegion.setMode(${JSON.stringify(m)})`, true)
          .catch(() => undefined);
      }
    });
  }

  if (!input.background) {
    for (const { win } of overlays) win.showInactive();
    const focus = overlays.find((o) => o.display.id === input.focusDisplayId) ?? overlays[0];
    // A panel takes the keyboard without making Bobble the active app.
    focus?.win.focus();
  }

  const answers = overlays.map(({ win }) =>
    win.webContents
      .executeJavaScript('window.__pdRegion.result', true)
      .then((a) => a as OverlayAnswer)
      .catch((): OverlayAnswer => ({ kind: 'cancel' })),
  );
  const answer = Promise.race([...answers, whenClosed]).then((a) => {
    close();
    return a;
  });
  return { answer, windows: overlays.map((o) => o.win), close };
}
