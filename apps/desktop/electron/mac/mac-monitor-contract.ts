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
 *
 * ── TWO SOURCES FOR ONE PICTURE ─────────────────────────────────────────────
 * Pixels need the Screen Recording grant. Accessibility does not, and it is the
 * grant computer-use already cannot work without. So when the capture stream is
 * unavailable — the grant is off, or the helper cannot share the window — main
 * ALSO publishes a `MacMonitorAxScene`: the same windows, the same frames, the
 * same union rect, plus every element the AX tree reports at its real bbox. The
 * surface draws that instead of an error panel. It is a DRAWING, never a
 * photograph, and the surface says so on its face.
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
  /**
   * ADDITIVE: the stream is unavailable specifically because macOS has not
   * granted this app Screen Recording — as opposed to any other reason a
   * capture can fail. The surface offers the fix for exactly this one.
   */
  captureDenied: boolean;
}

/**
 * One element of the controlled app, as Accessibility reports it.
 *
 * `bbox` is the pi-mac wire contract's: x,y are the element's CENTRE in global
 * screen points, w,h its size. Kept in that space (rather than converted to a
 * top-left rect here) so it stays byte-comparable with what the model's own
 * snapshot sees — one number transformed in one place, in the renderer.
 */
export interface MacMonitorAxElement {
  index: number;
  role: string;
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  /** Only ever what AX returned. Never a placeholder. */
  value?: string;
  editable?: boolean;
  focused?: boolean;
  enabled?: boolean;
  /** CGWindowID of the surface this element lives in. */
  win?: number;
}

/** One window/sheet/dialog in an AX scene. Front-to-back, like the helper. */
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
 * The controlled app as Accessibility sees it — everything needed to DRAW it
 * without a single captured pixel.
 *
 * `rect` is the union of every window, exactly as the capture path's header
 * rect is, so a surface switching between the two sources does not move.
 */
export interface MacMonitorAxScene {
  /** ms epoch of the poll that produced it. */
  t: number;
  pid: number;
  appName: string;
  /** Union of every window in `windows`, in screen points. */
  rect: MacMonitorRect;
  display: { w: number; h: number } | null;
  /** Front-to-back, like the helper's own ordering. */
  windows: MacMonitorAxWindow[];
  elements: MacMonitorAxElement[];
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
  /**
   * Renderer → main: show the user where to turn Screen Recording on.
   *
   * It OPENS the pane; it never toggles anything. macOS deliberately makes the
   * grant unreachable from code, and the honest version of "turn it on" is
   * therefore "put you in front of the switch" — plus a best-effort nudge that
   * registers this app in the list so there is a switch to find.
   */
  'mac:monitor:request-capture': {
    request: Record<string, never>;
    response: { ok: boolean };
  };
};

export const MAC_MONITOR_INVOKE_CHANNELS = [
  'mac:monitor:subscribe',
  'mac:monitor:unsubscribe',
  'mac:monitor:request-capture',
] as const satisfies readonly (keyof MacMonitorInvokeMap)[];

export type MacMonitorEventMap = {
  /** Main → renderer: session / cursor / bubble / wallpaper state changed. */
  'mac:monitor:state': MacMonitorState;
  /** Main → renderer: one captured frame. Never queued — the renderer decodes
   * the newest and drops anything it could not keep up with. */
  'mac:monitor:frame': MacMonitorFramePayload;
  /**
   * Main → renderer: the controlled app as Accessibility sees it, ~4Hz, sent
   * ONLY while the pixel stream is unavailable and someone is watching. It rides
   * beside `mac:monitor:frame` rather than replacing it so the surface picks a
   * source instead of main deciding for it — and so a capture grant arriving
   * mid-session simply starts producing frames again.
   */
  'mac:monitor:ax': MacMonitorAxScene;
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
  captureDenied: false,
};

/** The helper's status-frame reason for "macOS has not granted this app Screen
 * Recording" — the ONE capture failure that has a fix the user can act on. */
export const MAC_CAPTURE_DENIED = 'screen-recording-denied';
