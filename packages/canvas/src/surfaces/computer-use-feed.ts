/**
 * The contract between the computer-use SURFACE (this package, pure React) and
 * whatever is actually streaming frames (the desktop app, over IPC).
 *
 * The surface must not re-render per frame — at 12fps a store write per frame
 * would repaint the whole canvas rail forty times a minute for nothing — so
 * frames are pushed through this imperative feed and drawn straight onto a
 * `<canvas>`. React state is used only for the things that genuinely change
 * rarely: the session, the app name, the stream's health.
 *
 * `setActive` is the surface telling the feed whether anyone is looking. That
 * is what stops the capture: no mounted surface → no subscriber → main stops
 * the `pi-mac --stream` child.
 */

export interface MacMonitorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MacMonitorWindowInfo {
  windowId: number;
  title: string;
  frame: MacMonitorRect;
  sheet: boolean;
  modal: boolean;
}

export type MacMonitorCursorState =
  | 'idle'
  | 'opening'
  | 'thinking'
  | 'clicking'
  | 'typing'
  | 'pressing'
  | 'scrolling'
  | 'reading';

export type MacMonitorStreamState = 'idle' | 'starting' | 'live' | 'no-window' | 'unavailable';

/** Everything about the session that changes slowly enough to live in React. */
export interface MacMonitorSessionState {
  active: boolean;
  appName: string;
  stream: MacMonitorStreamState;
  streamError: string | null;
  /** A URL the renderer may load (the app resolves the real path to one). */
  wallpaperUrl: string | null;
  rect: MacMonitorRect | null;
  statusText: string;
  cursorState: MacMonitorCursorState;
  /** GLOBAL screen point, in the same space as `rect`. */
  cursor: { x: number; y: number } | null;
  bubbleVisible: boolean;
}

/** The newest decoded frame. `bitmap` is null for the "no window" frame. */
export interface MacMonitorDecodedFrame {
  seq: number;
  t: number;
  bitmap: ImageBitmap | null;
  rect: MacMonitorRect;
  windows: MacMonitorWindowInfo[];
}

export interface MacMonitorFeed {
  getSession(): MacMonitorSessionState;
  /** The newest frame, or null before the first one arrives. */
  getFrame(): MacMonitorDecodedFrame | null;
  /** The decoded wallpaper backdrop, or null while it loads / has none. */
  getWallpaper(): ImageBitmap | HTMLImageElement | null;
  /** Frames per second over the recent window (0 before enough frames). */
  getFps(): number;
  /** Notified on any session change AND on every new frame. */
  subscribe(listener: () => void): () => void;
  /** Tell the feed whether a surface is mounted and visible. */
  setActive(active: boolean): void;
}

export const IDLE_MAC_MONITOR_SESSION: MacMonitorSessionState = {
  active: false,
  appName: '',
  stream: 'idle',
  streamError: null,
  wallpaperUrl: null,
  rect: null,
  statusText: '',
  cursorState: 'idle',
  cursor: null,
  bubbleVisible: false,
};
