/**
 * Renderer half of the Mac computer-use MONITOR.
 *
 * Two jobs, deliberately separated:
 *
 *  1. THE FEED (`macMonitorFeed`) — a module-level singleton implementing the
 *     canvas package's `MacMonitorFeed`. It holds the session state, decodes
 *     JPEG frames to ImageBitmaps, and hands them to the surface imperatively.
 *     A 12fps stream must never write to the tab store, so nothing here goes
 *     through React: the surface subscribes and paints.
 *
 *  2. THE ROUTER (`useMacMonitor`) — mirrors browser-agent.ts's auto-open: when
 *     a computer-use session starts, open/focus one tab keyed `mac-monitor`,
 *     titled with the controlled app's name.
 *
 * Those two need DIFFERENT amounts of the stream, which is why the feed watches
 * with `frames: false` from app start (so the router can hear a session begin
 * for free) and only asks for frames while a surface is mounted and visible.
 * Screen capture is expensive; a tab nobody is looking at must not cause one.
 *
 * NEVER QUEUE. A frame that arrives while the previous one is still decoding
 * REPLACES it. Falling behind by dropping frames is a live view with a hiccup;
 * falling behind by queueing is a live view that is quietly minutes stale.
 */
import type {
  CanvasController,
  MacMonitorAxScene,
  MacMonitorCapabilities,
  MacMonitorDecodedFrame,
  MacMonitorFeed,
  MacMonitorSessionState,
  MacMonitorViewMode,
} from '@pi-desktop/canvas';
import { IDLE_MAC_MONITOR_SESSION } from '@pi-desktop/canvas';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { abortPi, pausePi } from '../../state/pi-connect';
import { useSettingsStore } from '../../state/settings-store';
import { appIconSrc } from '../app-icons';

/** Stable upsert key for the monitor tab — one tab, reused across sessions. */
export const MAC_MONITOR_TAB_KEY = 'mac-monitor';

/** How many frame arrivals the fps readout averages over. */
const FPS_WINDOW = 12;

/** Where the stage placement is remembered. There is exactly one monitor tab,
 * so one setting — and it has to outlive a tab close, because the tab reopens
 * by itself on the next session. */
const VIEW_MODE_KEY = 'pd.macmon.view';

interface RawFrame {
  seq: number;
  t: number;
  jpeg: Uint8Array;
  rect: MacMonitorSessionState['rect'];
  windows: MacMonitorDecodedFrame['windows'];
}

class MacMonitorFeedImpl implements MacMonitorFeed {
  #session: MacMonitorSessionState = IDLE_MAC_MONITOR_SESSION;
  #frame: MacMonitorDecodedFrame | null = null;
  /** The Accessibility drawing's source, when the pixels cannot come. Plain
   * JSON off the wire — no decode, so no async and no generation guard. */
  #ax: MacMonitorAxScene | null = null;
  #listeners = new Set<() => void>();
  #wallpaper: HTMLImageElement | null = null;
  #wallpaperUrl: string | null = null;
  #arrivals: number[] = [];
  /** The one frame waiting for the decoder — replaced, never appended. */
  #pending: RawFrame | null = null;
  #decoding = false;
  /**
   * Bumped whenever the picture is invalidated (session ended, "no window"
   * frame). JPEG decoding is ASYNC, so a frame that was already in the decoder
   * when control ended would otherwise be installed AFTERWARDS — the monitor
   * then shows a live-looking window under an "app has no window" panel.
   * Measured exactly that, in the probe screenshot.
   */
  #generation = 0;
  /** Are we currently asking main for frames? */
  #framesWanted = false;
  #wired = false;
  /**
   * The user took the app back.
   *
   * Operator's takeover mode carries the load-bearing promise that the agent
   * "does not collect or screenshot information entered by the user", and for a
   * panel streaming a real window that is a must-have AND a must-state: the
   * very next thing a user does in an app the agent just opened is often typing
   * a password into it. So this does not merely hide the picture — it STOPS THE
   * CAPTURE CHILD and refuses to restart it until the user hands back.
   */
  #takenOver = false;
  #viewMode: MacMonitorViewMode = readViewMode();

  // ── the wire ─────────────────────────────────────────────────────────────

  /** Start watching state (no frames). Idempotent; called once at app start. */
  start(): void {
    if (this.#wired) return;
    this.#wired = true;
    window.piDesktop.onEvent('mac:monitor:state', (state) => {
      this.#applySession(state);
    });
    window.piDesktop.onEvent('mac:monitor:frame', (payload) => {
      this.#onFrame(payload);
    });
    window.piDesktop.onEvent('mac:monitor:ax', (scene) => {
      this.#ax = scene;
      this.#notify();
    });
    void this.#send(false);
  }

  /**
   * Ask macOS for Screen Recording. Main puts up the system's own Allow/Deny
   * alert and, only if that alert cannot appear again, opens the pane instead.
   */
  requestCapture(): void {
    void window.piDesktop.invoke('mac:monitor:request-capture', {}).catch(() => undefined);
  }

  /** The unhappy path: someone who already said no has to use the pane. */
  openCaptureSettings(): void {
    void window.piDesktop.invoke('mac:monitor:request-capture', {}).catch(() => undefined);
  }

  async #send(frames: boolean): Promise<void> {
    try {
      const res = await window.piDesktop.invoke('mac:monitor:subscribe', { frames });
      if (res?.state !== undefined) this.#applySession(res.state);
    } catch {
      /* macOS-only channel, or main not ready — the idle state is correct */
    }
  }

  #applySession(state: {
    active: boolean;
    appName: string;
    stream: MacMonitorSessionState['stream'];
    streamError: string | null;
    wallpaperUrl: string | null;
    rect: MacMonitorSessionState['rect'];
    statusText: string;
    cursorState: MacMonitorSessionState['cursorState'];
    cursor: { x: number; y: number } | null;
    bubbleVisible: boolean;
    captureDenied?: boolean;
  }): void {
    // A brand-new session is a new story: the user's take-over ended with the
    // run it interrupted.
    if (state.active && !this.#session.active) this.#takenOver = false;
    this.#session = {
      active: state.active,
      appName: state.appName,
      stream: state.stream,
      streamError: state.streamError,
      wallpaperUrl: state.wallpaperUrl,
      rect: state.rect,
      statusText: state.statusText,
      cursorState: state.cursorState,
      cursor: state.cursor,
      bubbleVisible: state.bubbleVisible,
      captureDenied: state.captureDenied === true,
    };
    this.#ensureWallpaper(state.wallpaperUrl);
    if (!state.active) {
      this.#dropFrame();
      this.#ax = null;
    }
    // Pixels are back: the drawing is stale the instant a real one arrives, and
    // holding it would let a stutter in the stream flip between a photograph
    // and a rendering of the same window.
    if (state.stream === 'live') this.#ax = null;
    this.#notify();
  }

  #ensureWallpaper(url: string | null): void {
    if (url === this.#wallpaperUrl) return;
    this.#wallpaperUrl = url;
    this.#wallpaper = null;
    if (url === null) return;
    // An <img> rather than fetch()+createImageBitmap: the renderer CSP allows
    // `img-src … pd-file:` but not a fetch of it.
    const img = new Image();
    img.decoding = 'async';
    // The media scheme answers with `access-control-allow-origin: *`, but an
    // <img> is only treated as CORS-clean when it ASKS. Without this the
    // wallpaper taints the canvas, and a tainted canvas cannot be read back —
    // which breaks pixel assertions and any future export of this surface.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.#wallpaperUrl !== url) return;
      this.#wallpaper = img;
      this.#notify();
    };
    img.onerror = () => {
      if (this.#wallpaperUrl === url) this.#wallpaper = null;
    };
    img.src = url;
  }

  // ── frames ───────────────────────────────────────────────────────────────

  #onFrame(payload: RawFrame): void {
    this.#arrivals.push(performance.now());
    if (this.#arrivals.length > FPS_WINDOW) this.#arrivals.shift();
    if (payload.jpeg.length === 0) {
      // The helper's once-only "no window" frame: clear the picture, keep the
      // session. Showing the last good frame here would be a lie.
      this.#pending = null;
      this.#dropFrame();
      this.#frame = {
        seq: payload.seq,
        t: payload.t,
        bitmap: null,
        rect: payload.rect ?? { x: 0, y: 0, w: 0, h: 0 },
        windows: payload.windows,
      };
      this.#notify();
      return;
    }
    this.#pending = payload;
    if (!this.#decoding) void this.#drain();
  }

  async #drain(): Promise<void> {
    this.#decoding = true;
    try {
      for (;;) {
        const next = this.#pending;
        this.#pending = null;
        if (next === undefined || next === null) return;
        const generation = this.#generation;
        let bitmap: ImageBitmap;
        try {
          // Copy into a fresh ArrayBuffer: the IPC payload may be a view onto a
          // pooled buffer, and createImageBitmap is async.
          const bytes = new Uint8Array(next.jpeg);
          bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        } catch {
          continue; // a corrupt frame is not worth a state change
        }
        // A newer frame landed while we decoded — this one is already stale.
        // A CHANGED GENERATION means the picture itself is void (the session
        // ended, or the app lost its window) and this frame must not resurrect it.
        if (this.#pending !== null || generation !== this.#generation) {
          bitmap.close();
          continue;
        }
        this.#dropFrame();
        this.#frame = {
          seq: next.seq,
          t: next.t,
          bitmap,
          rect: next.rect ?? { x: 0, y: 0, w: 0, h: 0 },
          windows: next.windows,
        };
        this.#notify();
      }
    } finally {
      this.#decoding = false;
    }
  }

  #dropFrame(): void {
    this.#generation += 1;
    this.#frame?.bitmap?.close();
    this.#frame = null;
  }

  // ── MacMonitorFeed ───────────────────────────────────────────────────────

  getSession(): MacMonitorSessionState {
    return this.#session;
  }

  getFrame(): MacMonitorDecodedFrame | null {
    return this.#frame;
  }

  getAxScene(): MacMonitorAxScene | null {
    return this.#ax;
  }

  getWallpaper(): HTMLImageElement | null {
    return this.#wallpaper;
  }

  // ── the actions row ──────────────────────────────────────────────────────

  getCapabilities(): MacMonitorCapabilities {
    // Stop and Pause are the composer's own two calls, so the brake in this tab
    // and the brake under the chat are the same brake. Take over is honest
    // about what it can do from here: it stands the agent down and stops the
    // capture. Bringing the app itself to the front needs main's `activate`,
    // which is one call away in mac-agent's dispatch and not wired yet.
    return { stop: true, pause: true, takeOver: true };
  }

  stop(): void {
    void abortPi();
  }

  pause(): void {
    void pausePi();
  }

  takeOver(): void {
    if (this.#takenOver) return;
    this.#takenOver = true;
    void abortPi();
    this.#dropFrame();
    this.#ax = null;
    // Not `setActive(false)`: that is the surface's own visibility signal and
    // the surface is still mounted. This unsubscribes for real, which is what
    // makes main stop the `pi-mac --stream` child.
    void this.#send(false);
    this.#notify();
  }

  handBack(): void {
    if (!this.#takenOver) return;
    this.#takenOver = false;
    void this.#send(this.#framesWanted);
    this.#notify();
  }

  isTakenOver(): boolean {
    return this.#takenOver;
  }

  /* the user's Open button. The only thing in this file that intends to move the
     user's focus, and it only ever runs from their click. */
  openApp(): void {
    void window.piDesktop.invoke('mac:monitor:open-app', {}).catch(() => undefined);
  }

  appIcon(app: string): string | undefined {
    return appIconSrc(app);
  }

  getViewMode(): MacMonitorViewMode {
    return this.#viewMode;
  }

  setViewMode(mode: MacMonitorViewMode): void {
    this.#viewMode = mode;
    try {
      window.localStorage?.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* private mode / storage disabled — the choice just does not persist */
    }
  }

  getFps(): number {
    if (this.#arrivals.length < 3) return 0;
    const first = this.#arrivals[0] as number;
    const last = this.#arrivals[this.#arrivals.length - 1] as number;
    const span = last - first;
    if (span <= 0) return 0;
    // Stale stream: no arrivals for a while means zero, not a remembered rate.
    if (performance.now() - last > 2000) return 0;
    return ((this.#arrivals.length - 1) * 1000) / span;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /*
   * The pill toggle, read and written where the pill IS. the user asked for it "in
   * the canvas as a toggle setting during computer use and in the settings
   * menu" — the same setting, reachable from both, because the moment you want
   * it gone is the moment you are looking at it.
   */
  getStatusPillShown(): boolean {
    return useSettingsStore.getState().settings.showComputerUseStatusPill !== false;
  }

  setStatusPillShown(next: boolean): void {
    void useSettingsStore.getState().update({ showComputerUseStatusPill: next });
    this.#notify();
  }

  setActive(active: boolean): void {
    if (active === this.#framesWanted) return;
    this.#framesWanted = active;
    // While the user is driving, nothing starts a capture — not a tab switch,
    // not the window becoming visible again.
    if (this.#takenOver) return;
    if (!active) {
      this.#arrivals = [];
      this.#pending = null;
      // Nobody is watching, so nothing is polling: keeping the last drawing
      // would show a window as it was when the tab was hidden.
      this.#ax = null;
    }
    void this.#send(active);
  }

  #notify(): void {
    for (const l of [...this.#listeners]) {
      try {
        l();
      } catch {
        /* one bad listener must not stop the rest */
      }
    }
  }
}

/** The remembered stage placement, or `auto` on a first run. */
function readViewMode(): MacMonitorViewMode {
  try {
    const raw = window.localStorage?.getItem(VIEW_MODE_KEY);
    return raw === 'fit' || raw === 'follow' || raw === 'auto' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** The app-wide feed (one controlled app at a time, like the helper itself). */
export const macMonitorFeed = new MacMonitorFeedImpl();

/**
 * Decide what the monitor tab should do given the session and what is already
 * open. Pure so the routing rule is testable without a canvas or an IPC wire.
 */
export function macMonitorTabAction(
  session: { active: boolean; appName: string },
  existing: { id: string; title: string } | undefined,
): { kind: 'open'; title: string } | { kind: 'retitle'; id: string; title: string } | null {
  // A session that ended leaves a tab titled "TextEdit" over a panel saying
  // nothing is being controlled — the tab and its contents disagreeing about
  // what the tab is. Retitle rather than close: a tab that vanishes out from
  // under someone who was watching it is worse than one that says nothing is
  // being controlled.
  if (!session.active) {
    if (existing === undefined || existing.title === 'Computer use') return null;
    return { kind: 'retitle', id: existing.id, title: 'Computer use' };
  }
  const title = session.appName.trim() === '' ? 'Computer use' : session.appName.trim();
  if (existing === undefined) return { kind: 'open', title };
  if (existing.title !== title) return { kind: 'retitle', id: existing.id, title };
  return null;
}

/**
 * Open/focus the computer-use monitor tab when a session starts, and keep its
 * title on the app being driven. Mirrors `useBrowserAgent`'s auto-open.
 *
 * The tab is NOT closed when the session ends: the surface shows its own idle
 * state, and a tab that vanishes out from under someone who was watching it is
 * worse than one that says "nothing is being controlled".
 */
export function useMacMonitor(controller: CanvasController): void {
  const opened = useRef(false);

  useEffect(() => {
    macMonitorFeed.start();
    const apply = (): void => {
      const session = macMonitorFeed.getSession();
      const existing = controller.getState().tabs.find((t) => t.key === MAC_MONITOR_TAB_KEY);
      const action = macMonitorTabAction(
        session,
        existing === undefined ? undefined : { id: existing.id, title: existing.title },
      );
      if (action === null) {
        if (existing === undefined) opened.current = false;
        return;
      }
      if (action.kind === 'retitle') {
        controller.updateTab(action.id, { title: action.title });
        return;
      }
      controller.upsertTab(MAC_MONITOR_TAB_KEY, {
        kind: 'computer-use',
        key: MAC_MONITOR_TAB_KEY,
        title: action.title,
        macMonitor: macMonitorFeed,
      });
      const tab = controller.getState().tabs.find((t) => t.key === MAC_MONITOR_TAB_KEY);
      if (tab !== undefined) controller.focusTab(tab.id);
      useCanvasStore.getState().setCanvasOpen(true);
      opened.current = true;
    };
    apply();
    return macMonitorFeed.subscribe(apply);
  }, [controller]);
}
