/**
 * Phase 2b native-surface wiring: the renderer half of the browser/terminal
 * live surfaces. `useNativeSurfaces(controller)` returns the `CanvasTabsHandlers`
 * bag the tabbed canvas hands to BrowserSurface / TerminalSurface, and drives
 * the main-process managers (electron/canvas/browser-manager.ts,
 * electron/terminal/pty-manager.ts) over the `browser:*` / `pty:*` channels.
 *
 * Contract followed (packages/canvas surfaces/content-slot.ts):
 *   - onSurfaceMount(id, kind, el)      el = the content slot; null = HIDE.
 *   - onSurfaceRectChange(id, kind, r)  viewport rect (client coords) or null.
 * Browser tabs are a native WebContentsView OVERLAY main positions from the
 * reported rect (client rect ↔ window content coords are 1:1 for the main
 * window). Terminal tabs mount an xterm.js instance INTO the slot, backed by a
 * PTY in main. Mount/unmount HIDES (never destroys) on tab-switch; a view/PTY
 * is destroyed only when its tab id leaves controller.getState().tabs.
 *
 * "Model drives the browser" seam: main exports browserManager
 * (navigate/capture/snapshotDom/click); a future browser-use tool set flips the
 * chrome indicator with controller.updateTab({ driving: true }).
 */
import '@xterm/xterm/css/xterm.css';
import {
  artifactExportText,
  type CanvasController,
  type CanvasTab,
  type CanvasTabsHandlers,
} from '@pi-desktop/canvas';
import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef } from 'react';
import type { BrowserBounds } from '../../../electron/canvas/browser-contract';
import { officeKindForExt } from '../../../electron/office/office-contract';
import { usePiStore } from '../../state/pi-slice';
import { useSettingsStore } from '../../state/settings-store';
import { useThemeStore } from '../../store/theme';
import { browserBoundsForPanel, rectToBounds } from './browser-bounds';
import { isDarkColor } from './color-luma';
import { setOfficeEditorsAvailable } from './file-preview';
import { fileArtifactFromText, openFileInCanvas } from './file-tabs';
import { freezeFrame } from './freeze-frame';
import { type OpenOutcome, reportOpen } from './open-outcome';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Read a --pd-* theme token off the document root, falling back when unset. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * A token value xterm can parse. Its colour parser takes hex (3–8 digits) and
 * comma `rgb()`/`rgba()`, and THROWS on anything else — including the
 * keyword `transparent` and a `color-mix()` — which is why the theme sheet
 * keeps the terminal's tokens as plain hex, and why anything else here falls
 * back rather than taking the whole theme down with it.
 */
function xtermColor(name: string, fallback: string): string {
  const value = cssVar(name, fallback);
  if (value === 'transparent') return 'rgba(0, 0, 0, 0)';
  if (/^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\(/.test(value)) return value;
  return fallback;
}

/**
 * xterm theme from the CODE THEME's variables — the `--pd-ansi-*` sixteen,
 * the terminal foreground, caret and selection — which the theme sheet
 * carries for the house themes and Appearance → Code appearance overrides for
 * a chosen one. Read as COMPUTED values, so a theme change lands here by
 * re-reading rather than by mirroring a palette in TypeScript.
 *
 * the user: "in terminal in the canvas in dark mode there's a dark red color
 * that's a bit unreadable" — xterm's own default red (#cd3131) on the app's
 * near-black ground, at 3:1. The house palette's red clears 5:1; every ANSI
 * colour of the house themes is held to 4.5:1 by test.
 */
function terminalTheme(): ITheme {
  /* Transparent, so the terminal has no rectangle of its own to draw edges on —
   * `.pd-terminal` is transparent too and the rounded canvas panel shows through.
   * MEASURED: this token is `rgba(255,255,255,0.04)`, a wash rather than a solid,
   * so painting it here AND on the container double-applied it over the grid. The
   * two must stay in step or the seam the user called "that akward border" returns.
   * A third-party theme's ground is painted by `.pd-terminal` (the surface the
   * panel clips), never here. */
  const bg = 'rgba(0, 0, 0, 0)';
  const fg = xtermColor('--pd-terminal-fg', cssVar('--pd-text-primary', '#e6e6ea'));
  const accent = cssVar('--pd-accent-primary', '#8aa2ff');
  // The caret has its own token: two flavors say the right thing with their
  // accent (bobble blue, claude orange) but codex's accent is a near-black that
  // would be invisible against the terminal background.
  const caret = xtermColor('--pd-terminal-cursor', accent);
  const selection = xtermColor('--pd-terminal-selection', 'rgba(138,162,255,0.28)');
  // The character under a block caret is drawn in the ground's colour: the
  // theme's own when it has one, the app's code surface when it is transparent.
  const ground = xtermColor('--pd-terminal-bg', bg);
  const cursorAccent = ground === bg ? xtermColor('--pd-code-block-bg', '#1e1e24') : ground;
  const ansi = (name: string, fallback: string): string =>
    xtermColor(`--pd-ansi-${name}`, fallback);
  return {
    background: bg,
    foreground: fg,
    cursor: caret,
    cursorAccent,
    selectionBackground: selection,
    black: ansi('black', '#5c5c64'),
    red: ansi('red', '#ff7a72'),
    green: ansi('green', '#5fd68a'),
    yellow: ansi('yellow', '#f5c542'),
    blue: ansi('blue', '#6ab0ff'),
    magenta: ansi('magenta', '#ff8ac8'),
    cyan: ansi('cyan', '#5fd6d6'),
    white: ansi('white', '#e8e8ec'),
    brightBlack: ansi('bright-black', '#8e8e96'),
    brightRed: ansi('bright-red', '#ff9d96'),
    brightGreen: ansi('bright-green', '#8ff0b0'),
    brightYellow: ansi('bright-yellow', '#ffd866'),
    brightBlue: ansi('bright-blue', '#8fc4ff'),
    brightMagenta: ansi('bright-magenta', '#ffa8d6'),
    brightCyan: ansi('bright-cyan', '#8ff0f0'),
    brightWhite: ansi('bright-white', '#ffffff'),
  };
}

/** Same `?piE2E=1` opt-in as the other E2E hooks (pi-connect.ts). */
const IS_E2E = new URLSearchParams(window.location.search).has('piE2E');

/**
 * MAKE THE MIRROR'S CURSOR EXIST.
 *
 * xterm draws no cursor until the terminal has been focused or typed into
 * (`isCursorInitialized`, set on focus, on a key, or when the alternate screen
 * is entered) — and a mirror is never focused and never typed into, so the
 * Activity terminal showed no cursor at all, which made "move the cursor down
 * a line when the command is complete" (the user, 2026-09-17) invisible. Entering
 * and leaving the alternate screen (DECSET/DECRST 1049 — content and cursor
 * restored) is the one way in through the write stream; every full rewrite
 * (ESC c, which un-initialises it again) writes it right after the reset —
 * and a mirror's first paint IS a full rewrite (#mountTerminal).
 */
const MIRROR_CURSOR_ON = '\x1b[?1049h\x1b[?1049l';

/**
 * Invoke a canvas shell-out channel (open-with / reveal / open-external) and
 * SAY so when main could not do it (open-outcome.ts).
 *
 * Under the E2E opt-in the call is also recorded to `window.__pi_canvas_ipc`
 * (`window.piDesktop` is a frozen contextBridge object, so a probe cannot wrap
 * `invoke` itself). It used to be recorded INSTEAD of made — which is why no
 * probe ever saw an Open fail: the half that failed never ran. The call is
 * always made now; main is what keeps a probe from launching Preview, Finder or
 * a browser (electron/canvas/os-open.ts openPolicy).
 */
function canvasShellInvoke(
  channel: 'canvas:open-with',
  req: { path: string; appId: string },
  appName?: string,
): void;
function canvasShellInvoke(channel: 'canvas:reveal', req: { path: string }): void;
function canvasShellInvoke(channel: 'canvas:open-external', req: { url: string }): void;
function canvasShellInvoke(channel: string, req: unknown, appName?: string): void {
  if (IS_E2E) {
    if (window.__pi_canvas_ipc === undefined) window.__pi_canvas_ipc = [];
    window.__pi_canvas_ipc.push({ channel, req });
  }
  // Narrowed by the overloads above; the bridge's own types cannot see that.
  const invoke = window.piDesktop.invoke as unknown as (
    channel: string,
    req: unknown,
  ) => Promise<OpenOutcome>;
  const runWith = (r: unknown) => invoke(channel, r);
  const run = () => runWith(req);
  if (channel === 'canvas:open-external') {
    void run().catch(() => undefined);
    return;
  }
  const { path } = req as { path: string };
  void reportOpen(run, {
    verb: channel === 'canvas:reveal' ? 'reveal' : 'open',
    path,
    ...(appName !== undefined ? { appName } : {}),
    retryAt: (p) => runWith({ ...(req as object), path: p }),
  });
}

/**
 * Dispose an xterm AFTER its own pending frames have run.
 *
 * REPRODUCED (tests/e2e/activity-burst-probe.mjs): write a burst into a mirror
 * terminal and reset the canvas in the same tick — the way a new chat or a chat
 * switch does — and xterm's queued animation-frame callback fires against a
 * disposed renderer:
 *   TypeError: Cannot read properties of undefined (reading 'dimensions')
 *     at Viewport.syncScrollArea
 * Four of those preceded both renderer crashes in the canvas assessment. The
 * terminal comes off the page now (nothing can see it), and the dispose waits
 * two frames so every callback xterm already queued runs against a live
 * instance. Disposal itself is guarded: a terminal that cannot be torn down
 * cleanly must not take the caller's commit with it.
 */
function disposeTerminalSafely(entry: TerminalEntry): void {
  entry.container.parentNode?.removeChild(entry.container);
  const { term } = entry;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      term.dispose();
    } catch {
      // xterm's own teardown threw; the instance is unreachable either way.
    }
  };
  if (typeof requestAnimationFrame !== 'function') {
    dispose();
    return;
  }
  /*
   * AFTER THE WRITES HAVE BEEN PARSED, then two frames. Two frames alone was
   * not enough: xterm parses a large write in slices, yielding between them,
   * so a burst of mirror text was still being parsed when the frames were up,
   * and its viewport refresh then ran against a disposed renderer ("reading
   * 'dimensions'" — activity-burst-probe, REPRODUCED again 2026-09-17 on a
   * build that had the two-frame wait). An empty write's callback runs once
   * everything queued before it has been parsed; the frames after that are for
   * the renderer's own callbacks. A deadline in case the callback never comes.
   */
  const afterFrames = (): void => {
    requestAnimationFrame(() => requestAnimationFrame(dispose));
  };
  const deadline = setTimeout(afterFrames, 2000);
  try {
    term.write('', () => {
      clearTimeout(deadline);
      afterFrames();
    });
  } catch {
    clearTimeout(deadline);
    afterFrames();
  }
}

interface BrowserEntry {
  lastBounds: BrowserBounds;
  /** The mounted slot element, kept so bounds can be RE-MEASURED rather than
   * replayed. `lastBounds` is only ever as fresh as the last callback, which is
   * the whole problem when a resize produces no callback. */
  el?: HTMLElement;
}

interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  spawned: boolean;
  onDataDispose: (() => void) | null;
  /** Mirror tabs render tool-call output (no PTY, read-only); interactive tabs
   * spawn a shell. Decided at first mount from the tab's `data.mirror`. */
  mirror: boolean;
  /** Last mirror text written (skip re-render when unchanged). */
  lastMirrorText: string;
  /** Last fitted grid size — a scroll/focus/blur re-fires the slot's rect
   * callback without a real resize, so we skip the pty:resize when unchanged. */
  lastCols: number;
  lastRows: number;
}

/** Owns the per-tab native views/PTYs for one window. One instance per panel. */
export class NativeSurfaces {
  readonly handlers: CanvasTabsHandlers;
  readonly #controller: CanvasController;
  readonly #browsers = new Map<string, BrowserEntry>();
  /**
   * Office editor views, keyed like browsers. Same overlay lifecycle: created on
   * mount, positioned from the reported rect, HIDDEN on tab switch, destroyed
   * only when the tab leaves the controller.
   */
  readonly #offices = new Map<string, BrowserEntry>();
  readonly #terminals = new Map<string, TerminalEntry>();
  /** Session cwd (project dir), kept fresh by the hook, for the file-tree
   * breadcrumb when the user opens a file from the tree panel. */
  #cwd: string | undefined;
  /**
   * Whether the canvas panel is OPEN. Native browser views paint ABOVE the DOM
   * and are NOT clipped by the collapsing aside, so a rect callback that fired
   * `visible:true` while the panel is closed would strand the view over the chat
   * (round-14 close bug). Every rect emit honours this, and `setPanelOpen`
   * hides/re-shows on the open→closed / closed→open edge.
   */
  #panelOpen = true;
  /** Detach for the window-resize re-assert; see {@link #onWindowResize}. */
  #offResize: (() => void) | undefined;

  constructor(controller: CanvasController) {
    this.#controller = controller;
    // MEASURED, from the user's screenshot of the running app: widening the window
    // from 1440 to 1900 left the office view's viewport at 440x825 — it never
    // moved, so the canvas panel grew and the editor did not, leaving a band of
    // dead space down the right-hand side.
    //
    // The slot's ResizeObserver is not a reliable signal here for the same
    // reason it missed the very first office view: the panel is laid out from
    // the window, and the observed element's own box can settle a frame later
    // than the window event, so the callback either never fires or fires with a
    // stale rect. Re-measuring from the live element on window resize is the
    // signal that always exists, and it is self-correcting.
    if (typeof window !== 'undefined') {
      const onResize = (): void => this.#onWindowResize();
      window.addEventListener('resize', onResize);
      this.#offResize = () => window.removeEventListener('resize', onResize);
    }
    this.handlers = {
      onSurfaceMount: (tabId, kind, el) => this.#onMount(tabId, kind, el),
      onSurfaceRectChange: (tabId, kind, rect) => this.#onRect(tabId, kind, rect),
      onBrowserNavigate: (tabId, url) => {
        this.#controller.updateTab(tabId, { url, loading: true });
        void window.piDesktop.invoke('browser:navigate', { tabId, url });
      },
      onBrowserBack: (tabId) => void window.piDesktop.invoke('browser:back', { tabId }),
      onBrowserForward: (tabId) => void window.piDesktop.invoke('browser:forward', { tabId }),
      onBrowserReload: (tabId) => void window.piDesktop.invoke('browser:reload', { tabId }),
      // Browser operation bar: "open in external browser" (trusted-gated in main).
      onBrowserOpenExternal: (tabId) => {
        const url = this.#tab(tabId)?.url;
        if (url) canvasShellInvoke('canvas:open-external', { url });
      },
      // File operation bar split button: "Open" opens with the OS DEFAULT app
      // (round-8 #14 — the same handler the default-app icon labels), while the
      // ▾ dropdown's "Open with" picks a specific app id (bundle id / .app path).
      onOpen: (tabId) => {
        const filePath = this.#tab(tabId)?.filePath;
        if (filePath) canvasShellInvoke('canvas:open-with', { path: filePath, appId: 'default' });
      },
      onOpenWith: (tabId, appId) => {
        const tab = this.#tab(tabId);
        const filePath = tab?.filePath;
        const app = [tab?.defaultApp, ...(tab?.openApps ?? [])].find((a) => a?.id === appId);
        if (filePath) canvasShellInvoke('canvas:open-with', { path: filePath, appId }, app?.name);
      },
      onReveal: (tabId) => {
        const filePath = this.#tab(tabId)?.filePath;
        if (filePath) canvasShellInvoke('canvas:reveal', { path: filePath });
      },
      onFileTreeSelect: (_tabId, node) => {
        if (node.kind === 'file') void openFileInCanvas(this.#controller, node.path, this.#cwd);
      },
      // Persist the raw↔rendered choice on the tab so it survives tab switches
      // (round-8 #6/#13); the canvas seeds its toggle from `tab.rawRendered`.
      onFileViewModeChange: (tabId, mode) => {
        this.#controller.updateTab(tabId, { rawRendered: mode });
      },
      // Live editing: persist the raw editor's buffer to disk (round-9). The
      // main-process handler fences the path to allowed project/session roots.
      onFileSave: (tabId, text) => this.#saveFile(tabId, text),
      // Media operation bar: download the current media src / expand to fullscreen.
      onMediaDownload: (tabId, format) => this.#downloadMedia(tabId, format),
      onMediaExpand: (tabId) => {
        const state = this.#controller.getState();
        this.#controller.focusTab(tabId);
        this.#controller.setFullscreen(!state.fullscreen);
      },
    };
  }

  /** Keep the session cwd current (drives the file-tree breadcrumb). */
  setCwd(cwd: string | undefined): void {
    this.#cwd = cwd;
  }

  #tab(tabId: string): CanvasTab | undefined {
    return this.#controller.getState().tabs.find((t) => t.id === tabId);
  }

  /** Download the active media tab's src (data: or http). Anchor-download works
   * for data URIs directly; http(s) srcs are handed to the OS default handler. */
  #downloadMedia(tabId: string, format: string): void {
    const tab = this.#tab(tabId);
    const name = (tab?.title ?? 'download').replace(/[^\w.-]+/g, '_');
    const filename = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${format.toLowerCase()}`;
    // A chart tab's text is its spec; what downloads is the drawing.
    if (tab?.artifact?.content.kind === 'chart') {
      const svg = artifactExportText(tab.artifact.content);
      const a = document.createElement('a');
      a.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      a.download = filename;
      a.click();
      return;
    }
    const src = tab?.mediaSrc ?? tab?.artifact?.content.text;
    if (!src) return;
    if (src.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = src;
      a.download = filename;
      a.click();
    } else {
      canvasShellInvoke('canvas:open-external', { url: src });
    }
  }

  /**
   * Persist the raw editor's buffer to the tab's file (round-9 live editing).
   * The main-process `fs:write-file` handler fences the path to allowed
   * project/session roots. On success we reflect the saved text on the tab so it
   * survives tab switches AND the finalize-from-disk reload (both read the same
   * bytes now on disk). Under E2E the real IPC is skipped — the call is recorded
   * to `window.__pi_canvas_ipc` and the tab is updated so probes can assert both.
   */
  #saveFile(tabId: string, text: string): void {
    const tab = this.#tab(tabId);
    const filePath = tab?.filePath;
    if (filePath === undefined) return;
    const reflect = (): void => {
      const current = this.#tab(tabId);
      if (current !== undefined)
        this.#controller.updateTab(tabId, { artifact: fileArtifactFromText(filePath, text) });
    };
    if (IS_E2E) {
      if (window.__pi_canvas_ipc === undefined) window.__pi_canvas_ipc = [];
      window.__pi_canvas_ipc.push({ channel: 'fs:write-file', req: { path: filePath, text } });
      reflect();
      return;
    }
    void window.piDesktop
      .invoke('fs:write-file', { path: filePath, content: text })
      .then((res) => {
        if (res.ok) reflect();
      })
      .catch(() => {
        // best-effort — a failed write leaves the on-screen buffer untouched.
      });
  }

  // ── mount / rect ─────────────────────────────────────────────────────────
  #onMount(tabId: string, kind: CanvasTab['kind'], el: HTMLElement | null): void {
    if (kind === 'browser') {
      if (el !== null) {
        void window.piDesktop.invoke('browser:create', { tabId }).then((res) => {
          // A browser tab restored from a per-chat snapshot re-creates a BLANK
          // WebContentsView; nothing else reacts to `tab.url`. On FIRST creation
          // only (idempotent create ⇒ never on a same-session re-mount, so in-tab
          // navigation is preserved), navigate the fresh view back to its URL.
          if (res.created !== true) return;
          const url = this.#tab(tabId)?.url;
          if (url !== undefined && url.length > 0) {
            void window.piDesktop.invoke('browser:navigate', { tabId, url });
          }
        });
        /*
         * THE SAME STRANDING THE OFFICE VIEW HAD (below), never fixed here.
         * MEASURED 2026-09-21 (cursor-parity-look): the model's first browse
         * opens the canvas, the rail slides in from the right, and the
         * WebContentsView is left at x=1441 in a 1440-wide window — bounds
         * 439×779, "visible", and a 0×0 viewport, because the slot's SIZE never
         * changed and the ResizeObserver never fired. Every click landed on
         * nothing and the page was never seen: the user's "doesn't show the user
         * anything for the actual browser actions". Keep the element and
         * re-measure across the slide, as the office view does.
         */
        this.#browsers.set(tabId, {
          ...(this.#browsers.get(tabId) ?? {
            lastBounds: rectToBounds(el.getBoundingClientRect()),
          }),
          el,
        });
        this.#renudge('browser', tabId, el);
      } else this.#hideBrowser(tabId);
      return;
    }
    if (kind === 'office') {
      if (el !== null) {
        const tab = this.#tab(tabId);
        const filePath = tab?.filePath;
        if (filePath === undefined || filePath.length === 0) return;
        const officeKind = officeKindForExt(filePath.split('.').pop() ?? '');
        if (officeKind === null) return;
        void window.piDesktop
          .invoke('office:create', { tabId, kind: officeKind, filePath })
          .then((res) => {
            if (!res.ok) {
              // Surfacing beats silence: an editor that fails to open otherwise
              // shows an empty rectangle indistinguishable from a slow load. Say
              // so in words, with the way on: the file's own app.
              const name = tab?.title ?? 'This document';
              usePiStore.setState((st) => ({
                notifications: [
                  ...st.notifications.slice(-3),
                  {
                    id: `office-${tabId}-${Date.now()}`,
                    level: 'error' as const,
                    message: `Couldn't open the editor for ${name} here.`,
                    timestamp: Date.now(),
                    action: {
                      label: 'Open in its app',
                      run: () =>
                        void reportOpen(
                          () => window.piDesktop.invoke('canvas:open-default', { path: filePath }),
                          { verb: 'open', path: filePath },
                        ),
                    },
                  },
                ],
              }));
            }
          })
          .catch(() => undefined);
        // Re-measure across the panel's open animation.
        //
        // MEASURED: the FIRST office view of a session was landing at x=1440 in
        // a 1440-wide window — entirely off-screen, so it never got a display
        // surface and capturePage() returned an empty image forever. The slot's
        // SIZE was already correct (440x825); only its position was stale.
        //
        // That is the ResizeObserver in useContentSlot doing exactly what it
        // says: it fires on size changes, and the canvas panel sliding in from
        // the right changes position only. Nothing ever corrected the rect.
        // Opening the first office tab is what opens the panel, which is why
        // only the first one was affected — and why the bug followed tab
        // ORDER, not file format.
        this.#offices.set(tabId, {
          ...(this.#offices.get(tabId) ?? { lastBounds: rectToBounds(el.getBoundingClientRect()) }),
          el,
        });
        this.#renudge('office', tabId, el);
      } else this.#hideOffice(tabId);
      return;
    }
    if (kind === 'terminal') {
      if (el !== null) this.#mountTerminal(tabId, el);
      else this.#detachTerminal(tabId);
    }
  }

  #onRect(tabId: string, kind: CanvasTab['kind'], rect: DOMRect | null): void {
    if (kind === 'browser') {
      if (rect === null) {
        this.#hideBrowser(tabId);
        return;
      }
      const bounds = rectToBounds(rect);
      this.#browsers.set(tabId, { ...(this.#browsers.get(tabId) ?? {}), lastBounds: bounds });
      // Only show the view while the panel is open — a stray scroll/resize emit
      // must not re-strand it over the chat after the canvas has been closed.
      void window.piDesktop.invoke('browser:set-bounds', {
        tabId,
        bounds,
        visible: this.#panelOpen,
      });
      return;
    }
    if (kind === 'office') {
      if (rect === null) {
        this.#hideOffice(tabId);
        return;
      }
      const bounds = rectToBounds(rect);
      this.#offices.set(tabId, { lastBounds: bounds });
      void window.piDesktop.invoke('office:set-bounds', {
        tabId,
        bounds,
        visible: this.#panelOpen,
      });
      return;
    }
    if (kind === 'terminal' && rect !== null) this.#fitTerminal(tabId);
  }

  /**
   * Push fresh bounds a few times while the canvas panel finishes animating.
   * Cheap, self-correcting, and it does not care how long the transition is —
   * as opposed to listening for `transitionend`, which never fires if the panel
   * was already open and would leave the view stranded in exactly the case this
   * exists to fix.
   */
  #renudge(kind: 'browser' | 'office', tabId: string, el: HTMLElement): void {
    const views = kind === 'browser' ? this.#browsers : this.#offices;
    for (const delay of [80, 220, 420, 700]) {
      setTimeout(() => {
        if (!views.has(tabId) && delay > 80) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const bounds = rectToBounds(rect);
        views.set(tabId, { ...(views.get(tabId) ?? {}), lastBounds: bounds, el });
        void window.piDesktop.invoke(`${kind}:set-bounds`, {
          tabId,
          bounds,
          visible: this.#panelOpen && this.#controller.getState().activeTabId === tabId,
        });
      }, delay);
    }
  }

  /**
   * Re-measure every native view from its live slot element and push bounds.
   *
   * Runs a few times across the resize: macOS live-resize emits continuously
   * and the flex layout settles after the event, so the last measurement taken
   * during the drag can still be one frame behind where the panel ends up.
   */
  #onWindowResize(): void {
    for (const delay of [0, 120, 320]) {
      setTimeout(() => {
        for (const [tabId, entry] of this.#offices) {
          const rect = entry.el?.getBoundingClientRect();
          if (!rect || rect.width === 0 || rect.height === 0) continue;
          const bounds = rectToBounds(rect);
          this.#offices.set(tabId, { ...entry, lastBounds: bounds });
          void window.piDesktop.invoke('office:set-bounds', {
            tabId,
            bounds,
            visible: this.#panelOpen && this.#controller.getState().activeTabId === tabId,
          });
        }
        for (const [tabId, entry] of this.#browsers) {
          const rect = entry.el?.getBoundingClientRect();
          if (!rect || rect.width === 0 || rect.height === 0) continue;
          const bounds = rectToBounds(rect);
          this.#browsers.set(tabId, { ...entry, lastBounds: bounds });
          void window.piDesktop.invoke('browser:set-bounds', {
            tabId,
            bounds,
            visible: this.#panelOpen && this.#controller.getState().activeTabId === tabId,
          });
        }
      }, delay);
    }
  }

  #hideOffice(tabId: string): void {
    const bounds = this.#offices.get(tabId)?.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 };
    void window.piDesktop.invoke('office:set-bounds', { tabId, bounds, visible: false });
  }

  // ── browser ──────────────────────────────────────────────────────────────
  #hideBrowser(tabId: string): void {
    const bounds = this.#browsers.get(tabId)?.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 };
    void window.piDesktop.invoke('browser:set-bounds', { tabId, bounds, visible: false });
  }

  /**
   * A canvas DOM menu (the `+` new-tab menu) opened/closed (round-10 #2). A live
   * browser WebContentsView paints ABOVE the DOM, so it would occlude the menu on
   * a browser tab — hide the ACTIVE browser view while the menu is up and re-show
   * it on close. Stateless: keyed off the currently-active tab each call, so a
   * pick that switches tabs leaves visibility to the normal mount/rect path.
   */
  setOverlayOpen(open: boolean): void {
    const activeId = this.#controller.getState().activeTabId;
    if (activeId === null) return;
    const tab = this.#tab(activeId);
    // Office editors paint above the DOM exactly like browser views do, so a
    // canvas menu opened over one is occluded unless it is lowered too.
    const kind = tab?.kind === 'browser' ? 'browser' : tab?.kind === 'office' ? 'office' : null;
    if (kind === null || tab === undefined) return;
    const entry = (kind === 'browser' ? this.#browsers : this.#offices).get(tab.id);
    if (entry === undefined) return;
    const setVisible = (visible: boolean) =>
      void window.piDesktop.invoke(`${kind}:set-bounds`, {
        tabId: tab.id,
        bounds: entry.lastBounds,
        // Never raise the view while the whole panel is closed.
        visible,
      });

    if (!open) {
      freezeFrame(entry.el, null);
      setVisible(this.#panelOpen);
      return;
    }

    /*
     * A LOWERED VIEW LEAVES A HOLE — so leave the last frame in it.
     *
     * the user: "browser tabs go blank when the + button is pressed?" They did, and
     * for a real reason: a native WebContentsView paints above every DOM element
     * in the window, so the `+` menu is invisible under the page unless the page
     * is taken down first. The page coming down is correct; the page coming down
     * and leaving white is what makes it look like the tab crashed.
     *
     * So capture the frame FIRST and paint it into the slot the view was sitting
     * on, then lower the view. `capturePage` on a view that is still on screen
     * is a matter of tens of milliseconds; the 180ms timer is there so a capture
     * that hangs cannot leave the menu stuck behind the page — after that the
     * view goes down regardless and the old blank is the worst case, not the
     * default one.
     */
    let lowered = false;
    const lower = () => {
      if (lowered) return;
      lowered = true;
      setVisible(false);
    };
    const timer = setTimeout(lower, 180);
    void window.piDesktop
      .invoke(`${kind}:capture`, { tabId: tab.id })
      .then((res) => {
        freezeFrame(entry.el, (res as { dataUrl?: string | null } | undefined)?.dataUrl ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        lower();
      });
  }

  /**
   * The canvas panel opened / closed (round-14 close bug). Closing the canvas
   * must fully hide EVERY native browser view — they paint over the DOM and are
   * not clipped by the collapsing aside, so without this they float, stranded,
   * over the chat column after close. Reopening re-shows only the ACTIVE browser
   * tab at its last bounds (the surface never unmounted, so the rect path can't
   * do it). The `#onRect` emit also honours `#panelOpen`, so a stray
   * scroll/resize while closed can't re-strand a view.
   */
  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
    const activeId = this.#controller.getState().activeTabId;
    for (const intent of browserBoundsForPanel(open, activeId, this.#browsers)) {
      void window.piDesktop.invoke('browser:set-bounds', intent);
    }
    // Office views need the SAME re-assert. Without it, an editor created while
    // the panel was still closed — the very first office tab in a session, since
    // opening it is what opens the panel — stays setVisible(false) forever. It
    // loads, lays out and finishes painting; it is simply never shown, which
    // looks identical to an editor that failed to render.
    for (const intent of browserBoundsForPanel(open, activeId, this.#offices)) {
      void window.piDesktop.invoke('office:set-bounds', intent);
    }
  }

  /** The editor behind an office tab swapped to the file's new bytes. */
  applyOfficeReloaded(p: { tabId: string }): void {
    const tab = this.#controller.getState().tabs.find((t) => t.id === p.tabId);
    if (tab === undefined) return;
    this.#controller.updateTab(tab.id, { updatedAt: Date.now() });
  }

  applyBrowserState(patch: {
    tabId: string;
    url?: string;
    title?: string;
    loading?: boolean;
    canGoBack?: boolean;
    canGoForward?: boolean;
    faviconUrl?: string;
  }): void {
    const { tabId, faviconUrl, ...rest } = patch;
    const tab = this.#controller.getState().tabs.find((t) => t.id === tabId);
    if (tab === undefined) return;
    const next: Partial<Omit<CanvasTab, 'id'>> = {};
    if (rest.url !== undefined) next.url = rest.url;
    if (rest.title !== undefined && rest.title !== '') next.title = rest.title;
    if (rest.loading !== undefined) next.loading = rest.loading;
    if (rest.canGoBack !== undefined) next.canGoBack = rest.canGoBack;
    if (rest.canGoForward !== undefined) next.canGoForward = rest.canGoForward;
    if (faviconUrl !== undefined) next.data = { ...tab.data, faviconUrl };
    this.#controller.updateTab(tabId, next);
  }

  // ── terminal ───────────────────────────────────────────────────────────────
  #ensureTerminal(tabId: string): TerminalEntry {
    const existing = this.#terminals.get(tabId);
    if (existing !== undefined) return existing;
    // A mirror tab renders tool-call output read-only (no shell); an interactive
    // tab spawns a PTY and forwards keystrokes.
    const mirror = this.#tab(tabId)?.data?.mirror === true;
    const term = new Terminal({
      allowTransparency: true,
      cursorBlink: !mirror,
      // A thin bar cursor (not the default chunky block) + the app theme so the
      // terminal matches the rest of the app (round-10 #5).
      cursorStyle: 'bar',
      /*
       * AND WHEN IT IS NOT FOCUSED. xterm draws a hollow BLOCK for an unfocused
       * cursor regardless of cursorStyle, which is the "thick terminal like
       * thing" the user saw — the terminal is unfocused most of the time it is being
       * looked at, so that block was the cursor as far as anyone could tell.
       */
      cursorInactiveStyle: 'bar',
      cursorWidth: 2,
      disableStdin: mirror,
      fontFamily: cssVar('--pd-font-mono', MONO_STACK),
      fontSize: 13,
      lineHeight: 1.2,
      allowProposedApi: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    term.open(container);
    const onData = mirror
      ? null
      : term.onData((data) => {
          void window.piDesktop.invoke('pty:write', { tabId, data });
        });
    const entry: TerminalEntry = {
      term,
      fit,
      container,
      spawned: false,
      onDataDispose: onData ? () => onData.dispose() : null,
      mirror,
      lastMirrorText: '',
      lastCols: 0,
      lastRows: 0,
    };
    this.#terminals.set(tabId, entry);
    return entry;
  }

  #mountTerminal(tabId: string, el: HTMLElement): void {
    const entry = this.#ensureTerminal(tabId);
    el.appendChild(entry.container);
    // Give the slot a layout pass before fitting so cols/rows are real.
    requestAnimationFrame(() => {
      this.#fitTerminal(tabId);
      if (entry.mirror) {
        this.#writeMirror(tabId, true);
      } else if (!entry.spawned) {
        entry.spawned = true;
        // Start the shell in the active project's cwd (round-10 #5) — the same
        // folder pi runs in — not the OS home default. `#cwd` is the live session
        // cwd (respawned to the project path when a project is active).
        void window.piDesktop.invoke('pty:spawn', {
          tabId,
          cols: entry.term.cols,
          rows: entry.term.rows,
          cwd: this.#cwd,
        });
        entry.term.focus();
      } else {
        entry.term.focus();
      }
    });
  }

  /**
   * Render a mirror terminal's current text into its xterm, CRLF-normalised.
   *
   * APPENDS when the new text merely GREW, which is the normal case: output
   * arriving, another command running. It used to `reset()` and rewrite the
   * whole buffer every time, and that is what made the live terminal feel like a
   * bad imitation of one — the screen rebuilt itself on every tick, scrollback
   * was thrown away, and anything the user had scrolled back to snapped away
   * under them. Writing only the new characters is what a terminal actually
   * does, so it reads as typing and the scroll position survives.
   *
   * A full reset is kept for the case that is genuinely not an append — the
   * mirror being repointed at a different agent, or text rewritten rather than
   * extended — where the old buffer is not a prefix of the new one.
   */
  #writeMirror(tabId: string, force = false): void {
    const entry = this.#terminals.get(tabId);
    if (entry === undefined || !entry.mirror) return;
    const text = (this.#tab(tabId)?.data?.mirrorText as string | undefined) ?? '';
    if (!force && text === entry.lastMirrorText) return;
    const previous = entry.lastMirrorText ?? '';
    const grew = !force && previous !== '' && text.startsWith(previous);
    entry.lastMirrorText = text;
    /*
     * The reset rides IN the write stream (ESC c — xterm's fullReset) rather
     * than as `term.reset()`: writes are queued and parsed later, a reset call
     * is immediate, so a rewrite issued between two ticks reset the screen
     * BEFORE the previous tick's text had been parsed — that text then landed
     * after the reset, under the new text, and every rewrite stacked up.
     */
    // A full reset also un-initialises xterm's cursor (see MIRROR_CURSOR_ON).
    const chunk = grew ? text.slice(previous.length) : `\x1bc${MIRROR_CURSOR_ON}${text}`;
    entry.term.write(chunk.replace(/\r?\n/g, '\r\n'));
  }

  /** Push new mirror text into any mounted mirror terminals (called on each
   * controller change). */
  #syncMirrors(): void {
    for (const [tabId, entry] of this.#terminals) {
      if (entry.mirror && entry.container.parentNode !== null) this.#writeMirror(tabId);
    }
  }

  /**
   * Re-read the theme into every live terminal — after the app's mode or
   * flavour changes, or the code theme or code font does. xterm re-renders on
   * an `options.theme` assignment; the font needs a refit, since the cell
   * size changed under the grid.
   */
  retheme(): void {
    const theme = terminalTheme();
    const fontFamily = cssVar('--pd-font-mono', MONO_STACK);
    for (const [tabId, entry] of this.#terminals) {
      entry.term.options.theme = theme;
      if (entry.term.options.fontFamily !== fontFamily) {
        entry.term.options.fontFamily = fontFamily;
        if (entry.container.isConnected) this.#fitTerminal(tabId);
      }
    }
  }

  #detachTerminal(tabId: string): void {
    const entry = this.#terminals.get(tabId);
    if (entry?.container.parentNode) entry.container.parentNode.removeChild(entry.container);
  }

  #fitTerminal(tabId: string): void {
    const entry = this.#terminals.get(tabId);
    if (entry === undefined || entry.container.parentNode === null) return;
    try {
      entry.fit.fit();
    } catch {
      return; // container not measurable yet
    }
    // Skip when the measured grid is unchanged: a scroll / focus / blur re-fires
    // the slot's onRectChange (→ this) without any real resize, and re-issuing
    // pty:resize on every such event churns the terminal for no reason.
    if (entry.term.cols === entry.lastCols && entry.term.rows === entry.lastRows) return;
    entry.lastCols = entry.term.cols;
    entry.lastRows = entry.term.rows;
    void window.piDesktop.invoke('pty:resize', {
      tabId,
      cols: entry.term.cols,
      rows: entry.term.rows,
    });
  }

  applyPtyData(payload: { tabId: string; data: string }): void {
    this.#terminals.get(payload.tabId)?.term.write(payload.data);
  }

  applyPtyExit(payload: { tabId: string; exitCode: number | null }): void {
    const code = payload.exitCode ?? 0;
    this.#terminals
      .get(payload.tabId)
      ?.term.write(`\r\n\x1b[90m[process exited (${code})]\x1b[0m\r\n`);
  }

  // ── reconcile: destroy views/PTYs whose tab left the controller ───────────
  syncTabs(): void {
    const live = new Set(this.#controller.getState().tabs.map((t) => t.id));
    for (const tabId of [...this.#browsers.keys()]) {
      if (!live.has(tabId)) {
        this.#browsers.delete(tabId);
        void window.piDesktop.invoke('browser:destroy', { tabId });
      }
    }
    for (const tabId of [...this.#offices.keys()]) {
      if (!live.has(tabId)) {
        this.#offices.delete(tabId);
        void window.piDesktop.invoke('office:destroy', { tabId });
      }
    }
    for (const [tabId, entry] of [...this.#terminals]) {
      if (!live.has(tabId)) {
        this.#terminals.delete(tabId);
        entry.onDataDispose?.();
        disposeTerminalSafely(entry);
        // Mirror terminals never spawned a PTY; kill is a no-op for them.
        if (!entry.mirror) void window.piDesktop.invoke('pty:kill', { tabId });
      }
    }
    // Push any updated tool-call output into mounted mirror terminals.
    this.#syncMirrors();
  }

  disposeAll(): void {
    this.#offResize?.();
    this.#offResize = undefined;
    for (const [tabId] of this.#browsers)
      void window.piDesktop.invoke('browser:destroy', { tabId });
    this.#browsers.clear();
    for (const [tabId] of this.#offices) void window.piDesktop.invoke('office:destroy', { tabId });
    this.#offices.clear();
    for (const [tabId, entry] of this.#terminals) {
      entry.onDataDispose?.();
      disposeTerminalSafely(entry);
      if (!entry.mirror) void window.piDesktop.invoke('pty:kill', { tabId });
    }
    this.#terminals.clear();
  }
}

/** What {@link useNativeSurfaces} returns: the handlers bag for `<CanvasTabs>`
 * plus the overlay-open seam that hides a native browser view while a DOM menu
 * is up (round-10 #2). */
export interface NativeSurfacesApi {
  handlers: CanvasTabsHandlers;
  /** The `+` new-tab menu opened/closed — lower/raise the active browser view. */
  setOverlayOpen: (open: boolean) => void;
  /** The canvas panel opened/closed — hide every native browser view on close,
   * re-show the active one on open (round-14 close bug). */
  setPanelOpen: (open: boolean) => void;
}

/**
 * Wire the native-surface managers for the panel: subscribes to the controller
 * (tab-removal → destroy) and to the `browser:*` / `pty:*` event streams, and
 * returns the stable handlers bag for `<CanvasTabs handlers={…}>` plus the
 * overlay-open seam.
 */
export function useNativeSurfaces(controller: CanvasController): NativeSurfacesApi {
  const ref = useRef<NativeSurfaces | null>(null);
  if (ref.current === null) ref.current = new NativeSurfaces(controller);
  const manager = ref.current;

  // Keep the session cwd fresh (the file-tree "Open from tree" breadcrumb).
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);
  manager.setCwd(cwd);

  // Push Bobble's resolved theme into the editor views, and re-push whenever the
  // theme attributes change. Reading the COMPUTED values rather than mirroring
  // the palette in TypeScript means a theme edit lands in the editors for free —
  // a hardcoded copy would drift silently and only show up in a screenshot.
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  // The code theme and font are two more triggers for the same reason: the
  // terminal reads its sixteen colours and its font off the computed style.
  const codeThemeLight = useSettingsStore((s) => s.settings.codeTheme.light);
  const codeThemeDark = useSettingsStore((s) => s.settings.codeTheme.dark);
  const codeFont = useSettingsStore((s) => s.settings.codeFont);
  /* `flavor` and `mode` are TRIGGERS, not values: the effect reads the computed
     CSS rather than these, which is the point (a theme edit lands in the
     editors for free). Dropping them, as the rule suggests, would stop the
     re-push on a theme change and leave the editors on the old palette. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme change is the trigger.
  useEffect(() => {
    const push = (): void => {
      manager.retheme();
      const cs = getComputedStyle(document.documentElement);
      const read = (name: string): string => cs.getPropertyValue(name).trim();
      const tokens = {
        bgBase: read('--pd-bg-base'),
        bgRaised: read('--pd-bg-raised'),
        bgInset: read('--pd-bg-inset'),
        textPrimary: read('--pd-text-primary'),
        textSecondary: read('--pd-text-secondary'),
        textMuted: read('--pd-text-muted'),
        borderDefault: read('--pd-border-default'),
        accentPrimary: read('--pd-accent-primary'),
        fontSans: read('--pd-font-sans'),
      };
      // Decide dark from the RESOLVED background rather than the mode name:
      // 'system' resolves either way, and a flavor may be dark-only. Parsed,
      // not scraped — see color-luma.ts for the light theme that read as dark.
      const dark = isDarkColor(tokens.bgBase);
      void window.piDesktop.invoke('office:set-theme', { tokens, dark }).catch(() => undefined);
    };
    // Next frame: the theme attributes are applied in a sibling effect, and
    // reading computed styles in the same tick can catch the previous palette.
    const id = requestAnimationFrame(push);
    return () => cancelAnimationFrame(id);
  }, [flavor, mode, codeThemeLight, codeThemeDark, codeFont]);

  // Ask ONCE whether this build shipped the vendored office editors, and let
  // the extension routing know. Until this resolves, docx/pptx/pdf keep opening
  // as the read-only previews — the honest default, since a build without the
  // fork genuinely has no editor.
  useEffect(() => {
    let cancelled = false;
    void window.piDesktop
      .invoke('office:available', {})
      .then((res) => {
        if (!cancelled) setOfficeEditorsAvailable(res.available === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubController = controller.subscribe(() => manager.syncTabs());
    const unsubBrowser = window.piDesktop.onEvent('browser:state', (p) =>
      manager.applyBrowserState(p),
    );
    const unsubOffice = window.piDesktop.onEvent('office:reloaded', (p) =>
      manager.applyOfficeReloaded(p),
    );
    const unsubData = window.piDesktop.onEvent('pty:data', (p) => manager.applyPtyData(p));
    const unsubExit = window.piDesktop.onEvent('pty:exit', (p) => manager.applyPtyExit(p));
    return () => {
      unsubController();
      unsubBrowser();
      unsubOffice();
      unsubData();
      unsubExit();
      manager.disposeAll();
    };
  }, [controller, manager]);

  // Stable callbacks (the manager is created once) so effects keyed on them
  // don't re-fire every render.
  const setOverlayOpen = useCallback((open: boolean) => manager.setOverlayOpen(open), [manager]);
  const setPanelOpen = useCallback((open: boolean) => manager.setPanelOpen(open), [manager]);
  return { handlers: manager.handlers, setOverlayOpen, setPanelOpen };
}
