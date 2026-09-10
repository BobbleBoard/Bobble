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
 *
 * ── AND TWO PATHS TO THE PIXELS ─────────────────────────────────────────────
 * macOS keys the Screen Recording grant to the BINARY that calls the capture
 * API. `pi-mac --stream` is separately signed, so enabling "Bobble" in System
 * Settings — the only name a user would ever look for — grants a binary that
 * does no capturing, and the monitor stays blind with no way to work out why.
 * So the PREFERRED path is Chromium's own window capture, which runs inside
 * Electron under the app's identity: main publishes `sources` (one Chromium
 * source id per window, joined to the AX side by CGWindowID) and the renderer
 * opens them. The helper stream stays as the fallback for a machine where the
 * helper holds the grant and the app does not.
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

/** Which binary is producing the pixels — see the header's two-paths note. */
export type MacMonitorCaptureSource =
  | 'none' // nothing is capturing (no session, nobody watching, or no grant)
  | 'electron' // Chromium, under the app's own identity — the preferred path
  | 'helper'; // pi-mac --stream, the fallback

/** One window Chromium will hand the renderer pixels for. `windowId` is the
 * CGWindowID, which is how the Accessibility side names the same window — so
 * the two halves join with no guessing about which picture goes where. */
export interface MacMonitorWindowSource {
  /** Chromium's source id (`window:<CGWindowID>:0`), for getUserMedia. */
  sourceId: string;
  windowId: number;
  name: string;
}

/** How the monitor is being driven right now. The user can take the brake
 * (`stopped`) or the wheel (`user`); both cut the agent off from the Mac, and
 * both stop every capture — see mac-agent.ts's `macControl`. */
export type MacMonitorControl = 'agent' | 'stopped' | 'user';

/**
 * The Screen Recording explainer, written where the facts are.
 *
 * Main is the only side that knows WHICH binary was refused, and whether this
 * is a first run or macOS's monthly re-ask — so the sentences live here rather
 * than in the surface, which would have to guess at both.
 */
export interface MacMonitorCaptureNotice {
  title: string;
  body: string;
  /** The button. It only ever OPENS the pane; no code can grant anything. */
  cta: string;
  /** The part everybody forgets: the grant does not apply until a relaunch. */
  hint: string;
}

export interface MacMonitorState {
  /** A computer-use session is controlling an app. */
  active: boolean;
  pid: number | null;
  appName: string;
  stream: MacMonitorStreamState;
  /**
   * Why the stream is unavailable, when it is — the RAW reason (a helper exit
   * code, a status frame's error id). Belongs behind a "Technical detail"
   * disclosure; `streamMessage` is the sentence to show.
   */
  streamError: string | null;
  /** The same fact as a sentence a person can read. Never a process message. */
  streamMessage: string | null;
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
  /**
   * The grant WAS held earlier in this app run and is gone now. macOS Sequoia
   * re-asks for Screen Recording about once a month, and a user who misses or
   * declines that alert lands in the denied state thirty days after everything
   * was working — which reads as the feature breaking by itself.
   */
  captureRevoked: boolean;
  /** The name the user will actually find in the Screen Recording list. The
   * whole point of capturing from Electron is that this can say "Bobble". */
  captureAppName: string;
  /** The explainer, or null when there is nothing to explain. */
  captureNotice: MacMonitorCaptureNotice | null;
  /** Which path is producing the picture right now. */
  captureSource: MacMonitorCaptureSource;
  /**
   * The windows the renderer may open pixel streams for, back-to-front — only
   * ever non-empty while `captureSource === 'electron'`.
   */
  sources: MacMonitorWindowSource[];
  /** The picture has stopped arriving while the stream still claims to be live
   * — "slow" and "stuck" must not look the same. */
  stalled: boolean;
  /** ms since the last frame or scene arrived; null when nothing has arrived. */
  lastPictureAgeMs: number | null;
  /** ms the bubble has been on 'thinking' — a model that has gone quiet must
   * say so rather than showing the same three dots forever. */
  thinkingMs: number | null;
  /** Who has the wheel. */
  control: MacMonitorControl;
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
    /**
     * `granted` is true when the system's own Allow/Deny alert was answered
     * Allow — the one-click path. False means the alert will not appear again
     * for this app and the Screen Recording pane was opened instead.
     */
    response: { ok: boolean; granted?: boolean };
  };
  /**
   * Renderer → main: THE BRAKE, and the wheel.
   *
   * `stop` cuts the agent off from the Mac immediately — the phantom goes, the
   * capture stops, and every further `mac_*` act is refused until the user says
   * otherwise. `takeover` is the same cut plus "you are driving": nothing is
   * captured while the user types, which is the promise that makes handing the
   * keyboard back and forth safe. `resume` is the explicit hand-back; nothing
   * the MODEL does can clear a stop, or the brake would not be one.
   */
  'mac:monitor:control': {
    request: { mode: MacMonitorControl };
    response: { ok: boolean; control: MacMonitorControl };
  };
  /**
   * Bring the controlled app to the front, because the USER asked to see it.
   *
   * the user: "have a prominent Open <app icon> <app name> <square with top right
   * arrow> prominently in the top right of the computer use canvas area." This
   * is the one thing in this subsystem that is supposed to take the screen —
   * everything else goes out of its way not to — and it only ever runs from a
   * click, never from the model.
   */
  'mac:monitor:open-app': {
    request: Record<string, never>;
    response: { ok: boolean; app?: string };
  };
};

export const MAC_MONITOR_INVOKE_CHANNELS = [
  'mac:monitor:subscribe',
  'mac:monitor:unsubscribe',
  'mac:monitor:request-capture',
  'mac:monitor:control',
  'mac:monitor:open-app',
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
  /**
   * Main → renderer: the user asked to SEE this, from outside the app — they
   * clicked the phantom's own bubble while it floated over the app being
   * driven. Main has already brought the window forward; the tab is the
   * renderer's half.
   */
  'mac:monitor:reveal': { pid: number | null };
};

/** The idle state, shared by main and the renderer feed so "nothing yet" looks
 * the same on both sides. */
export const EMPTY_MAC_MONITOR_STATE: MacMonitorState = {
  active: false,
  pid: null,
  appName: '',
  stream: 'idle',
  streamError: null,
  streamMessage: null,
  wallpaperPath: null,
  wallpaperUrl: null,
  rect: null,
  display: null,
  statusText: '',
  cursorState: 'idle',
  cursor: null,
  bubbleVisible: false,
  captureDenied: false,
  captureRevoked: false,
  captureAppName: 'Bobble',
  captureNotice: null,
  captureSource: 'none',
  sources: [],
  stalled: false,
  lastPictureAgeMs: null,
  thinkingMs: null,
  control: 'agent',
};

/** The helper's status-frame reason for "macOS has not granted this app Screen
 * Recording" — the ONE capture failure that has a fix the user can act on. */
export const MAC_CAPTURE_DENIED = 'screen-recording-denied';

/** The helper's status-frame reason for "there is nothing on screen to share". */
export const MAC_CAPTURE_NO_WINDOW = 'no-shareable-window';

/** Where macOS keeps the Screen Recording switch. Opening it is all any app can
 * do — the grant itself is deliberately unreachable from code. */
export const MAC_SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** Never say "the app" when we know its name, and never say "" when we don't. */
function named(appName: string): string {
  const name = appName.trim();
  return name === '' ? 'the app' : name;
}

/**
 * WHY THE PICTURE IS NOT THERE, IN A SENTENCE.
 *
 * What used to reach the screen was `session.streamError` — i.e. literally
 * `pi-mac --stream exited (1)`, set in a monospace face. Nobody outside this
 * repo knows what `pi-mac` is, and a process message at the moment something
 * breaks reads as "an engineer will have to look at this". The raw reason still
 * travels, as `streamError`, for the disclosure that exists for engineers.
 */
export function streamMessageFor(reason: string | null, appName: string): string | null {
  if (reason === null) return null;
  const app = named(appName);
  if (reason === MAC_CAPTURE_DENIED) {
    return `macOS has not given Bobble permission to record the screen, so it cannot show you ${app}.`;
  }
  if (reason === MAC_CAPTURE_NO_WINDOW) return `${app} has nothing on screen to show.`;
  return `The live view stopped. Bobble is still controlling ${app}.`;
}

/**
 * The Screen Recording explainer.
 *
 * Two things this has to get right, both learned the hard way. It must name
 * the binary the user will actually see in the list — the reason the pixels now
 * come from Electron at all — and it must say that macOS does not apply the
 * switch until the app is relaunched, because the state a user lands in
 * otherwise is "I granted it, I double-checked it, and it still does nothing".
 */
export function captureNoticeFor(opts: {
  appName: string;
  revoked: boolean;
  captureAppName?: string;
}): MacMonitorCaptureNotice {
  const app = named(opts.appName);
  const me = opts.captureAppName ?? 'Bobble';
  const hint = `Turn on "${me}" under Screen Recording, then quit and reopen ${me} — macOS only applies the change on relaunch.`;
  const still = `${me} is still controlling ${app} — clicks and typing work without it; you just cannot watch.`;
  if (opts.revoked) {
    return {
      title: 'macOS asks for this again every month',
      body: `It just asked, and Screen Recording is off again. ${still}`,
      cta: 'Open Privacy & Security',
      hint,
    };
  }
  return {
    title: `${me} can't see ${app} yet`,
    body: `Screen Recording lets ${me} show you what it is doing. ${still}`,
    cta: 'Open Privacy & Security',
    hint,
  };
}
