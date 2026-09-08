/**
 * IPC contract for the Mac computer-use MONITOR — the canvas tab that live-
 * streams the controlled app's window (plus its sheets and dialogs) while Pi
 * drives it.
 *
 * Round-21 shared contract, Lane A. Main owns a `pi-mac --stream --pid <n>`
 * child and forwards its frames; the renderer's `computer-use` surface draws
 * them at real point size over the user's wallpaper with the phantom cursor on
 * top. Pure types + a runtime channel list, composed into ../ipc-contract.ts.
 *
 * The stream child runs ONLY while both halves are true — a session is
 * controlling an app AND at least one renderer is subscribed — so a monitor tab
 * nobody is looking at costs nothing.
 */

/** A rect in global macOS screen POINTS, top-left origin. */
export interface MacMonitorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One window inside a streamed frame. */
export interface MacMonitorWindow {
  windowId: number;
  title: string;
  frame: MacMonitorRect;
  /** A sheet attached to the main window (a Save panel, say). */
  sheet: boolean;
  modal: boolean;
}

/** What the phantom cursor is doing — mirrors the overlay bubble exactly. */
export type MacMonitorCursorState =
  | 'idle'
  | 'opening'
  | 'thinking'
  | 'clicking'
  | 'typing'
  | 'pressing'
  | 'scrolling'
  | 'reading';

/** The lifecycle of the capture child, so the surface can be honest about
 * which of "nothing to show" it is in. */
export type MacMonitorStreamState =
  | 'idle' // no session, or nobody subscribed
  | 'starting' // child spawned, first frame not in yet
  | 'live' // frames arriving
  | 'no-window' // streaming, but the app has no on-screen window
  | 'unavailable'; // the helper cannot stream (older build / capture refused)

export interface MacMonitorState {
  /** A computer-use session is controlling an app. */
  active: boolean;
  pid: number | null;
  appName: string;
  stream: MacMonitorStreamState;
  /** Why the stream is unavailable, when it is (shown quietly, never as a toast). */
  streamError: string | null;
  /**
   * The wallpaper's ORIGINAL path (diagnostics only — the renderer cannot load
   * it; see `wallpaperUrl`). Named for the shared contract's `wallpaperPath`.
   */
  wallpaperPath: string | null;
  /** ADDITIVE to the contract: the `pd-file://` URL the renderer may load. The
   * raw system path is refused by the media scheme's root fence. */
  wallpaperUrl: string | null;
  /** The controlled window's union frame, in screen points. */
  rect: MacMonitorRect | null;
  display: { w: number; h: number } | null;
  /** The bubble's label payload (typed preview / key combo / app name). */
  statusText: string;
  cursorState: MacMonitorCursorState;
  /** GLOBAL screen point — the same space as `rect`. */
  cursor: { x: number; y: number } | null;
  /** ADDITIVE: the overlay's bubble fades after an idle spell; mirror that. */
  bubbleVisible: boolean;
}

export interface MacMonitorFramePayload {
  seq: number;
  /** ms epoch, from the capture. */
  t: number;
  /** JPEG bytes. ZERO-LENGTH is the legal "no window" frame. */
  jpeg: Uint8Array;
  /** Pixel size of the JPEG. */
  w: number;
  h: number;
  /** Union rect in screen POINTS — the size to draw at. */
  rect: MacMonitorRect;
  display: { w: number; h: number };
  windows: MacMonitorWindow[];
}

export type MacMonitorInvokeMap = {
  /**
   * Renderer → main: watch the monitor. Returns the current state so the
   * surface paints immediately.
   *
   * ADDITIVE to the shared contract: `frames`. Two things need to know about a
   * computer-use session and they need different amounts of it — the tab
   * ROUTER must hear that a session started (so it can open the tab at all),
   * while only a MOUNTED, VISIBLE surface should cause a screen capture. One
   * boolean keeps that as one subscription instead of two channels: a state-
   * only watcher costs nothing, and the capture child runs while at least one
   * subscriber has `frames: true`. Omitted means true, so a caller sending the
   * contract's bare `{}` gets frames.
   */
  'mac:monitor:subscribe': {
    request: { frames?: boolean };
    response: { ok: boolean; state: MacMonitorState };
  };
  /** Renderer → main: stop receiving frames; the last unsubscribe stops the child. */
  'mac:monitor:unsubscribe': {
    request: Record<string, never>;
    response: { ok: boolean };
  };
};

export const MAC_MONITOR_INVOKE_CHANNELS = [
  'mac:monitor:subscribe',
  'mac:monitor:unsubscribe',
] as const satisfies readonly (keyof MacMonitorInvokeMap)[];

export type MacMonitorEventMap = {
  /** Main → renderer: session / cursor / bubble / wallpaper state changed. */
  'mac:monitor:state': MacMonitorState;
  /** Main → renderer: one captured frame. Never queued — the renderer decodes
   * the newest and drops anything it could not keep up with. */
  'mac:monitor:frame': MacMonitorFramePayload;
};

/** The idle state, shared by main and the renderer feed so "nothing yet" looks
 * the same on both sides. */
export const EMPTY_MAC_MONITOR_STATE: MacMonitorState = {
  active: false,
  pid: null,
  appName: '',
  stream: 'idle',
  streamError: null,
  wallpaperPath: null,
  wallpaperUrl: null,
  rect: null,
  display: null,
  statusText: '',
  cursorState: 'idle',
  cursor: null,
  bubbleVisible: false,
};
