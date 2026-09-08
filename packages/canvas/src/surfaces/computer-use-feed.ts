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

/**
 * One element of the controlled app, as Accessibility reports it.
 *
 * `bbox` is the pi-mac wire's own space: x,y are the element's CENTRE in global
 * screen points. Left in that space all the way to the renderer so the number
 * the surface draws is byte-identical to the number the model acted on.
 */
export interface MacMonitorAxElement {
  index: number;
  role: string;
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  /** Only ever what AX returned; absent is "unknown", never "empty". */
  value?: string;
  editable?: boolean;
  focused?: boolean;
  enabled?: boolean;
  win?: number;
}

/** One window / sheet / dialog in an AX scene. */
export interface MacMonitorAxWindow {
  windowId: number;
  title: string;
  role: string;
  subrole: string;
  frame: MacMonitorRect;
  main: boolean;
  focused: boolean;
  sheet: boolean;
  modal: boolean;
}

/**
 * The controlled app with no pixels in it: enough to DRAW the window when the
 * Screen Recording grant is missing. `rect` is the union of every window —
 * computed exactly as the capture path computes its own — so switching between
 * the two sources moves nothing.
 */
export interface MacMonitorAxScene {
  t: number;
  pid: number;
  appName: string;
  rect: MacMonitorRect;
  display: { w: number; h: number } | null;
  /** Front-to-back. */
  windows: MacMonitorAxWindow[];
  elements: MacMonitorAxElement[];
}

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
  /** The capture failed specifically because macOS has not granted this app
   * Screen Recording — the one failure with a fix the user can act on. */
  captureDenied: boolean;
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
  /** The newest Accessibility scene, or null when none has arrived. Present
   * only while the pixel stream is unavailable — see the contract. */
  getAxScene(): MacMonitorAxScene | null;
  /** Show the user where the Screen Recording switch lives. */
  requestCapture?(): void;
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
  captureDenied: false,
};
