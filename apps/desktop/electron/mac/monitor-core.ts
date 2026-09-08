/**
 * The computer-use MONITOR's logic, with no electron in it.
 *
 * Everything that decides anything lives here — when the capture child may run,
 * what a subscriber is sent, how a dead helper is retried and when it is given
 * up on, how the published state is assembled from the overlay's — so all of it
 * unit-tests in plain Node with a fake child and a fake sink (the same
 * structural-injection rule the rest of `electron/` follows). `monitor.ts` is
 * the electron half: ipcMain handlers, a WebContents→sink adapter, the real
 * spawn, and the wallpaper cache.
 *
 * ── TWO GATES, BOTH REQUIRED ────────────────────────────────────────────────
 * The child runs only while (a) a computer-use session is controlling an app
 * and (b) at least one subscriber wants FRAMES. Screen capture is a compositor
 * tap that keeps the GPU busy, so a monitor tab the user switched away from
 * must cost nothing, and a session with no tab open must not capture at all.
 *
 * ── ONE SOURCE OF TRUTH FOR THE PHANTOM ─────────────────────────────────────
 * The cursor point, the bubble text and the tracked window rect are not derived
 * here. They are pushed in from the overlay controller, which already owns them
 * to drive the real on-screen overlay. A second derivation of the same tool
 * events would drift, and a monitor whose phantom is somewhere the real one is
 * not is worse than no monitor.
 */
import {
  EMPTY_MAC_MONITOR_STATE,
  type MacMonitorFramePayload,
  type MacMonitorState,
  type MacMonitorStreamState,
} from './mac-monitor-contract';
import type { MacOverlayState } from './overlay-geometry';
import { PimfParser } from './pimf';

/** Capture cadence asked of the helper. 12fps reads as live without making the
 * stream the most expensive thing the app does. */
export const STREAM_FPS = 12;
/** Cap the captured pixel width; a 6K window scaled into a canvas rail does not
 * need 6K of JPEG per frame. */
export const STREAM_MAX_WIDTH = 1400;
/** A child that dies is retried this many times before the stream is called
 * unavailable — an old helper with no `--stream` dies instantly, every time. */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 800;
/** A child that survived this long counts as having worked, so its exit resets
 * the restart budget rather than spending it. */
const HEALTHY_RUN_MS = 5_000;

/** Injected reader for the helper's `wallpaper` method (mac-agent owns the one
 * long-lived helper pipe; the monitor never opens a second one). */
export type WallpaperReader = () => Promise<{ path?: string } | null>;

/** Injected converter: a system wallpaper path → a path the renderer can load. */
export type WallpaperResolver = (source: string) => Promise<{ source: string; url: string } | null>;

/** The capture child, structurally — so a fake stands in for `pi-mac`. */
export interface StreamChild {
  readonly pid?: number;
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type StreamSpawnFn = (pid: number, args: readonly string[]) => StreamChild;

/** One watching renderer, abstracted away from WebContents. */
export interface MonitorSink {
  /** Whether this sink wants FRAMES as well as state. */
  frames: boolean;
  sendState(state: MacMonitorState): void;
  sendFrame(frame: MacMonitorFramePayload): void;
  /** The renderer is gone; drop it on the next fan-out. */
  isGone(): boolean;
}

export interface MacMonitorCoreOptions {
  spawn: StreamSpawnFn;
  wallpaperReader?: WallpaperReader;
  wallpaperResolver?: WallpaperResolver;
  /** Injected so tests need no timers of their own. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

const IDLE_OVERLAY: MacOverlayState = {
  engaged: false,
  pid: null,
  rect: null,
  cursor: null,
  cursorState: 'idle',
  statusText: '',
  bubbleVisible: false,
  wantsVisible: false,
};

export class MacMonitorCore {
  #sinks = new Set<MonitorSink>();
  #session: { pid: number; appName: string } | null = null;
  #child: StreamChild | null = null;
  #childStartedAt = 0;
  #parser = new PimfParser();
  #restarts = 0;
  #restartHandle: unknown = null;
  #stream: MacMonitorStreamState = 'idle';
  #streamError: string | null = null;
  #wallpaper: { path: string; url: string } | null = null;
  #wallpaperPending: Promise<void> | null = null;
  #overlay: MacOverlayState = IDLE_OVERLAY;
  #lastSentJson = '';
  /** The CAPTURED union rect (main window plus its sheets), which is what the
   * surface must draw — the overlay's AX frame is only the main window. */
  #frameRect: MacMonitorState['rect'] = null;
  #frameDisplay: MacMonitorState['display'] = null;
  #now: () => number = () => Date.now();

  readonly #opts: MacMonitorCoreOptions;

  constructor(opts: MacMonitorCoreOptions) {
    this.#opts = opts;
  }

  /** Test seam: control the clock the restart-health rule reads. */
  setClock(now: () => number): void {
    this.#now = now;
  }

  setWallpaperReader(reader: WallpaperReader): void {
    this.#opts.wallpaperReader = reader;
    this.#wallpaper = null;
  }

  setSpawn(spawn: StreamSpawnFn): void {
    this.#opts.spawn = spawn;
  }

  // ── the phantom's state, pushed in from the overlay ─────────────────────

  setOverlayState(state: MacOverlayState): void {
    this.#overlay = state;
    // The overlay dropping its target IS the session ending — the two must not
    // be able to disagree about whether an app is being driven.
    if (!state.engaged && this.#session !== null) this.clearSession();
    else this.broadcastState();
  }

  // ── session lifecycle ──────────────────────────────────────────────────

  /** A computer-use act took control of `pid`. Idempotent per pid. */
  setSession(pid: number, appName: string): void {
    const name = appName.trim();
    if (this.#session?.pid === pid) {
      if (name !== '' && name !== this.#session.appName) {
        this.#session = { pid, appName: name };
        this.broadcastState();
      }
      return;
    }
    this.#session = { pid, appName: name };
    this.#restarts = 0;
    this.#streamError = null;
    this.#stopChild();
    this.#stream = 'idle';
    void this.ensureWallpaper();
    this.reconcile();
    this.broadcastState();
  }

  /** The session ended (setDriving:false, the window vanished, the app quit). */
  clearSession(): void {
    if (this.#session === null && this.#stream === 'idle') return;
    this.#session = null;
    this.#stopChild();
    this.#stream = 'idle';
    this.#streamError = null;
    this.#frameRect = null;
    this.#frameDisplay = null;
    this.reconcile();
    this.broadcastState();
  }

  // ── subscribers ────────────────────────────────────────────────────────

  addSink(sink: MonitorSink): MacMonitorState {
    this.#sinks.add(sink);
    // A fresh subscriber has seen nothing, so the dedupe (which compares
    // against what was last sent to ANYONE) must not swallow its first push.
    this.#lastSentJson = '';
    void this.ensureWallpaper();
    this.reconcile();
    // Push as well as return: the invoke response covers the subscriber that
    // just asked, but a re-subscribe (a surface asking for frames) and the
    // wallpaper arriving later both reach everyone through the event.
    this.broadcastState();
    return this.state();
  }

  removeSink(sink: MonitorSink): void {
    if (!this.#sinks.delete(sink)) return;
    this.reconcile();
  }

  /** For the electron adapter: find this renderer's existing sink, if any. */
  sinks(): ReadonlySet<MonitorSink> {
    return this.#sinks;
  }

  // ── published state ────────────────────────────────────────────────────

  state(): MacMonitorState {
    const session = this.#session;
    const o = this.#overlay;
    return {
      ...EMPTY_MAC_MONITOR_STATE,
      active: session !== null,
      pid: session?.pid ?? null,
      appName: session?.appName ?? '',
      stream: this.#stream,
      streamError: this.#streamError,
      wallpaperPath: this.#wallpaper?.path ?? null,
      wallpaperUrl: this.#wallpaper?.url ?? null,
      rect: this.#frameRect ?? (o.rect === null ? null : { ...o.rect }),
      display: this.#frameDisplay,
      statusText: o.statusText,
      cursorState: o.cursorState,
      cursor: o.cursor,
      bubbleVisible: o.bubbleVisible,
    };
  }

  broadcastState(): void {
    if (this.#sinks.size === 0) return;
    const state = this.state();
    // Cursor moves are frequent; an identical state is not worth a wire hop.
    const json = JSON.stringify(state);
    if (json === this.#lastSentJson) return;
    this.#lastSentJson = json;
    for (const sink of [...this.#sinks]) {
      if (sink.isGone()) {
        this.#sinks.delete(sink);
        continue;
      }
      try {
        sink.sendState(state);
      } catch {
        /* a dead renderer must never break the stream */
      }
    }
  }

  #broadcastFrame(payload: MacMonitorFramePayload): void {
    for (const sink of [...this.#sinks]) {
      if (sink.isGone()) {
        this.#sinks.delete(sink);
        continue;
      }
      if (!sink.frames) continue;
      try {
        sink.sendFrame(payload);
      } catch {
        /* drop the frame for this renderer; the next one will do */
      }
    }
  }

  // ── the capture child ──────────────────────────────────────────────────

  /** Should the capture child be running right now? BOTH gates. */
  wanted(): boolean {
    if (this.#session === null) return false;
    for (const sink of this.#sinks) {
      if (sink.frames && !sink.isGone()) return true;
    }
    return false;
  }

  reconcile(): void {
    if (this.wanted()) this.#startChild();
    else this.#stopChild();
  }

  /** Diagnostics/tests: is a capture child running? */
  streaming(): boolean {
    return this.#child !== null;
  }

  #startChild(): void {
    if (this.#child !== null || this.#restartHandle !== null) return;
    const session = this.#session;
    if (session === null) return;
    // Already gave up for this session; a new setSession() clears it.
    if (this.#stream === 'unavailable') return;
    let child: StreamChild;
    try {
      child = this.#opts.spawn(session.pid, [
        '--stream',
        '--pid',
        String(session.pid),
        '--fps',
        String(STREAM_FPS),
        '--max-width',
        String(STREAM_MAX_WIDTH),
      ]);
    } catch (err) {
      this.#giveUp(err instanceof Error ? err.message : String(err));
      return;
    }
    this.#child = child;
    this.#childStartedAt = this.#now();
    this.#parser.reset();
    this.#stream = 'starting';
    this.broadcastState();

    child.stdout?.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr?.on('data', () => {
      /* the helper's diagnostics are logged by the electron adapter */
    });
    child.on('error', (err) => this.#onChildGone(child, err.message));
    child.on('close', (code) =>
      this.#onChildGone(child, code === 0 ? null : `pi-mac --stream exited (${String(code)})`),
    );
  }

  #onStdout(chunk: Buffer): void {
    for (const { header, payload } of this.#parser.push(chunk)) {
      this.#frameRect = { ...header.rect };
      this.#frameDisplay = { ...header.display };
      // The contract's once-only "no window" frame: an empty window list AND a
      // zero-byte payload. Anything else is a picture.
      const next: MacMonitorStreamState =
        header.windows.length === 0 && payload.length === 0 ? 'no-window' : 'live';
      if (next !== this.#stream) {
        this.#stream = next;
        this.#streamError = null;
      }
      this.#broadcastFrame({
        seq: header.seq,
        t: header.t,
        jpeg: payload,
        w: header.w,
        h: header.h,
        rect: { ...header.rect },
        display: { ...header.display },
        windows: header.windows.map((w) => ({
          windowId: w.windowId,
          title: w.title,
          frame: { ...w.frame },
          sheet: w.sheet === true,
          modal: w.modal === true,
        })),
      });
      this.broadcastState();
    }
  }

  #onChildGone(child: StreamChild, reason: string | null): void {
    // A stale 'close' from a child we already replaced must not restart anything.
    if (this.#child !== child) return;
    const lived = this.#now() - this.#childStartedAt;
    this.#child = null;
    this.#parser.reset();
    if (!this.wanted()) {
      if (this.#stream !== 'unavailable') this.#stream = 'idle';
      this.broadcastState();
      return;
    }
    // A child that ran for a while and then stopped is a hiccup, not a helper
    // that cannot stream — don't spend the give-up budget on it.
    if (lived >= HEALTHY_RUN_MS) this.#restarts = 0;
    if (this.#restarts >= MAX_RESTARTS) {
      this.#giveUp(reason ?? 'the capture stream stopped');
      return;
    }
    this.#restarts += 1;
    const setTimer = this.#opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#restartHandle = setTimer(() => {
      this.#restartHandle = null;
      if (this.wanted()) this.#startChild();
    }, RESTART_DELAY_MS);
    (this.#restartHandle as { unref?: () => void })?.unref?.();
  }

  #giveUp(reason: string): void {
    this.#stream = 'unavailable';
    this.#streamError = reason;
    this.#opts.log?.warn('mac monitor stream unavailable', { reason });
    this.broadcastState();
  }

  #stopChild(): void {
    if (this.#restartHandle !== null) {
      const clearTimer = this.#opts.clearTimer ?? ((h) => clearTimeout(h as never));
      clearTimer(this.#restartHandle);
      this.#restartHandle = null;
    }
    const child = this.#child;
    this.#child = null;
    this.#parser.reset();
    if (child === null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    if (this.#stream !== 'unavailable') this.#stream = 'idle';
  }

  // ── wallpaper ──────────────────────────────────────────────────────────

  /**
   * Fetch + convert the desktop picture once. Concurrent callers JOIN the
   * in-flight promise rather than being told "already going" — otherwise a
   * caller that awaits this can return before the picture is actually there,
   * which is the kind of race that only ever shows up as a backdrop that is
   * sometimes missing.
   */
  ensureWallpaper(): Promise<void> {
    if (this.#wallpaper !== null) return Promise.resolve();
    if (this.#wallpaperPending !== null) return this.#wallpaperPending;
    const reader = this.#opts.wallpaperReader;
    if (reader === undefined) return Promise.resolve();
    const run = (async () => {
      try {
        const res = await reader();
        const source = typeof res?.path === 'string' ? res.path : '';
        if (source === '') return;
        const resolve = this.#opts.wallpaperResolver;
        const cached = resolve === undefined ? null : await resolve(source);
        if (cached === null) return;
        this.#wallpaper = { path: cached.source, url: cached.url };
        this.broadcastState();
      } catch {
        /* a backdrop is never worth an error the user has to read */
      } finally {
        this.#wallpaperPending = null;
      }
    })();
    this.#wallpaperPending = run;
    return run;
  }

  dispose(): void {
    this.#stopChild();
    this.#sinks.clear();
    this.#session = null;
    this.#wallpaper = null;
    this.#stream = 'idle';
    this.#lastSentJson = '';
  }
}
