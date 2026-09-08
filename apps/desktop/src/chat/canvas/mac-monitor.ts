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
  MacMonitorDecodedFrame,
  MacMonitorFeed,
  MacMonitorSessionState,
} from '@pi-desktop/canvas';
import { IDLE_MAC_MONITOR_SESSION } from '@pi-desktop/canvas';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';

/** Stable upsert key for the monitor tab — one tab, reused across sessions. */
export const MAC_MONITOR_TAB_KEY = 'mac-monitor';

/** How many frame arrivals the fps readout averages over. */
const FPS_WINDOW = 12;

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
    void this.#send(false);
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
  }): void {
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
    };
    this.#ensureWallpaper(state.wallpaperUrl);
    if (!state.active) this.#dropFrame();
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

  getWallpaper(): HTMLImageElement | null {
    return this.#wallpaper;
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

  setActive(active: boolean): void {
    if (active === this.#framesWanted) return;
    this.#framesWanted = active;
    if (!active) {
      this.#arrivals = [];
      this.#pending = null;
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
  if (!session.active) return null;
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
