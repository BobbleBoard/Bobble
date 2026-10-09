/**
 * The quick panel's IPC contract — the hotkey panel that floats over any app
 * (./quick-main.ts). Composed into the app-wide maps in ../ipc-contract.ts.
 *
 * The panel window and the main window both reach these channels (both are
 * trusted senders); the panel is the one that uses almost all of them, and the
 * main window hears `quick:main-action` when the panel hands it something to
 * open.
 */
import type { QuickContext } from './context';
import type { DismissReason } from './focus-return';
import type { QuickAction } from './hotkeys';
import type { PanelSize } from './placement';

/** The app that was in front when the panel was summoned. */
export interface QuickFrontApp {
  readonly pid: number;
  readonly name: string;
  readonly bundleId?: string;
  /** Its frontmost ordinary window, when one could be found. */
  readonly windowId?: number;
  /** True when the app in front was Bobble itself. */
  readonly isBobble?: boolean;
  /** Its real icon, from the system, as a data URL. */
  readonly icon?: string;
}

/**
 * Why something the person asked for could not happen — in a form the panel
 * turns into one plain sentence and a button that fixes it. Never a raw error.
 */
export interface QuickProblem {
  readonly kind: /** Screen Recording is off for Bobble: no pictures of other apps. */
    | 'screen-recording'
    /** Accessibility is off: no selected text, no replacing it. */
    | 'accessibility'
    /** macOS refused Bobble talking to an app (Finder, Safari, Chrome). */
    | 'automation'
    /** A password field has the keyboard: nothing is read. */
    | 'secure'
    /** There was nothing there: no window, an empty clipboard, no selection. */
    | 'nothing'
    /** The app in front is not one this works with (a browser read in Mail). */
    | 'unsupported'
    /** Anything else; `detail` says what, in words. */
    | 'failed';
  /** The app it concerns, when there is one. */
  readonly app?: string;
  /** One extra plain sentence, when the kind alone does not say enough. */
  readonly detail?: string;
}

export type QuickResult =
  | {
      readonly ok: true;
      readonly context: QuickContext;
      /** Something worth saying about a read that still worked (a page with no text). */
      readonly note?: QuickProblem;
    }
  | { readonly ok: false; readonly problem?: QuickProblem; readonly cancelled?: boolean };

/** One window the picker offers. */
export interface QuickWindowChoice {
  readonly windowId: number;
  readonly app: string;
  readonly title: string;
  /** The app's real icon, from the system, as a data URL. */
  readonly icon: string | null;
  /** A small picture of the window, as a data URL. */
  readonly thumbnail: string | null;
}

/** One hotkey's state, for Settings. */
export interface QuickHotkeyStatus {
  readonly action: QuickAction;
  readonly accelerator: string | null;
  /**
   * `registered` it works; `off` no key, or the panel is off; `blocked` it
   * collides with something it must not; `taken` another app holds it; `test`
   * a test run, which never registers a global key.
   */
  readonly state: 'registered' | 'off' | 'blocked' | 'taken' | 'test';
  readonly reason?: string;
}

/** A thread started in the panel, for its history. */
export interface QuickThread {
  readonly file: string;
  readonly title: string;
  readonly at: number;
}

/** Something the panel hands the main window to do. */
export type QuickMainAction =
  | { readonly kind: 'open-session'; readonly file: string }
  | { readonly kind: 'new-chat'; readonly prompt?: string }
  /** A `bobble:` link or its short form (`settings:quick-panel`, `studio:image`). */
  | { readonly kind: 'navigate'; readonly target: string }
  | { readonly kind: 'image-studio'; readonly prompt: string };

export type QuickSystemPane = 'screen-recording' | 'accessibility' | 'automation' | 'microphone';

export type QuickInvokeMap = {
  /** Put the panel away. Main decides whether the keyboard needs handing back. */
  'quick:dismiss': { request: { reason: DismissReason }; response: { ok: boolean } };
  /**
   * Bring the panel back, as it was, because its thread needs the person — a
   * computer-use run asking whether it may use an app, after Esc put the panel
   * away mid-run. Nothing is read from the Mac for it.
   */
  'quick:reveal': { request: undefined; response: { ok: boolean } };
  /** `height` (compact only): what the content measures, so the panel hugs it. */
  'quick:resize': {
    request: { size: PanelSize; height?: number };
    response: { ok: boolean; size: PanelSize };
  };
  /** Pinned: clicking outside does not put it away, and it stays where it was dragged. */
  'quick:set-pinned': { request: { pinned: boolean }; response: { ok: boolean } };
  /**
   * A picture for the thread: the window in front, a window by id (from the
   * picker), the whole screen, an area dragged out on an overlay, or a window
   * clicked on an overlay. The panel steps aside while the overlay is up.
   */
  'quick:capture': {
    request: {
      kind: 'front-window' | 'window' | 'screen' | 'region' | 'pick';
      windowId?: number;
    };
    response: QuickResult;
  };
  /** The windows on screen, with their apps' real icons — Bobble's own never listed. */
  'quick:list-windows': {
    request: undefined;
    response: { ok: boolean; windows: QuickWindowChoice[]; problem?: QuickProblem };
  };
  /** Read one more piece of context from the Mac, on the person's say-so. */
  'quick:read': {
    request: { kind: 'selection' | 'clipboard' | 'finder' | 'browser' };
    response: QuickResult;
  };
  /** Put a reply where the selection was, in the app it came from. */
  'quick:replace-selection': {
    request: { text: string };
    response: { ok: boolean; how?: 'accessibility' | 'paste'; problem?: QuickProblem };
  };
  /** Copy text — through main, so a test run never touches the real pasteboard. */
  'quick:copy': { request: { text: string }; response: { ok: boolean } };
  /** Bring up the main window (making it if it was closed) and hand it an action. */
  'quick:open-in-main': { request: { action: QuickMainAction }; response: { ok: boolean } };
  /** Open the System Settings pane that fixes a permission. */
  'quick:open-system-settings': { request: { pane: QuickSystemPane }; response: { ok: boolean } };
  /** Permissions (read without asking) and every hotkey's state. */
  'quick:status': {
    request: undefined;
    response: {
      enabled: boolean;
      permissions: {
        screen: 'granted' | 'denied' | 'unknown';
        accessibility: 'granted' | 'denied' | 'unknown';
      };
      hotkeys: QuickHotkeyStatus[];
      front: QuickFrontApp | null;
    };
  };
  /**
   * Let go of every hotkey while Settings records a new one — a registered key
   * would otherwise be swallowed before the recorder could see it.
   */
  'quick:suspend-hotkeys': { request: { suspended: boolean }; response: { ok: boolean } };
  'quick:history': { request: undefined; response: { threads: QuickThread[] } };
  'quick:remember-thread': { request: QuickThread; response: { ok: boolean } };
  'quick:forget-thread': { request: { file: string }; response: { ok: boolean } };
  /**
   * TEST RUNS ONLY (registered under PI_E2E=1): press a hotkey through IPC —
   * never a real global key — and set the fake Mac the panel reads from.
   */
  'quick:debug': {
    request: { op: string; params?: Record<string, unknown> };
    response: { ok: boolean; result?: unknown; error?: string };
  };
};

export type QuickEventMap = {
  /**
   * The panel was summoned. Sent BEFORE it is shown, carrying what was read
   * while the other app still had the keyboard: the app in front and its
   * selected text. `capture` is set when a hotkey went straight to a picture.
   */
  'quick:summoned': {
    action: QuickAction;
    front: QuickFrontApp | null;
    selection: QuickContext | null;
    /** Why the selection could not be read, when that is worth saying. */
    selectionProblem?: QuickProblem;
    capture?: QuickResult;
    at: number;
  };
  /** The panel came back by itself because its thread needs the person (quick:reveal). */
  'quick:revealed': { at: number };
  /** The panel was put away (by Esc, a click outside, or the hotkey again). */
  'quick:hidden': { reason: DismissReason };
  /** The main window's half: do this (open a chat, go to a studio…). */
  'quick:main-action': QuickMainAction;
  /** Something the panel should know while it is up: a capture is under way. */
  'quick:capturing': { kind: 'region' | 'pick' | 'screen' | 'window'; active: boolean };
};

export const QUICK_INVOKE_CHANNELS = [
  'quick:dismiss',
  'quick:reveal',
  'quick:resize',
  'quick:set-pinned',
  'quick:capture',
  'quick:list-windows',
  'quick:read',
  'quick:replace-selection',
  'quick:copy',
  'quick:open-in-main',
  'quick:open-system-settings',
  'quick:status',
  'quick:suspend-hotkeys',
  'quick:history',
  'quick:remember-thread',
  'quick:forget-thread',
  'quick:debug',
] as const satisfies readonly (keyof QuickInvokeMap)[];
