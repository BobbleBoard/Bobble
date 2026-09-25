/**
 * The mac_* tool set — the model's remote control for ANY Mac app.
 *
 * Design goals mirror browser-use's: EFFICIENT (never dump the whole AX tree;
 * the indexed snapshot is the model's view), ROBUST (re-snapshot on a stale
 * index, retry a failed action once, structured errors — never throw), and
 * GATED (every tool routes through the per-session consent + app denylist before
 * it acts — see ./permissions.ts).
 *
 * Acting model: prefer index-based AX actions (the helper resolves `index →
 * AXUIElement` from the last snapshot and prefers the element's AXPress action —
 * reliable, no coordinate math). Pass explicit x,y for a raw coordinate click on
 * an AX-opaque surface (games / some Electron apps), the analogue of browser-
 * use's canvasHeavy coordinate fallback.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { MacBridge } from './bridge-client.js';
import {
  CHROME_SNAPSHOT_JS,
  type ChromeTabInfo,
  chromeActionJs,
  chromeEval,
  chromeJsAllowed,
  chromePid,
  chromeRunning,
  chromeTabs,
  enableChromeJs,
} from './chrome.js';
import {
  blockedIndexes,
  dialogName,
  dialogOf,
  dialogSignature,
  formatMacSnapshot,
  isAxOpaque,
  type MacSnapshotView,
  type ResolvedDialog,
  whoseLookLines,
} from './format.js';
import type { MacConsentGate } from './permissions.js';
import { createMacConsentGate } from './permissions.js';
import type {
  MacActAck,
  MacAgentMethod,
  MacBrakeAck,
  MacLaunchAck,
  MacMenuAck,
  MacMenuEntry,
  MacSnapshot,
  MacTccStatus,
  MacWindowInfo,
} from './protocol.js';
import { scrollDelta } from './scroll.js';
import { createMacSessionState, type MacSessionState } from './session-state.js';

// Tool-name constants live in the dependency-free ./tool-names.ts (single source
// of truth, cheaply importable by the harness); re-exported here for existing
// call sites.
export {
  CHROME_CLICK_TOOL,
  CHROME_GO_TOOL,
  CHROME_SNAPSHOT_TOOL,
  CHROME_TAB_TOOL,
  CHROME_TABS_TOOL,
  CHROME_TYPE_TOOL,
  MAC_CLICK_TOOL,
  MAC_COMPUTER_USE_TOOL_NAMES,
  MAC_KEY_TOOL,
  MAC_LAUNCH_TOOL,
  MAC_SCROLL_TOOL,
  MAC_SNAPSHOT_TOOL,
  MAC_TYPE_TOOL,
} from './tool-names.js';

import { shareTool } from '@pi-desktop/tool-bus';
import { type Embedder, nearMissNote, type PageLine, searchPageBoth } from './page-search.js';
import {
  CHROME_CLICK_TOOL,
  CHROME_GO_TOOL,
  CHROME_SNAPSHOT_TOOL,
  CHROME_TAB_TOOL,
  CHROME_TABS_TOOL,
  CHROME_TYPE_TOOL,
  MAC_CLICK_TOOL,
  MAC_KEY_TOOL,
  MAC_LAUNCH_TOOL,
  MAC_SCROLL_TOOL,
  MAC_SNAPSHOT_TOOL,
  MAC_TYPE_TOOL,
} from './tool-names.js';

const DEFAULT_ELEMENT_CAP = 60;
/** Let a click/type settle before the model's next snapshot. */
const SETTLE_MS = 350;

interface MacDetails {
  action: string;
  ok: boolean;
  app?: string;
  window?: string;
  elementCount?: number;
  /** True when the act ran via Accessibility with no focus steal; false when it
   * fell back to the foreground CGEvent path. Absent for read-only actions. */
  background?: boolean;
  /** Concrete helper path taken (AXPress / setValue / setValue+confirm / coord …). */
  mode?: string;
  error?: string;
  [k: string]: unknown;
}

/** How the model reads a background vs foreground act, appended to tool text so
 * the trace shows focus-free vs focus-stealing steps. */
function backgroundNote(ack: MacActAck): string {
  /*
   * THE APP TOOK THE FRONT ITSELF. The act was delivered in the background,
   * and the app activated anyway — Chrome does on ⌘L, on a new tab, on a new
   * window. The helper's focus guard hands the user's app straight back
   * (Serve.swift, handBackFocus); the model hears which, so it neither
   * believes it changed nothing nor keeps reaching for the same chord.
   */
  if (ack.tookFocus === true) {
    return ack.focusRestored === true
      ? ` (${ack.note ?? 'the app came to the front for a moment; focus was handed back'} — prefer acting by [index], which does not do that)`
      : ` (${ack.note ?? 'the app took the front and it could not be handed back'})`;
  }
  if (ack.background === true)
    return ` (background via ${ack.mode ?? 'Accessibility'}, no focus change)`;
  if (ack.background === false) return ` (foreground ${ack.mode ?? 'CGEvent'} — took focus)`;
  return '';
}

export interface MacComputerUseOptions {
  /** The bridge to the app; when null every tool reports a clear unavailable
   * error (extension loaded outside Pi Desktop). */
  readonly bridge: MacBridge | null;
  /** The consent/denylist gate; defaults to a fresh session gate. */
  readonly consent?: MacConsentGate;
  /** The controlled-app state machine; defaults to a fresh one (test seam). */
  readonly session?: MacSessionState;
  /**
   * Where the LAST app computer use controlled is remembered across chats
   * (production: ~/.pi/agent/mac-last-control.json). Absent = not remembered,
   * which is what a unit test wants.
   */
  readonly lastControlFile?: string;
  readonly elementCap?: number;
  /**
   * How the Chrome tab list is read over Apple Events. Injectable because the
   * real one talks to the DEVELOPER'S OWN Chrome, and a unit test that hands in
   * a fake bridge was silently being answered by it — the tabs test passed only
   * while that browser happened to have two tabs open, and failed the moment it
   * had one. A test that depends on the machine it runs on is not a test.
   */
  readonly readChromeTabs?: () => Promise<ChromeTabInfo[] | null>;
  /** Whether Chrome is running (the chrome_* set) — same reason: a unit test
   *  must not depend on, or launch, the Chrome of the machine running it. */
  readonly isChromeRunning?: () => Promise<boolean>;
  /** Chrome's pid (the chrome_* set; default pgrep) — the same reason again. */
  readonly chromePid?: () => Promise<number | null>;
  /** Turns short texts into vectors, for the `like` search. Absent until an
   *  embedding model is deployed; the keyword half answers alone until then. */
  readonly embedText?: Embedder;
}

/** The helper's answer to any of the tab verbs. */
interface MacTabsAck {
  ok?: boolean;
  app?: string;
  error?: string;
  note?: string;
  tookFocus?: boolean;
  selected?: string;
  closed?: string;
  tabs?: { index: number; title: string; active: boolean; url?: string }[];
}

/** `app` only when one was named — an absent app means "the one being driven". */
function appParam(app: string | undefined): Record<string, unknown> {
  return app === undefined || app === '' ? {} : { app };
}

/** The Apple-Events answer, which knows URLs and every window. */
function formatChromeTabs(tabs: readonly ChromeTabInfo[]): string {
  const windows = new Set(tabs.map((t) => t.window));
  const lines = tabs.map((t) => {
    const where = windows.size > 1 ? `w${t.window}/` : '';
    const title = t.title === '' ? '(untitled)' : t.title;
    return `${t.active ? '*' : ' '} [${where}${t.index}] ${title}\n      ${t.url}`;
  });
  return [
    `Google Chrome — ${tabs.length} tab${tabs.length === 1 ? '' : 's'}` +
      `${windows.size > 1 ? ` across ${windows.size} windows` : ''} (* = front):`,
    ...lines,
  ].join('\n');
}

/** The tab strip as the user sees it: numbered, with the front one marked. */
function formatTabs(res: MacTabsAck): string {
  const tabs = res.tabs ?? [];
  if (tabs.length === 0) return 'No tabs.';
  const lines = tabs.map(
    (t) => `${t.active ? '*' : ' '} [${t.index}] ${t.title === '' ? '(untitled)' : t.title}`,
  );
  return [
    `${res.app ?? 'Browser'} — ${tabs.length} tab${tabs.length === 1 ? '' : 's'} (* = front):`,
    ...lines,
  ].join('\n');
}

function textResult(text: string, details: MacDetails): AgentToolResult<MacDetails> {
  return { content: [{ type: 'text', text }], details };
}

/**
 * What an act CAUSED, said in the result of the act that caused it.
 *
 * A save sheet arrives a few hundred milliseconds after the key that summoned
 * it. Without this line the model has no reason to look again, so its next act
 * goes into a window that is by then blocked behind a dialog it never saw —
 * and macOS drops that input silently, which reads to the user as the model
 * having simply stopped working.
 */
function describeOpened(
  dialog: MacWindowInfo | undefined,
  opened: readonly MacWindowInfo[] | undefined,
): string {
  if (dialog !== undefined) {
    const name = dialog.title !== undefined && dialog.title !== '' ? `"${dialog.title}"` : 'one';
    const kind = dialog.sheet === true ? 'sheet' : 'dialog';
    return ` A ${kind} is now open (${name}) — it belongs to this app; snapshot and act on its controls.`;
  }
  if (opened !== undefined && opened.length > 0) {
    const titles = opened
      .map((w) => (w.title !== undefined && w.title !== '' ? `"${w.title}"` : 'an untitled window'))
      .join(', ');
    return ` A new window opened (${titles}) — snapshot to see it.`;
  }
  return '';
}

/**
 * The requests that put something on the user's screen: the phantom cursor and
 * the monitor follow each of them (apps/desktop/electron/mac/mac-agent.ts).
 * Reads — the policy, the grants, a tab list — do not.
 */
const DRIVING_METHODS: ReadonlySet<MacAgentMethod> = new Set<MacAgentMethod>([
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'launch',
  'menuClick',
  'tabSelect',
  'tabNew',
  'tabClose',
]);

/** The bridge, noting on the session every request that drives (see `endTurn`). */
function noticed(bridge: MacBridge | null, session: MacSessionState | undefined): MacBridge | null {
  if (bridge === null || session === undefined) return bridge;
  return {
    request<T>(method: MacAgentMethod, params?: Record<string, unknown>): Promise<T> {
      if (DRIVING_METHODS.has(method)) session.noteDriving();
      return bridge.request<T>(method, params);
    },
  };
}

/**
 * THE USER'S BRAKE, FOR THE ROUTES THAT NEVER REACH IT.
 *
 * Stop and Take over are enforced where acts arrive — the bridge refuses every
 * act and look (mac-agent.ts, controlRefusal). Apple Events never arrive there:
 * with Chrome's JavaScript setting on, chrome_* read and drove the page right
 * through a Stop, and a refused `chrome snapshot --visual` even told the model
 * to take that route instead. So those routes ask first. An app too old to
 * answer is answered as "no brake": the route works as it always did.
 */
async function brakeRefusal(bridge: MacBridge | null): Promise<string | null> {
  if (bridge === null) return null;
  try {
    const ack = await bridge.request<MacBrakeAck>('brake');
    return typeof ack?.refusal === 'string' && ack.refusal !== '' ? ack.refusal : null;
  } catch {
    return null;
  }
}

function errResult(action: string, message: string): AgentToolResult<MacDetails> {
  return textResult(`${action} failed: ${message}`, { action, ok: false, error: message });
}

/* The model quotes its errors back to the user, so an error string is user copy.
 * This one used to name the product's internal codename and an extension the
 * user has never heard of; where it is hosted is a fact for the log, not for the
 * person reading the answer. */
function unavailable(action: string): AgentToolResult<MacDetails> {
  return errResult(action, "Mac control isn't available in this session.");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A MODAL SURFACE THAT WAS NOT THERE WHEN THE INDEX WAS READ.
 *
 * The stale-index path re-snapshots and retries the SAME number, which is right
 * while the app is showing the same surface — the element moved, the tree was
 * rebuilt, the index still means what the model meant. It is wrong the moment a
 * sheet or file picker has opened in between: indices are namespaced per app,
 * not per window, so that number now resolves to whatever the fresh walk
 * assigned it — quite possibly a control in the window BEHIND the dialog. the user's
 * exact complaint is the model clicking through a TextEdit save panel it cannot
 * see, so the retry stops here and hands the dialog over instead.
 */
function dialogOpenedSince(snap: MacSnapshot, previousKey: string): ResolvedDialog | null {
  const dialog = dialogOf(snap);
  if (dialog === null) return null;
  return dialogSignature(dialog) === previousKey ? null : dialog;
}

/** The redirect that replaces a blind retry: name the dialog, say why the act
 * did not run, and hand over the fresh snapshot so the next call lands on it. */
function dialogRedirect(
  tool: string,
  action: string,
  index: number,
  snap: MacSnapshot,
  dialog: ResolvedDialog,
): AgentToolResult<MacDetails> {
  const name = dialogName(snap, dialog);
  return textResult(
    `${tool} did NOT run: index ${index} is stale AND a ${dialog.kind} has opened since — ` +
      `${name}. Acting on that number now would have hit the window BEHIND the ${dialog.kind}. ` +
      `Here is the ${dialog.kind}; act on it by index.\n\n${formatMacSnapshot(snap)}`,
    {
      action,
      ok: false,
      dialog: dialog.title,
      error: `a ${dialog.kind} opened — index ${index} is stale`,
    },
  );
}

/** What the mac set hands Chrome's set (index.ts). */
export interface MacComputerUseHandle {
  /** Remember the app now under control — as this chat's own (its session
   *  entry) and as the last one computer use worked in (the cross-chat file). */
  readonly recordControl: () => void;
}

/** Register every mac_* tool onto `pi`. */
export function registerMacComputerUseTools(
  pi: ExtensionAPI,
  options: MacComputerUseOptions,
): MacComputerUseHandle {
  const cap = options.elementCap ?? DEFAULT_ELEMENT_CAP;
  const consent = options.consent ?? createMacConsentGate();
  const readChromeTabs = options.readChromeTabs ?? chromeTabs;
  /* Undefined until an embedding model is deployed (EmbeddingGemma-300M behind
     a llama.cpp --embedding server is the intended one). Injected rather than
     imported so this package never depends on a model being present. */
  const embedText: Embedder | undefined = options.embedText;

  /**
   * Per-session CONTROLLED-APP state (see ./session-state.ts). Each pi session
   * (main agent or a spawned subagent) has its own extension instance → its own
   * controlled app, whose pid it stamps onto EVERY act. The helper namespaces
   * its index→element map by pid (concurrent sessions driving different apps
   * never resolve each other's indices) and delivers fallback events to that
   * pid only (postToPid — background, no focus steal).
   */
  const session = options.session ?? createMacSessionState();
  const bridge = noticed(options.bridge, session);

  /*
   * THE CONTROLLED APP IS REMEMBERED ACROSS TURNS AND RESTARTS.
   *
   * SEEN (the user, Chrome): "if the model executes mac snapshot without any
   * arguments it gives it the current app that I am using … where it should
   * give the one that it was controlling, the last one that it used." The
   * turn-end handler below used to RELEASE control along with the overlay, so
   * the next message started from nothing and a bare snapshot fell back to
   * whatever was in front — the user's own app. Driving stops at the end of a
   * turn (the cursor and the capture must not outlive the work); knowing which
   * app the work was in does not.
   *
   * And it survives the pi child being restarted (a vision relaunch, a chat
   * reopened): each change of control is appended to the session as a
   * `mac-control` entry and the last one is restored at session start. A pid
   * that has quit since resolves by the name that rides with it.
   */
  const MAC_CONTROL_ENTRY = 'mac-control';
  /*
   * …AND ACROSS CHATS. the user (2026-09-23): "the active application should be
   * persisted better". A new chat started with nothing under control, so its
   * first bare `mac snapshot` fell back to whatever the user had in front —
   * Activity Monitor, in his runs — and the model reported that as where the
   * user was. The last controlled app is kept in one small file, restored by a
   * chat that has no control of its own (while the app still runs, within 12 h),
   * and the look that uses it SAYS it was carried over.
   */
  const LAST_CONTROL_TTL_MS = 12 * 3600_000;
  const writeLastControl = (c: { app: string; pid: number }): void => {
    const file = options.lastControlFile;
    if (file === undefined) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ app: c.app, pid: c.pid, at: Date.now() }));
    } catch {
      /* a convenience; never worth failing an act over */
    }
  };
  const readLastControl = (): { app: string; pid: number } | null => {
    const file = options.lastControlFile;
    if (file === undefined) return null;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as {
        app?: unknown;
        pid?: unknown;
        at?: unknown;
      };
      if (typeof d.app !== 'string' || typeof d.pid !== 'number' || typeof d.at !== 'number') {
        return null;
      }
      if (Date.now() - d.at > LAST_CONTROL_TTL_MS) return null;
      try {
        process.kill(d.pid, 0); // throws when the process is gone (EPERM means alive)
      } catch (err) {
        if ((err as { code?: string }).code !== 'EPERM') return null;
      }
      return { app: d.app, pid: d.pid };
    } catch {
      return null;
    }
  };
  let recordedPid: number | null = null;
  const recordControl = (): void => {
    const c = session.controlled();
    if (c === null) return;
    /* On EVERY use, not only on a change: `at` is when the app was last used,
       which is what the 12 h window means, and another chat may have written
       its own app since — the app this chat is working in is the last one
       again the moment it is used. The session entry stays once per change. */
    writeLastControl(c);
    if (c.pid === recordedPid) return;
    recordedPid = c.pid;
    try {
      pi.appendEntry?.(MAC_CONTROL_ENTRY, {
        app: c.app,
        pid: c.pid,
        ...(c.windowId !== undefined ? { windowId: c.windowId } : {}),
      });
    } catch {
      /* a record is a convenience; the act already happened */
    }
  };
  pi.on?.('session_start', (_event, ctx) => {
    recordedPid = null;
    session.release?.();
    const sm = (ctx as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
    const entries = sm?.getEntries?.() ?? [];
    let last: { app: string; pid: number; windowId?: number } | null = null;
    for (const e of entries) {
      const entry = e as { type?: string; customType?: string; data?: unknown };
      if (entry.type !== 'custom' || entry.customType !== MAC_CONTROL_ENTRY) continue;
      const d = entry.data as { app?: unknown; pid?: unknown; windowId?: unknown } | undefined;
      if (typeof d?.app === 'string' && typeof d?.pid === 'number') {
        last = {
          app: d.app,
          pid: d.pid,
          ...(typeof d.windowId === 'number' ? { windowId: d.windowId } : {}),
        };
      }
    }
    if (last !== null) {
      session.restore?.(last);
      recordedPid = last.pid;
    } else {
      /* NOT recorded as this chat's own until it is used. It was, by setting
         recordedPid here, so the chat never wrote its entry: after a restart
         it read the file again and took whatever another chat had driven since.
         The first look that uses it records it like any other take. */
      const carried = readLastControl();
      if (carried !== null) session.restore?.({ ...carried, carriedOver: true });
    }
  });

  /*
   * END THE DRIVING WHEN THE TURN ENDS — not the control.
   *
   * Nothing was ever telling the app that driving had stopped, so the phantom
   * cursor kept floating over the user's app and the screen capture kept
   * running — indefinitely, long after the model had finished and the user had
   * moved on. A "Thinking…" bubble hovering over an app nobody is driving is
   * the most alarming thing this feature can do, and it costs battery to say it.
   *
   * ONLY THE TURN THAT DROVE. `setDriving` is global — it puts away the one
   * overlay and the one monitor session, and lifts the user's brake — so a turn
   * that touched nothing must not send it. It used to be sent whenever an app
   * was under control, and control can be RESTORED without driving: the app
   * another chat last used, carried into every new session (a subagent, a
   * corp role, a scheduled run) — each of whose turns then ended a live run in
   * another chat and released the Stop its user had pressed.
   */
  pi.on?.('agent_end', () => {
    if (bridge === null || !session.endTurn()) return;
    void bridge.request('setDriving', { driving: false }).catch(() => {
      /* the app may already be gone; nothing to release */
    });
  });

  /**
   * Indices the LAST look put in a window the open dialog is blocking.
   *
   * Per-look data rather than control state, so it lives here beside the
   * session (same lifetime) instead of growing the state machine. Reset by every
   * snapshot, empty whenever nothing can be attributed.
   */
  let blocked: readonly number[] = [];

  /**
   * index → name from the LAST look, so an act can say what it acted on.
   *
   * "your last act: clicked [7]" is a number the model has to go and look up
   * again; "clicked [7] Save" is the fact. The name is already in hand at look
   * time and costs one map, so there is no reason to make the model do the join.
   */
  let names = new Map<number, string>();
  /**
   * The PICTURE the last look was, when it was a `--visual` one — its screen
   * rect and its pixel size. the user (2026-09-23): the visual snapshot "just
   * passes an image back", no text, so the offsets a text snapshot prints are
   * not there to add; a coordinate click right after one is read straight off
   * the picture and translated here. Any other look clears it.
   */
  let visualFrame: { x: number; y: number; w: number; h: number; iw: number; ih: number } | null =
    null;

  /** What an act should be remembered as: `clicked [7] "Save"`. */
  function actOn(verb: string, index: number): string {
    const name = names.get(index);
    return `${verb} [${index}]${name !== undefined && name !== '' ? ` "${name}"` : ''}`;
  }

  /**
   * WHERE A LOOK THAT NAMED NO APP LANDS, AND WHY — decided BEFORE it goes out.
   *
   * Both notes used to be flags set on the side. "The USER has in front" was
   * recomputed by every request, so the automatic re-take of an app with no
   * Accessibility tree — aimed at the pid the first look had just taken —
   * erased it, and the model again called the user's app where the user was.
   * "Carried over" was printed by whichever text look came first and cleared:
   * `mac snapshot "Safari"`, the look after a launch, or a look at some other
   * app long after a `--visual` one had used the carried app without a word.
   */
  function landing(app: string | undefined): MacSnapshotView {
    if (app !== undefined && app !== '') return {};
    const c = session.controlled();
    if (c === null) return { frontmostFallback: true };
    return c.carriedOver === true ? { carriedOver: true } : {};
  }

  /** What the tool layer knows and the snapshot does not — the model's own last
   * act, which the header reads back so it is not re-derived, and where the look
   * landed. */
  function view(landed: MacSnapshotView): MacSnapshotView {
    return { lastAct: session.controlled()?.lastAct, ...landed };
  }

  /** Gate helper: consent + denylist, returns null when allowed. */
  async function gate(
    action: string,
    ctx: ExtensionContext,
    targetApp?: string,
  ): Promise<AgentToolResult<MacDetails> | null> {
    const decision = await consent.ensure(ctx, targetApp);
    if (decision.ok) return null;
    return errResult(action, decision.reason);
  }

  /** A page of the element list: which slice, filtered by what. */
  interface SnapshotPage {
    readonly find?: string;
    readonly from?: number;
  }

  async function snapshot(
    app?: string,
    screenshot?: boolean,
    page: SnapshotPage = {},
  ): Promise<MacSnapshot> {
    if (bridge === null) throw new Error('bridge unavailable');
    // Any look replaces the last picture; a --visual look sets it again after.
    visualFrame = null;
    const params: Record<string, unknown> = {};
    // Explicit app wins; otherwise target the CONTROLLED app (the one the model
    // launched / last snapshotted), falling back to frontmost only before any
    // control exists. The resolved snapshot then takes/refreshes control.
    if (app !== undefined && app !== '') params.app = app;
    else Object.assign(params, session.targetParams());
    if (screenshot === true) params.screenshot = true;
    if (typeof page.find === 'string' && page.find.trim() !== '') params.find = page.find.trim();
    if (typeof page.from === 'number' && page.from > 0) params.from = Math.floor(page.from);
    params.cap = cap;
    const snap = await bridge.request<MacSnapshot>('snapshot', params);
    /* Remember WHICH KIND of app this is. An app with no Accessibility tree can
     * only be driven by coordinates and keystrokes, and the typing rule below
     * has to know that before it refuses.
     *
     * ...and WHICH SURFACE was up. Every look records the modal surface it saw
     * (or '' for none) so a later act can tell "the same dialog I indexed
     * against" from "a dialog that appeared after". Built explicitly rather than
     * spread from the wire shape: the state machine stores a comparable
     * signature, not the helper's dialog object. */
    const dialog = dialogOf(snap);
    session.noteSnapshot({
      app: snap.app,
      pid: snap.pid,
      windowId: snap.windowId,
      visualOnly: isAxOpaque(snap),
      dialogKey: dialogSignature(dialog),
      // Kept so a later coordinate click can be told when it hit nothing.
      elements: snap.elements.map((e) => ({
        index: e.index,
        name: e.name,
        role: e.role,
        ...(e.bbox !== undefined ? { bbox: e.bbox } : {}),
      })),
    });
    recordControl();
    /* A FILTERED OR PAGED LOOK ADDS; A PLAIN ONE REPLACES.
     *
     * `find` and `from` are continuations of one look at one app — the helper
     * merges its own index→element map the same way — so page two must not make
     * page one's knowledge disappear. For names that would mean a click saying
     * `clicked [7]` instead of `clicked [7] "Save"`; for blocked indices it
     * would mean losing the refusal that names the dialog (the helper still
     * refuses, but with less to say). A plain snapshot is a fresh look and
     * replaces both, which is what keeps a stale index stale. */
    const isPage = params.find !== undefined || params.from !== undefined;
    const nowBlocked = blockedIndexes(snap, dialog);
    blocked = isPage ? [...new Set([...blocked, ...nowBlocked])] : nowBlocked;
    if (!isPage) names = new Map();
    for (const el of snap.elements) names.set(el.index, el.name);
    return snap;
  }

  /**
   * Is this index in the window the open dialog is BLOCKING?
   *
   * Returns the dialog when acting on that index would be a silent no-op —
   * macOS drops input to a window under a modal sheet, and "Clicked element [1]"
   * reads exactly like success. Confirms against a FRESH look first, because a
   * dialog dismissed since the last snapshot would otherwise make this refuse a
   * perfectly good index, which is its own dead end.
   */
  async function behindDialog(
    index: number,
  ): Promise<{ dialog: ResolvedDialog; snap: MacSnapshot } | null> {
    if (!blocked.includes(index)) return null;
    const fresh = await snapshot();
    const dialog = dialogOf(fresh);
    if (dialog === null || !blocked.includes(index)) return null;
    return { dialog, snap: fresh };
  }

  /** Refuse an act aimed under an open dialog, naming the way out. */
  function behindDialogResult(
    tool: string,
    action: string,
    index: number,
    { dialog, snap }: { dialog: ResolvedDialog; snap: MacSnapshot },
  ): AgentToolResult<MacDetails> {
    const name = dialogName(snap, dialog);
    return textResult(
      `${tool} did NOT run: [${index}] is in the window BEHIND the open ${name}, ` +
        `which stops accepting input while the ${dialog.kind} is up — acting on it would have ` +
        `done nothing at all. Act on the ${dialog.kind}'s own controls, or close it first ` +
        '(mac_key "escape" cancels, "return" confirms).',
      {
        action,
        ok: false,
        dialog: dialog.title,
        error: `[${index}] is behind the open ${dialog.kind}`,
      },
    );
  }

  /** Stamp the controlled app's pid onto an act so the helper resolves the
   * index in the right namespace AND delivers fallback events to that app only
   * (background). */
  function withTarget(params: Record<string, unknown>): Record<string, unknown> {
    return Object.assign(params, session.targetParams());
  }

  /**
   * The menu bar, through the same verb as everything else.
   *
   * Naming a menu LISTS it and naming an item PRESSES it, so one parameter
   * covers discovery and action: the model can say "Format" to find out what is
   * there without having to know that a separate listing verb exists, and a
   * path it half-remembers still resolves rather than costing a turn.
   */
  async function clickMenu(
    path: string,
    activate: boolean,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<MacDetails>> {
    if (bridge === null) return unavailable('mac_click');
    let ack = await bridge.request<MacMenuAck>('menuClick', withTarget({ path, activate }));
    /*
     * "SHUT DOWN…" IS NOT A CLICK LIKE THE OTHERS.
     *
     * The session consent the user gave once, at the start, was consent to drive
     * an app — not to end their login session or empty their Trash. The helper
     * refuses those outright (Menus.swift) and says so with `destructive`; this
     * is the only door through that fence, and it opens on the user's word in
     * their own UI, not on the model's. No UI (print mode, a subagent) means no
     * door at all.
     */
    if (ack.ok !== true && ack.destructive === true) {
      const item = ack.item ?? path;
      const allowed = ctx.hasUI
        ? await ctx.ui
            .confirm(
              `Let Bobble use "${item}"?`,
              'This ends your session or deletes something you cannot get back. ' +
                'Bobble only does it if you say so here.',
            )
            .catch(() => false)
        : false;
      if (!allowed) {
        return errResult(
          'mac_click',
          `"${item}" was not pressed — it ends the user's session or destroys data, and they ` +
            'have not asked for it. Tell them what you were about to do and let them do it, or ' +
            'find another way to finish the task.',
        );
      }
      ack = await bridge.request<MacMenuAck>(
        'menuClick',
        withTarget({ path, activate, confirmDestructive: true }),
      );
    }
    if (ack.ok !== true) {
      const known =
        ack.menus !== undefined && ack.menus.length > 0
          ? ` This app's menus are: ${ack.menus.join(', ')}.`
          : '';
      return errResult('mac_click', `${ack.error ?? `no menu item matching "${path}"`}${known}`);
    }
    if (ack.listed === true) {
      const items = (ack.items ?? []).map((item: MacMenuEntry) => {
        const marks = [
          item.submenu === true ? '▸' : null,
          item.shortcut !== undefined && item.shortcut !== '' ? item.shortcut : null,
          item.enabled === false ? 'disabled' : null,
        ].filter((m): m is string => m !== null);
        return `  ${item.path}${marks.length > 0 ? `   ${marks.join('  ')}` : ''}`;
      });
      const body =
        items.length > 0
          ? items.join('\n')
          : '  (this menu lists nothing until the app builds it — press its items by full path)';
      return textResult(
        `Menu "${ack.path ?? path}" — pass one of these as \`menu\` to press it. ` +
          `A ▸ marks a submenu you can name to list in turn.\n${body}`,
        { action: 'menu', ok: true, listed: true, path: ack.path ?? path },
      );
    }
    const opened = describeOpened(ack.dialog, ack.opened);
    session.noteAct(`pressed the menu item ${ack.path ?? path}`);
    const how =
      ack.focusBorrowed === true
        ? ` The user's focus was borrowed for that one command and ${
            ack.focusRestored === false ? 'could NOT be handed back' : 'handed straight back'
          }.`
        : ' The menu never opened on screen and the app stayed in the background.';
    return textResult(
      `Pressed menu ${ack.path ?? path}.` +
        (ack.shortcut !== undefined && ack.shortcut !== '' ? ` (${ack.shortcut})` : '') +
        `${how}${opened}`,
      {
        action: 'menu',
        ok: true,
        background: ack.focusBorrowed !== true,
        path: ack.path ?? path,
      },
    );
  }

  // --- mac_snapshot --------------------------------------------------------
  shareTool(pi, {
    name: MAC_SNAPSHOT_TOOL,
    label: 'Mac: Snapshot',
    description:
      'Look at a Mac app: a compact, indexed list of its controls — INCLUDING the ones below the ' +
      'fold, which you can press by [index] without scrolling to them — plus the text it is ' +
      'showing, ' +
      "which you then act on by [index] or at a line's point. Defaults to the app you are " +
      'controlling — and before you control anything, to whatever happens to be in FRONT, which ' +
      'is usually not the app the user meant. MEASURED: a run asked to work in Chrome ' +
      "snapshotted the user's chat app and spent two turns working that out. If the user named " +
      'an app, name it here too, or `mac launch` it first (background, takes no focus).\n' +
      'BIG APPS: only the first 60 controls come back. find:"save" lists just the matching ones ' +
      'and from:60 continues the list — indexes never change, so anything you find is clickable ' +
      'straight away.\n' +
      'DIALOGS: a save panel or file picker belongs to the app that opened it, so it is in this ' +
      'same list, announced first, and driven the same way.\n' +
      'WHAT IT SAYS BACK: read the "Showing:" line — the result, the total, the message in the ' +
      'alert, the error under the field. That is how you check an act worked and how you answer ' +
      'a question the app computed. Snapshot again after acting and read it.\n' +
      'NO ACCESSIBILITY: an app that exposes nothing gets a screenshot of its windows ' +
      'automatically, plus the screen rect it covers — act by x,y then; never ask for the image.',
    promptSnippet: 'See a Mac app (and its dialogs) as an indexed element list',
    parameters: Type.Object({
      app: Type.Optional(
        Type.String({
          description: 'App to snapshot (name or bundle id). Default: the controlled app.',
        }),
      ),
      find: Type.Optional(
        Type.String({
          description:
            'List only controls whose name, role or value contains this (case-insensitive). The ' +
            'way to reach a control on an app too big to list: find:"save" on a 800-control app ' +
            'returns the handful that matter, with their real indexes.',
        }),
      ),
      from: Type.Optional(
        Type.Number({
          description:
            'Start the list at this position instead of the beginning — the truncation line ' +
            'tells you the number to pass to continue. Combines with find.',
        }),
      ),
      like: Type.Optional(
        Type.String({
          description:
            'Search this screen for what you MEAN, not the exact word: ranks everything on it ' +
            'against your phrase and lists the best with their indexes. Use when you do not ' +
            'know the app\'s wording — like:"storage options" finds "Not sure how much storage ' +
            'to get?". `find` is the exact-substring filter; this is the search.',
        }),
      ),
      screenshot: Type.Optional(
        Type.Boolean({
          description:
            'Force a screenshot even when Accessibility answers (heavier). Default false — an ' +
            'app with no AX elements attaches one on its own. The image covers every window the ' +
            'app has open, sheets and dialogs included, and the text gives the screen rect it ' +
            'covers so a point read off it maps onto the screen.',
        }),
      ),
      /* the user (2026-09-15): "add a flag / parameter to the computer use cli tool
         for 'snapshot' that is 'visual' or 'screenshot' or something to force
         visual even on text based control apps." `--visual` used to be a
         resolver alias for --screenshot, so it worked but appeared nowhere in
         the help; now it is its own argument, and the help lists it. */
      visual: Type.Optional(
        Type.Boolean({
          description:
            'Return ONLY a picture of the app — no element list, no text. Use it to SEE: ' +
            'layout, a chart, a canvas, what is drawn. Then click by x,y read straight off ' +
            'that picture (its top-left is 0,0) — mac_click x/y right after a visual look ' +
            'are pixels on it. For indexes, take a plain snapshot.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_snapshot');
      const blocked = await gate('mac_snapshot', ctx, params.app);
      if (blocked !== null) return blocked;
      try {
        /*
         * AN EMPTY AX TREE MUST STILL COME BACK WITH SOMETHING TO ACT ON.
         *
         * Screenshots were opt-in, so an app that exposes nothing to Accessibility
         * answered with a sentence saying so and an instruction to call this same
         * tool again with a flag — the user: it "returns something that just isn't able
         * to do anything ... some useless information about it being AX opaque".
         * A whole turn spent learning the tool could not help.
         *
         * So the first attempt is cheap (no capture), and if AX yields nothing we
         * immediately re-take it WITH the image and hand that back. The floor the user
         * asked for: whatever else fails, a snapshot returns a picture of the
         * window and tells the model to work in coordinates.
         */
        const page = { find: params.find, from: params.from };
        const landed = landing(params.app);
        /*
         * --visual: THE PICTURE AND NOTHING ELSE. the user (2026-09-23): "the
         * snapshot tool should accept a flag that gives a visual snapshot no
         * text, when this flag is here it just passes an image back."
         */
        if (params.visual === true) {
          const snapV = await snapshot(params.app, true, page);
          const shotV = snapV.screenshot;
          const rect = shotV?.rect;
          if (shotV?.base64 === undefined || shotV.base64 === '' || rect === undefined) {
            visualFrame = null;
            return textResult(
              snapV.permissions?.screenRecording === false
                ? 'No picture could be taken: macOS has not granted Bobble Screen Recording (the ' +
                    'user can allow it on the computer-use monitor). Take a plain mac_snapshot ' +
                    'and act by [index].'
                : 'No picture could be taken (the app may have no window on screen). Take a ' +
                    'plain mac_snapshot and act by [index].',
              { action: 'snapshot', ok: false, app: snapV.app, pid: snapV.pid },
            );
          }
          /*
           * THE SIZE OF THE PICTURE THAT WAS SENT. The inline copy is at points;
           * when the helper could not make one it sends the full capture — at
           * backing pixels, twice the points on a Retina display — with that
           * size as width/height. Reading it as points put every click twice as
           * far from the corner as the model aimed.
           */
          const sent = shotV as {
            inlineWidth?: number;
            inlineHeight?: number;
            width?: number;
            height?: number;
          };
          const sizeOf = (...sides: (number | undefined)[]): number | undefined =>
            sides.find((s) => typeof s === 'number' && s > 0);
          visualFrame = {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            iw: sizeOf(sent.inlineWidth, sent.width) ?? rect.w,
            ih: sizeOf(sent.inlineHeight, sent.height) ?? rect.h,
          };
          /*
           * …EXCEPT WHEN NOTHING ELSE SAYS WHOSE PICTURE IT IS. A look that named
           * no app and landed on the user's front app — or on one carried over
           * from another chat — took control of it, and a bare picture never
           * says which app that is: exactly the "the user is on Activity
           * Monitor" misreport the text look's header exists to stop. Those two
           * looks, and only those, keep the header's lines.
           */
          const whose =
            landed.frontmostFallback === true || landed.carriedOver === true
              ? [{ type: 'text' as const, text: whoseLookLines(snapV, landed).join('\n') }]
              : [];
          return {
            content: [
              ...whose,
              { type: 'image', data: shotV.base64, mimeType: shotV.mimeType ?? 'image/jpeg' },
            ],
            details: {
              action: 'snapshot',
              ok: true,
              app: snapV.app,
              pid: snapV.pid,
              window: snapV.window,
              elementCount: snapV.summary.elementCount,
              visualOnly: true,
            },
          };
        }
        visualFrame = null;
        const askedForPicture = params.screenshot === true;
        let snap = await snapshot(params.app, askedForPicture, page);
        if (!askedForPicture && isAxOpaque(snap)) {
          snap = await snapshot(params.app, true, page);
        }
        /*
         * `like` — SEARCH THE PAGE, rather than filter it.
         *
         * the user: "would it be possible to take a really small embedding model and
         * quickly index and search a page ... this should be implemented as an
         * argument/flag on snapshot tools."
         *
         * MEASURED before building it, because the answer turns on size: the
         * largest real snapshot ever recorded here is 7.0 KB and the median 5.3,
         * and ranking a 120-line page takes 69 µs — 0.4% of the time this machine
         * needs to generate ONE token. The DOM is nowhere near heavy enough to be
         * the problem, on any device that can run the model at all.
         *
         * Kept SEPARATE from `find` on purpose. `find` is an exact filter with an
         * invariant this package already tests — a look that filters to nothing
         * must not cost a second round trip or be mistaken for an opaque app — and
         * `like` is a different question ("what on this page is about X"), so it
         * pays for its own extra look only when it is asked for.
         *
         * The scorer is IDF-weighted overlap, no model: see page-search.ts, which
         * also documents what it provably cannot do — synonyms. "checkout" will
         * not find "Add to Bag" by any amount of token overlap, and that is the
         * one case that would justify an embedding model. The seam is shaped so
         * one can replace the scorer when a measured case needs it.
         */
        const like = typeof params.like === 'string' ? params.like.trim() : '';
        let nearMiss = '';
        if (like !== '') {
          const lines: PageLine[] = [
            ...(snap.elements ?? []).map((e) => ({ text: e.name, index: e.index })),
            /* Older helpers send plain strings here, newer ones {text,x,y}. */
            ...(snap.text ?? []).map((t) => ({ text: typeof t === 'string' ? t : t.text })),
          ].filter((l) => l.text.trim() !== '');
          /* BOTH searches, always — the user: "don't let the model choose between
             keyword and semantic, just give the top ~10 of both ordered". The
             model cannot know whether the app spells the thing the way it
             guessed; that is why it is searching. `embedText` is absent until an
             embedding model is deployed, and the keyword half answers alone
             until then — the model's instructions do not change either way. */
          const found = await searchPageBoth(lines, like, { embed: embedText, perKind: 10 });
          const hits = found.hits;
          nearMiss =
            hits.length === 0
              ? `\n\n(nothing on this screen is about "${like}". Read the list without ` +
                'it rather than narrowing again.)'
              : `\n\n(${hits.length} on this screen about "${like}", best first` +
                `${found.semantic === 'used' ? '; · = by meaning, = = both agree' : ''})` +
                `${nearMissNote(like, hits)}\n` +
                hits
                  .map((h) => {
                    const mark = h.kind === 'both' ? '=' : h.kind === 'semantic' ? '·' : ' ';
                    return `${mark}${h.index === undefined ? '   ' : `[${h.index}]`} ${h.text}`;
                  })
                  .join('\n');
        }
        const shot = snap.screenshot;
        const wantImage = askedForPicture || isAxOpaque(snap);
        const hasShot = shot?.base64 !== undefined && shot.base64 !== '';
        /*
         * A PICTURE THAT WAS ASKED FOR AND NOT DELIVERED SAYS WHY, FIRST.
         *
         * `--visual` on a Mac without the Screen Recording grant answered with
         * the ordinary element list and, three lines down, "picture:
         * unavailable (Screen Recording off)" — which reads as the flag doing
         * nothing. MEASURED on the user's own Mac (the installed helper reports
         * screenRecording:false). The reason and the one thing that changes it
         * go at the top: the user's Allow button on the computer-use monitor.
         */
        const noPicture =
          askedForPicture && !hasShot
            ? snap.permissions?.screenRecording === false
              ? 'You asked for a picture and none could be taken: macOS has not granted Bobble ' +
                'Screen Recording. The user can allow it with the "Allow Screen Recording" ' +
                'button on the computer-use monitor (or in System Settings → Privacy & ' +
                'Security → Screen Recording). Until then the controls below are your view — ' +
                'act by [index], and do not ask for the picture again this turn.\n\n'
              : 'You asked for a picture and the capture came back empty (the app may have no ' +
                'window on screen right now). The controls below are your view.\n\n'
            : '';
        const content: AgentToolResult<MacDetails>['content'] = [
          { type: 'text', text: `${noPicture}${formatMacSnapshot(snap, view(landed))}${nearMiss}` },
        ];
        if (wantImage && shot?.base64 !== undefined && shot.base64 !== '') {
          content.push({
            type: 'image',
            data: shot.base64,
            mimeType: shot.mimeType ?? 'image/png',
          });
        }
        const dialog = dialogOf(snap);
        return {
          content,
          details: {
            action: 'snapshot',
            ok: true,
            app: snap.app,
            pid: snap.pid,
            window: snap.window,
            elementCount: snap.summary.elementCount,
            /* Surfaced for the trace/UI as well as the text: "a dialog was open"
             * is the single most useful thing to see when a run went sideways. */
            dialog: dialog?.title,
            visualOnly: isAxOpaque(snap),
          },
        };
      } catch (err) {
        return errResult('mac_snapshot', messageOf(err));
      }
    },
  });

  // --- mac_click -----------------------------------------------------------
  shareTool(pi, {
    name: MAC_CLICK_TOOL,
    label: 'Mac: Click',
    description:
      'Click a control by its [index] from the last mac_snapshot, or by x,y, or press a menu ' +
      'item with menu:"File > New".\n' +
      "BACKGROUND: clicks go through the app's own Accessibility action, so nothing comes to " +
      'the front and the user keeps working.\n' +
      'EXCEPT DOCUMENT COMMANDS. macOS runs Save, Bold, Close and friends only for the ' +
      'frontmost app, so menu:"File > Save" does nothing in the background — pass activate:true ' +
      'and the focus is borrowed for that one command and handed straight back.\n' +
      'DIALOGS: a sheet or file picker is part of the same app and is clicked the same way; a ' +
      'point inside one hits the dialog, never the window behind it.\n' +
      'A stale index re-snapshots and retries once — unless a dialog opened in between, when ' +
      'you get the dialog instead of a click behind it.',
    promptSnippet: 'Click a Mac element by index (or x,y)',
    parameters: Type.Object({
      index: Type.Optional(
        Type.Number({
          description:
            "Element index from the latest mac_snapshot. A dialog's controls are indexed too.",
        }),
      ),
      x: Type.Optional(
        Type.Number({
          description:
            'x for a raw coordinate click; pass with y. Right after a --visual snapshot: pixels ' +
            'on that picture (top-left 0,0). Otherwise screen points, read off a snapshot image ' +
            'using the image bounds the snapshot prints.',
        }),
      ),
      y: Type.Optional(
        Type.Number({ description: 'Screen y (points) for a raw coordinate click; pass with x.' }),
      ),
      menu: Type.Optional(
        Type.String({
          description:
            'A menu-bar path such as "File > New" or "Format > Font > Bold". Names an ITEM to ' +
            "press it; names a MENU to list what is inside. mac_snapshot prints this app's own " +
            'menu titles. Commands that end the session or destroy data (Shut Down, Restart, ' +
            'Log Out, Empty Trash) are refused unless the user asks for them in their own words.',
        }),
      ),
      activate: Type.Optional(
        Type.Boolean({
          description:
            'For `menu` only. Borrow the focus for that one command, then hand it back — the ' +
            'way to run a document command (Save, Bold, Close), which macOS delivers only to ' +
            "the frontmost app. Prefer the app's own on-screen controls when it has them.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_click');
      const blocked = await gate('mac_click', ctx);
      if (blocked !== null) return blocked;
      try {
        if (typeof params.menu === 'string' && params.menu.trim() !== '') {
          return await clickMenu(params.menu.trim(), params.activate === true, ctx);
        }
        if (typeof params.x === 'number' && typeof params.y === 'number') {
          /*
           * RIGHT AFTER A --visual LOOK, x/y ARE PIXELS ON THAT PICTURE — the
           * picture came with no text to say where it sits on screen, so the
           * offset is added here rather than by the model.
           */
          const onPicture = visualFrame;
          const px = params.x;
          const py = params.y;
          if (onPicture !== null) {
            params.x = Math.round(onPicture.x + (px * onPicture.w) / onPicture.iw);
            params.y = Math.round(onPicture.y + (py * onPicture.h) / onPicture.ih);
          }
          /*
           * THE POINT GOES THROUGH UNTOUCHED — no clamping, no nudging toward
           * the controlled window's frame.
           *
           * A sheet or file picker can sit outside its parent window's rect, so
           * "correcting" a coordinate into that rect would send every click at a
           * dialog into the document behind it. The pid stamp is all the aiming
           * this needs: the receiving app hit-tests the point against its OWN
           * windows, dialog included.
           */
          const ack = await bridge.request<MacActAck>(
            'click',
            withTarget({ x: params.x, y: params.y }),
          );
          await sleep(SETTLE_MS);
          session.noteAct(`clicked at (${params.x}, ${params.y})`);
          // A point that hit nothing must not read like a point that worked.
          const miss = session.missAt(params.x, params.y);
          return textResult(
            `Clicked at (${params.x}, ${params.y})${
              onPicture !== null ? ` — (${px}, ${py}) on the picture` : ''
            }.${backgroundNote(ack)}` +
              (miss === null ? '' : `\n\n${miss}`) +
              describeOpened(ack.dialog, ack.opened),
            {
              action: 'click',
              ok: true,
              background: ack.background,
              mode: ack.mode,
            },
          );
        }
        if (typeof params.index !== 'number') {
          const visual = session.controlled();
          if (visual !== null && visual.visualOnly === true) {
            return errResult(
              'mac_click',
              `"${visual.app}" exposes no Accessibility elements, so it has no indexes — pass x ` +
                'and y (screen points read off the snapshot image) instead.',
            );
          }
          return errResult('mac_click', 'provide an element index, or x and y');
        }
        const index = params.index;
        const under = await behindDialog(index);
        if (under !== null) return behindDialogResult('mac_click', 'click', index, under);
        const knownDialog = session.controlled()?.dialogKey ?? '';
        let res = await bridge.request<MacActAck>('click', withTarget({ index }));
        if (!res.found) {
          const fresh = await snapshot();
          const opened = dialogOpenedSince(fresh, knownDialog);
          if (opened !== null) return dialogRedirect('mac_click', 'click', index, fresh, opened);
          res = await bridge.request<MacActAck>('click', withTarget({ index }));
          if (!res.found) {
            const now = session.controlled();
            if (now !== null && now.visualOnly === true) {
              return errResult(
                'mac_click',
                `index ${index} does not exist: "${now.app}" exposes no Accessibility elements, ` +
                  'so there are no indexes at all. Snapshot it and click by x,y instead.',
              );
            }
            return errResult(
              'mac_click',
              `index ${index} not found — call mac_snapshot for current indices`,
            );
          }
        }
        await sleep(SETTLE_MS);
        session.noteAct(actOn('clicked', index));
        return textResult(
          `Clicked element [${index}].${backgroundNote(res)}` +
            `${describeOpened(res.dialog, res.opened)} Re-snapshot to see the result.`,
          { action: 'click', ok: true, background: res.background, mode: res.mode },
        );
      } catch (err) {
        return errResult('mac_click', messageOf(err));
      }
    },
  });

  // --- mac_type ------------------------------------------------------------
  shareTool(pi, {
    name: MAC_TYPE_TOOL,
    label: 'Mac: Type',
    description:
      'Put text into a field by its [index] from the last mac_snapshot — including a save ' +
      "sheet's or file picker's fields, which belong to the same app.\n" +
      "BACKGROUND: the field's Accessibility value is set directly — no focus change, no " +
      'keystrokes, nothing for the user to see. Fields that refuse a value set get keystrokes ' +
      'delivered to that app alone, still in the background.\n' +
      'NO INDEX: only for an app that exposes nothing to Accessibility. It then types into ' +
      'whatever has focus INSIDE the controlled app — still background. But with no app under ' +
      'control there is no app to aim at, and the keystrokes follow the SYSTEM focus into ' +
      'whatever the user is doing: snapshot or launch something first.\n' +
      'submit:true commits a search/URL/filename field; append:true adds instead of replacing.',
    promptSnippet: 'Set text into a Mac field (background) + optional submit',
    parameters: Type.Object({
      text: Type.String({ description: 'Text to set/type.' }),
      index: Type.Optional(
        Type.Number({
          description:
            "Field index from the latest mac_snapshot (a dialog's fields are indexed too). Omit " +
            "only for an app with no Accessibility elements — then it types into that app's " +
            'focused field.',
        }),
      ),
      submit: Type.Optional(
        Type.Boolean({
          description:
            "Commit the field after typing (search / URL / a save sheet's filename). Default " +
            'false.',
        }),
      ),
      append: Type.Optional(
        Type.Boolean({
          description: 'Append via keystrokes instead of replacing the value. Default false.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_type');
      const blocked = await gate('mac_type', ctx);
      if (blocked !== null) return blocked;
      try {
        const text = params.text;
        const submit = params.submit === true;
        const append = params.append === true;
        if (typeof params.index !== 'number') {
          // SAFETY: index-less typing is FOREGROUND keystrokes into whatever holds
          // the SYSTEM focus — if we're driving a specific (likely non-frontmost)
          // app, that lands in the USER's active app, not the target. Once an app
          // is controlled, refuse and steer the model to the background
          // AX-by-index path. (Focused typing is only allowed before any control
          // exists, i.e. genuine "type into the frontmost field" use.)
          /*
           * THE REFUSAL ONLY MAKES SENSE WHEN THERE IS SOMETHING ELSE TO DO.
           *
           * Index-less typing sends keystrokes to whatever holds the SYSTEM
           * focus, so while driving a background app it would land in the
           * user's own window. That is worth refusing — but only when the model
           * has an alternative, and it only has one when the app answers
           * Accessibility. An app with no AX tree has no indices to pass, so
           * the old refusal told it to "pass the field's [index]" for a thing
           * that has none: snapshot says act by coordinates, type says pass an
           * index, and the turn dead-ends between them.
           *
           * the user: "if an app is not visually controllable, mac snapshot just
           * returns … a screenshot and a 'this app must be controlled visually'
           * type needs to just type into active field."
           *
           * So for a visual-only app it types — after bringing the app forward,
           * because keystrokes follow the system focus and there is no
           * background path for an app that exposes nothing.
           *
           * AND IT NEVER REFUSES ON AN UNKNOWN. `visualOnly` is recorded by a
           * LOOK, and mac_launch takes control without one (its post-launch
           * snapshot can fail), so the flag can be genuinely undefined — the
           * exact state in which the old test `visualOnly !== true` refused, and
           * told a model with no indices to go and pass an index. If we do not
           * know which kind of app this is, find out; if we cannot find out, act
           * rather than dead-end (the keystrokes are pid-stamped, so they go to
           * the controlled app's own queue, not to the user's window).
           */
          const controlled = session.controlled();
          if (controlled !== null && controlled.visualOnly === undefined) {
            try {
              await snapshot();
            } catch {
              /* Could not look — do not refuse on an unknown. */
            }
          }
          if (session.controlled()?.visualOnly === false) {
            return errResult(
              'mac_type',
              'refusing to type without an index after snapshotting an app: index-less typing ' +
                'sends keystrokes to whatever holds focus in it, not necessarily the field you ' +
                "mean. Call mac_snapshot and pass the field's [index] — including a dialog's " +
                'field — so the text is set via Accessibility in the background.',
            );
          }

          /*
           * STAMPED WITH THE TARGET, so this stays in the background.
           *
           * `postToPid` puts keystrokes in one process's own event queue, so a
           * named app is typed into wherever ITS key window has focus while the
           * user keeps working in theirs. Without the pid the helper falls back
           * to the SYSTEM focus, which is the whole reason index-less typing
           * was dangerous — and the reason it was refused rather than aimed.
           */
          const ack = await bridge.request<MacActAck>('type', withTarget({ text, submit }));
          await sleep(SETTLE_MS);
          const target = session.controlled(); // may have been resolved just above
          const where =
            target !== null
              ? `Typed into ${target.app || 'the app'} — it exposes no Accessibility elements, ` +
                `so this went to its focused field as keystrokes.${backgroundNote(ack)} ` +
                'Snapshot again to see the result.'
              : `Typed into the focused field.${backgroundNote(ack)}`;
          session.noteAct('typed into the focused field');
          return textResult(where, {
            action: 'type',
            ok: true,
            background: ack.background,
            mode: ack.mode,
          });
        }
        const index = params.index;
        const under = await behindDialog(index);
        if (under !== null) return behindDialogResult('mac_type', 'type', index, under);
        const knownDialog = session.controlled()?.dialogKey ?? '';
        const body = (): Record<string, unknown> => withTarget({ index, text, submit, append });
        let res = await bridge.request<MacActAck>('type', body());
        if (!res.found) {
          const fresh = await snapshot();
          const opened = dialogOpenedSince(fresh, knownDialog);
          if (opened !== null) return dialogRedirect('mac_type', 'type', index, fresh, opened);
          res = await bridge.request<MacActAck>('type', body());
          if (!res.found) {
            return errResult(
              'mac_type',
              `index ${index} is not a settable/focusable field — call mac_snapshot`,
            );
          }
        }
        await sleep(SETTLE_MS);
        session.noteAct(actOn('typed into', index));
        const submitted = res.submitted === true ? ' Submitted.' : '';
        return textResult(
          `Set text into [${index}].${backgroundNote(res)}${submitted} Re-snapshot to see the result.`,
          { action: 'type', ok: true, background: res.background, mode: res.mode },
        );
      } catch (err) {
        return errResult('mac_type', messageOf(err));
      }
    },
  });

  // --- mac_key -------------------------------------------------------------
  shareTool(pi, {
    name: MAC_KEY_TOOL,
    label: 'Mac: Key',
    description:
      'Press a key combo, e.g. "cmd+s", "cmd+shift+z", "return", "tab", "escape", "down". ' +
      'While you are controlling an app the chord is DELIVERED to that app in the background ' +
      "(the user's focus is untouched). Use for menu shortcuts, saving, dialogs, and navigation. " +
      'It lands in the key window of the app, which IS the dialog while one is open — "return" ' +
      'confirms a save sheet, "escape" cancels it, "tab" moves between its fields. This works ' +
      'even for an app that exposes nothing to Accessibility.',
    promptSnippet: 'Press a Mac key combo (e.g. cmd+s)',
    parameters: Type.Object({
      combo: Type.String({
        description:
          "Key combo, e.g. cmd+s, cmd+shift+z, return, tab, escape. Goes to the app's key " +
          'window — the open dialog, when there is one.',
      }),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_key');
      const blocked = await gate('mac_key', ctx);
      if (blocked !== null) return blocked;
      try {
        const ack = await bridge.request<MacActAck & { ok: boolean }>(
          'key',
          withTarget({ combo: params.combo }),
        );
        await sleep(SETTLE_MS);
        const note =
          ack.tookFocus === true
            ? backgroundNote(ack)
            : ack.background === true
              ? ' (delivered to the controlled app, no focus change)'
              : '';
        session.noteAct(`pressed ${params.combo}`);
        return textResult(`Pressed ${params.combo}.${note}`, {
          action: 'key',
          ok: true,
          background: ack.background,
        });
      } catch (err) {
        return errResult('mac_key', messageOf(err));
      }
    },
  });

  // --- mac_tabs / mac_tab ---------------------------------------------------
  /*
   * THE WINDOW AROUND THE PAGE.
   *
   * the user: "for chrome, we need tab handling so it can read open tabs, switch
   * tab, make new tab and close tab — the dom wouldn't let it drive that, or for
   * example profiles, settings, top bar." He is right about the DOM: a page's
   * JavaScript can see its own document and nothing about the browser holding
   * it. The tab strip is in the ACCESSIBILITY tree though, as an ordinary
   * AXTabGroup — so this needs no Chrome setting, no Apple Events, and works the
   * same in Safari and other Chromium browsers.
   */
  shareTool(pi, {
    name: CHROME_TABS_TOOL,
    label: 'Chrome: Tabs',
    description:
      "List a browser's open tabs — their titles and which one is in front. Works on the user's " +
      'own Chrome, Safari or any Chromium browser, reads the window rather than the page, and ' +
      'needs no browser setting. Switch between them with mac_tab.\n' +
      'BACKGROUND: listing and switching change nothing about what the user is looking at.',
    promptSnippet: "List a browser's open tabs",
    parameters: Type.Object({
      app: Type.Optional(
        Type.String({ description: 'Browser to read. Defaults to the app being controlled.' }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('chrome_tabs');
      /* Asked about the browser it READS — Chrome, unless another is named. A
         gate that named nothing let any earlier grant (TextEdit's, say) cover
         reading every Chrome tab's title and URL over Apple Events. */
      const blocked = await gate('chrome_tabs', ctx, params.app ?? CHROME_APP);
      if (blocked !== null) return blocked;
      try {
        /*
         * APPLE EVENTS FIRST, and it needs no setting.
         *
         * the user: "for chrome possible without asking the user to download an
         * extension, that's not an option." MEASURED against a Chrome with
         * AllowJavaScriptAppleEvents OFF: `count of tabs`, `title of tab` and
         * `URL of tab` all answer — that flag only ever gated `execute
         * javascript`, and this file's own header assumed otherwise, which is
         * what hid the route. It knows the URLs and sees EVERY window; the
         * Accessibility tab strip below knows neither, so it is the fallback.
         */
        const wanted = params.app ?? CHROME_APP;
        if (/chrome/i.test(wanted)) {
          const braked = await brakeRefusal(bridge);
          if (braked !== null) return errResult('chrome_tabs', braked);
          const viaEvents = await readChromeTabs();
          if (viaEvents !== null) {
            return textResult(formatChromeTabs(viaEvents), {
              action: 'tabs',
              ok: true,
              app: CHROME_APP,
              mode: 'apple-events',
            });
          }
        }
        const res = await bridge.request<MacTabsAck>('tabs', withTarget(appParam(params.app)));
        if (res.ok !== true) {
          return errResult('chrome_tabs', res.error ?? 'no tab strip in that window.');
        }
        return textResult(formatTabs(res), { action: 'tabs', ok: true, app: res.app });
      } catch (err) {
        return errResult('chrome_tabs', messageOf(err));
      }
    },
  });

  shareTool(pi, {
    name: CHROME_TAB_TOOL,
    label: 'Chrome: Tab',
    description:
      'Switch to, open or close a browser tab. `index` is from mac_tabs.\n' +
      'SWITCHING is background — the user keeps whatever they are looking at.\n' +
      'OPENING and CLOSING are NOT: a browser brings itself to the front when it opens a tab, ' +
      'and closing one is a document command that macOS runs only for the frontmost app. ' +
      'Neither can be undone from the background, so do them when the user is not mid-sentence, ' +
      'and prefer switching where switching will do.',
    promptSnippet: 'Switch, open or close a browser tab',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('select'), Type.Literal('new'), Type.Literal('close')], {
        description: 'select (background) · new · close (both take the screen).',
      }),
      index: Type.Optional(
        Type.Number({ description: 'Tab number from mac_tabs. Required for select and close.' }),
      ),
      app: Type.Optional(
        Type.String({ description: 'Browser to act on. Defaults to the app being controlled.' }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('chrome_tab');
      const blocked = await gate('chrome_tab', ctx);
      if (blocked !== null) return blocked;
      const verb =
        params.action === 'new' ? 'tabNew' : params.action === 'close' ? 'tabClose' : 'tabSelect';
      try {
        const res = await bridge.request<MacTabsAck>(
          verb,
          withTarget({
            ...appParam(params.app),
            ...(params.index === undefined ? {} : { index: params.index }),
          }),
        );
        if (res.ok !== true) return errResult('chrome_tab', res.error ?? 'that did not work.');
        session.noteAct(`${params.action} tab`);
        const did =
          params.action === 'select'
            ? `Switched to ${JSON.stringify(res.selected ?? '')}.`
            : params.action === 'close'
              ? `Closed ${JSON.stringify(res.closed ?? '')}.`
              : 'Opened a new tab.';
        const note = res.note === undefined ? '' : `\n${res.note}`;
        return textResult(`${did}${note}\n\n${formatTabs(res)}`, {
          action: `tab:${params.action}`,
          ok: true,
          app: res.app,
          background: res.tookFocus !== true,
        });
      } catch (err) {
        return errResult('chrome_tab', messageOf(err));
      }
    },
  });

  // --- mac_scroll ----------------------------------------------------------
  /* Scrolling is for SEEING, not for reaching: every control on the page is in
     the snapshot already, wherever it sits. See the note in mac_snapshot. */
  shareTool(pi, {
    name: MAC_SCROLL_TOOL,
    label: 'Mac: Scroll',
    description:
      "Scroll the controlled app's window (delivered in the background — the window scrolls " +
      'without coming to the front), then re-snapshot to reveal off-screen elements.',
    promptSnippet: 'Scroll a Mac app',
    parameters: Type.Object({
      direction: Type.Union(
        [Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')],
        /* The allowed values are SPELLED OUT: a union of literals renders as
         * `anyOf`, which the CLI help has no enum line for, so a `--help` that
         * only said "Scroll direction" left the model to guess the four words. */
        { description: 'Scroll direction: up, down, left or right.' },
      ),
      amount: Type.Optional(
        Type.Number({
          /* MEASURED in a run: a model asked for `scroll down 10` meaning ten
             notches of a wheel, got ten PIXELS, saw nothing move, and concluded
             the page had no more content. Saying what a screenful is costs one
             clause and removes the whole misreading. */
          description:
            'How far, in PIXELS — not wheel clicks (default ~300; a screenful is roughly 800).',
          /* the user: "controlling through dom shouldn't need scroll right? ...
             scrolling should only be necessary if using visually." Right: a
             snapshot lists what is below the fold and `find` reaches it, so
             scrolling is for LOOKING, not for acting. */
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_scroll');
      const blocked = await gate('mac_scroll', ctx);
      if (blocked !== null) return blocked;
      try {
        // Resolve the signed pixel delta here (pure + unit-tested) and hand the
        // helper explicit dx/dy — a meaningful magnitude the stepped background
        // scroll can't swallow. direction/amount ride along for logging + as the
        // helper's legacy fallback.
        const { dx, dy } = scrollDelta(params.direction, params.amount);
        const ack = await bridge.request<{
          ok: boolean;
          background?: boolean;
          mode?: string;
          moved?: boolean;
          coveredByOtherWindows?: boolean;
        }>('scroll', withTarget({ direction: params.direction, amount: params.amount, dx, dy }));
        // The helper VERIFIES movement against the scroll area's AX scroll bar
        // when one exists (climbing a pixel-burst→gesture→line→AX ladder) —
        // surface an honest "nothing moved" so the model reacts instead of
        // assuming (the user's field report was exactly a silent no-op).
        if (ack.moved === false) {
          return textResult(
            `Scroll ${params.direction} had NO effect (content did not move${
              ack.coveredByOtherWindows === true
                ? '; the window is fully covered by other windows'
                : ''
            }). The view may already be at its end, or this area is not scrollable — ` +
              'mac_snapshot to re-check.',
            {
              action: 'scroll',
              ok: true,
              background: ack.background,
              mode: ack.mode,
              moved: false,
            },
          );
        }
        session.noteAct(`scrolled ${params.direction}`);
        return textResult(`Scrolled ${params.direction}. Re-snapshot to see new elements.`, {
          action: 'scroll',
          ok: true,
          background: ack.background,
          mode: ack.mode,
          moved: ack.moved,
        });
      } catch (err) {
        return errResult('mac_scroll', messageOf(err));
      }
    },
  });

  // --- mac_launch ----------------------------------------------------------
  shareTool(pi, {
    name: MAC_LAUNCH_TOOL,
    label: 'Mac: Launch',
    description:
      'Open a Mac app IN THE BACKGROUND and take control of it. The app never steals focus — ' +
      'the user keeps whatever they are doing. The result IMMEDIATELY includes a fresh indexed ' +
      "element snapshot AND a screenshot of the app's window, so you can see exactly what it " +
      'looks like and act in the same turn (no separate mac_snapshot needed). The launched app ' +
      'becomes your CONTROLLED target: every mac_click/mac_type/mac_key/mac_scroll routes to it ' +
      'until you launch or snapshot a different app. Set foreground:true only if the user ' +
      'explicitly asked to bring it to the front.',
    promptSnippet: 'Open a Mac app in the background + see it immediately',
    parameters: Type.Object({
      app: Type.String({ description: 'App name to launch/focus, e.g. "TextEdit".' }),
      foreground: Type.Optional(
        Type.Boolean({ description: 'Bring the app to the front (steals focus). Default false.' }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_launch');
      const blocked = await gate('mac_launch', ctx, params.app);
      if (blocked !== null) return blocked;
      try {
        const background = params.foreground !== true;
        const ack = await bridge.request<MacLaunchAck>('launch', {
          app: params.app,
          background,
        });
        if (!ack.ok) {
          return errResult('mac_launch', ack.error ?? `could not launch "${params.app}"`);
        }
        // The bridge has already waited for the app's window to exist and
        // resolved its pid — record CONTROL so every subsequent act routes to
        // this app unambiguously.
        if (typeof ack.pid === 'number') {
          session.noteLaunched(ack.app ?? params.app, ack.pid, ack.bounds?.windowId);
          recordControl();
        }
        await sleep(SETTLE_MS);

        // SNAPSHOT-AFTER-OPEN CONTRACT: the model must immediately SEE the app
        // it now controls — indexed elements + a window screenshot in THIS tool
        // result, not a separate call it may forget to make.
        let snapText: string;
        let shot: MacSnapshot['screenshot'];
        try {
          const snap =
            typeof ack.pid === 'number'
              ? await snapshot(undefined, true) // targets the controlled pid
              : await snapshot(params.app, true);
          snapText = formatMacSnapshot(snap);
          shot = snap.screenshot;
        } catch (err) {
          snapText = `(snapshot after launch failed: ${messageOf(err)} — call mac_snapshot)`;
        }

        const where = background
          ? 'in the background — it did NOT take focus; the user keeps their current app'
          : 'to the front';
        const control = session.describe();
        const hasImage = shot?.base64 !== undefined && shot.base64 !== '';
        const shotNote = hasImage
          ? 'Its window screenshot is attached below.'
          : '(window screenshot unavailable — Screen Recording may not be granted; act via the element list.)';
        const content: AgentToolResult<MacDetails>['content'] = [
          {
            type: 'text',
            text:
              /*
               * `mac_*` is a GLOB, so nothing that renames tool names for CLI
               * mode can match it — the sentence shipped intact into a mode
               * where those names do not exist. Name the real tools instead,
               * and they get renamed with everything else.
               */
              `Launched ${ack.app ?? params.app} ${where}. ${control} ` +
              `mac_snapshot, mac_click, mac_type and mac_key all target it now — ` +
              `you do not have to name it again. ${shotNote}\n\n${snapText}`,
          },
        ];
        if (hasImage && shot !== undefined) {
          content.push({
            type: 'image',
            data: shot.base64 ?? '',
            mimeType: shot.mimeType ?? 'image/png',
          });
        }
        return {
          content,
          details: {
            action: 'launch',
            ok: true,
            app: ack.app ?? params.app,
            pid: ack.pid,
            background,
            controlled: session.controlled() !== null,
            snapshot: true,
            screenshot: hasImage,
          },
        };
      } catch (err) {
        return errResult('mac_launch', messageOf(err));
      }
    },
  });

  return { recordControl };
}

/** Probe the TCC grant status through the bridge (drives the capabilities UI). */
export async function checkMacTcc(bridge: MacBridge): Promise<MacTccStatus> {
  return bridge.request<MacTccStatus>('check');
}

/**
 * Register the Chrome DOM tools.
 *
 * Separate from the mac_* registration because they are a different KIND of
 * control: real elements instead of coordinates, in the user's own Chrome with
 * their sessions and logins. Computer use sees Chrome as one opaque rectangle;
 * this sees the page.
 *
 * The `defaults write` that unlocks it is a change to ANOTHER app's preferences,
 * so it is never made silently — the same confirm the Mac-control gate uses asks
 * first, and a refusal is reported honestly rather than retried.
 */
/** The user's own Chrome, by the name macOS knows it by. */
const CHROME_APP = 'Google Chrome';

export function registerChromeTools(
  pi: ExtensionAPI,
  appBridge: MacBridge | null = null,
  options: {
    readonly isChromeRunning?: () => Promise<boolean>;
    /** The mac set's controlled-app state — shared, so Chrome work is remembered. */
    readonly session?: MacSessionState;
    /** The mac set's recorder (MacComputerUseHandle), so Chrome taking control
     *  survives a restart and reaches the next chat like any other take. */
    readonly recordControl?: () => void;
    /** The mac set's consent + policy gate, for the one command that captures
     *  the screen the way mac_snapshot does (`--visual`). */
    readonly consent?: MacConsentGate;
    /** Chrome's pid (test seam; default pgrep). */
    readonly chromePid?: () => Promise<number | null>;
    /*
     * The Apple-Events route (test seams; defaults read Chrome's setting, write
     * it, and run osascript). A unit test must never script — or change the
     * preferences of — the Chrome of the machine running it.
     */
    readonly chromeJsAllowed?: () => Promise<boolean>;
    readonly enableChromeJs?: () => Promise<{ ok: boolean; stderr: string }>;
    readonly chromeEval?: (js: string) => Promise<{ ok: boolean; value: string; error?: string }>;
  } = {},
): void {
  // Chrome's own commands drive through the helper too (ax below), so the turn
  // that used them is the turn that ends the driving.
  const bridge = noticed(appBridge, options.session);
  const consent = options.consent ?? createMacConsentGate();
  let askedThisSession = false;
  const isChromeRunning = options.isChromeRunning ?? chromeRunning;
  const pidOfChrome = options.chromePid ?? chromePid;
  const jsAllowed = options.chromeJsAllowed ?? chromeJsAllowed;
  const enableJs = options.enableChromeJs ?? enableChromeJs;
  const evalJs = options.chromeEval ?? chromeEval;
  /**
   * WORK IN CHROME LEAVES CHROME UNDER CONTROL. The chrome_* commands used to
   * touch no state at all, so after a run of them a bare `mac snapshot` found
   * nothing controlled and fell back to whatever the user had in front — the user
   * (2026-09-23): the model "at times randomly say[s] 'the user is on activity
   * monitor'". One shared state, taken on whichever route did the work (a
   * default Chrome answers through Accessibility, never through Apple Events),
   * and recorded like any other take, so a restarted chat comes back to Chrome.
   *
   * BUT NEVER OVER AN APP THE MODEL CHOSE. It did, on every chrome_* call: after
   * `mac launch TextEdit` — whose answer says mac_key and mac_type target
   * TextEdit now — one `chrome snapshot` moved the target, so `mac key cmd+s`
   * opened Chrome's Save Page dialog and a typed note went into a web form, and
   * nothing said control had moved. Chrome fills a gap (nothing under control)
   * or replaces a guess (an app carried over from another chat, never looked at
   * here); a chosen app stays the target until the model moves it.
   */
  const noteChrome = async (): Promise<void> => {
    const session = options.session;
    if (session === undefined) return;
    const c = session.controlled();
    if (c !== null && c.carriedOver !== true && c.app !== CHROME_APP) return;
    if (c === null || c.carriedOver === true) {
      const pid = await pidOfChrome().catch(() => null);
      if (pid === null) return;
      session.restore({ app: CHROME_APP, pid });
    }
    options.recordControl?.();
  };

  /**
   * THE ROUTE THAT ACTUALLY WORKS.
   *
   * Apple Events gives the real DOM and is better when it is available. It
   * usually is not: the Chrome setting behind it is off by default and only the
   * user can turn it on, so MEASURED across every demo run, `chrome snapshot`
   * came back "Chrome is refusing JavaScript from Apple Events" and the model
   * spent a turn discovering that its own connector could not read a page.
   *
   * Accessibility can read the same page — its text with a click point per
   * line, and every control including the ones below the fold — so when the DOM
   * is shut, these fall through to it rather than failing. The tools stay one
   * set, which is what the user asked for: "have chrome be its own set".
   */
  async function ax<T>(method: MacAgentMethod, params: Record<string, unknown>): Promise<T | null> {
    if (bridge === null) return null;
    try {
      return await bridge.request<T>(method, { app: CHROME_APP, ...params });
    } catch {
      return null;
    }
  }

  /**
   * THE GATE EVERY MAC ACT PASSES, NAMING CHROME — before either route.
   *
   * These commands had none: with computer use switched off in Settings, or
   * Chrome not among the apps allowed without asking (and no one to ask — a
   * subagent, a scheduled run), a click, a typed value or a navigation still
   * went into the user's logged-in Chrome, over Apple Events or through the
   * Accessibility fallback alike. Returns what to tell the model, or null.
   */
  async function chromeGate(tool: string, ctx: ExtensionContext): Promise<string | null> {
    const decision = await consent.ensure(ctx, CHROME_APP);
    return decision.ok ? null : `${tool} failed: ${decision.reason}`;
  }
  const said = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: undefined,
  });

  /** Make sure Chrome will run our JavaScript, asking the user once if not. */
  async function ensureChromeJs(ctx: ExtensionContext): Promise<string | null> {
    if (await jsAllowed()) return null;
    if (ctx.hasUI !== true) {
      return (
        'Chrome will not run JavaScript from Apple Events yet, and there is no UI here to ' +
        'ask for permission to enable it.'
      );
    }
    if (askedThisSession) {
      return 'Chrome scripting was not enabled — the user declined earlier this session.';
    }
    askedThisSession = true;
    const ok = await ctx.ui.confirm(
      'Let Bobble use your Chrome?',
      'To read and click pages in YOUR Chrome (with your logins), Chrome has to allow ' +
        'JavaScript from Apple Events. This changes one Chrome setting — the same one under ' +
        'View → Developer → Allow JavaScript from Apple Events — and Chrome must be restarted ' +
        'for it to take effect. Nothing else about Chrome is changed.',
    );
    if (!ok) return 'The user declined to enable Chrome scripting.';
    const res = await enableJs();
    if (!res.ok) return `Could not change the Chrome setting: ${res.stderr}`;
    return (
      'ENABLED — but Chrome must be RESTARTED before it takes effect. Tell the user to quit ' +
      'and reopen Chrome, then try again.'
    );
  }

  /**
   * Chrome, running — launched in the background through the bridge when it
   * is not, never by AppleScript addressing it (which brings it to the front
   * and leaves it there). Returns what to tell the model when Chrome came up
   * without a window to act on (its profile picker), else null.
   */
  async function ensureChromeRunning(): Promise<string | null> {
    if (await isChromeRunning()) return null;
    const ack = await ax<MacLaunchAck>('launch', { app: CHROME_APP, background: true });
    if (ack === null || !ack.ok) {
      return `Chrome is not running and could not be launched${ack?.error ? `: ${ack.error}` : ''}.`;
    }
    if (ack.bounds === undefined) {
      return (
        'Chrome was launched in the background but has no window yet — it is showing its ' +
        'profile picker. `mac snapshot "Google Chrome"` lists the picker\'s profile buttons; ' +
        'click one with `mac click`, then try again. Or use the built-in browser ' +
        '(`browser navigate`), which needs none of this.'
      );
    }
    return null;
  }

  /** Shared: gate, evaluate, and turn a failure into something actionable. */
  async function evalInChrome(
    ctx: ExtensionContext,
    js: string,
  ): Promise<{ text: string; ok: boolean }> {
    const braked = await brakeRefusal(bridge);
    if (braked !== null) return { text: braked, ok: false };
    const blocked = await ensureChromeJs(ctx);
    if (blocked !== null) return { text: blocked, ok: false };
    const notUp = await ensureChromeRunning();
    if (notUp !== null) return { text: notUp, ok: false };
    const res = await evalJs(js);
    if (!res.ok) return { text: res.error ?? 'Chrome did not respond.', ok: false };
    await noteChrome();
    return { text: res.value, ok: true };
  }

  shareTool(pi, {
    name: CHROME_SNAPSHOT_TOOL,
    label: 'Chrome: Snapshot',
    description:
      "Read the page in the user's own Google Chrome — its URL, title, and an INDEXED list of " +
      'the interactive elements actually visible on it. This reads the real DOM, so prefer it ' +
      'over computer-use screenshots whenever the work is in Chrome. Act on what it lists with ' +
      'chrome_click / chrome_type by [index].',
    promptSnippet: "See the page in the user's Chrome as an indexed element list",
    parameters: Type.Object({
      find: Type.Optional(
        Type.String({
          description:
            'Only what matches this word — searches the controls AND the page text, including ' +
            'what is below the fold, so you can reach a control without scrolling to it.',
        }),
      ),
      visual: Type.Optional(
        Type.Boolean({
          description:
            "Return ONLY a picture of Chrome's window — no element list, no text. Use it to " +
            'SEE the page; take a plain snapshot for indexes to click.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx) {
      /*
       * --visual: THE PICTURE AND NOTHING ELSE (the user 2026-09-23). Taken of the
       * window through Accessibility's capture, which needs no Chrome setting —
       * and only once Chrome is up, so looking never launches it in front.
       */
      const refused = await chromeGate('chrome_snapshot', ctx);
      if (refused !== null) return said(refused);
      if (params.visual === true) {
        /*
         * THE GATE (above) AND THE BRAKE mac_snapshot --visual answers to — it is
         * the same capture of the user's logged-in window. It had neither: it took
         * the picture with computer use switched off in Settings or Chrome never
         * allowed, and it swallowed the brake's refusal into "take a plain chrome
         * snapshot instead" — the one route the brake could not see.
         */
        const braked = await brakeRefusal(bridge);
        if (braked !== null) {
          const text = `chrome_snapshot failed: ${braked}`;
          return { content: [{ type: 'text', text }], details: undefined };
        }
        const notUp = await ensureChromeRunning();
        if (notUp !== null) return { content: [{ type: 'text', text: notUp }], details: undefined };
        let snap: MacSnapshot | null = null;
        try {
          snap =
            bridge === null
              ? null
              : await bridge.request<MacSnapshot>('snapshot', {
                  app: CHROME_APP,
                  screenshot: true,
                });
        } catch (err) {
          const text = `chrome_snapshot failed: ${messageOf(err)}`;
          return { content: [{ type: 'text', text }], details: undefined };
        }
        const shot = snap?.screenshot;
        if (shot?.base64 === undefined || shot.base64 === '') {
          return {
            content: [
              {
                type: 'text',
                text:
                  snap?.permissions?.screenRecording === false
                    ? 'No picture could be taken: macOS has not granted Bobble Screen Recording ' +
                      '(the user can allow it on the computer-use monitor). Take a plain chrome ' +
                      'snapshot instead.'
                    : 'No picture could be taken of Chrome right now. Take a plain chrome ' +
                      'snapshot instead.',
              },
            ],
            details: undefined,
          };
        }
        await noteChrome();
        return {
          content: [{ type: 'image', data: shot.base64, mimeType: shot.mimeType ?? 'image/jpeg' }],
          details: undefined,
        };
      }
      const out = await evalInChrome(ctx, CHROME_SNAPSHOT_JS);
      if (out.ok) return { content: [{ type: 'text', text: out.text }], details: undefined };
      const snap = await ax<MacSnapshot>('snapshot', {
        ...(params.find === undefined || params.find === '' ? {} : { find: params.find }),
      });
      if (snap === null) {
        return { content: [{ type: 'text', text: out.text }], details: undefined };
      }
      await noteChrome();
      return {
        content: [{ type: 'text', text: formatMacSnapshot(snap) }],
        details: undefined,
      };
    },
  });

  shareTool(pi, {
    name: CHROME_CLICK_TOOL,
    label: 'Chrome: Click',
    description:
      "Click an element in the user's Chrome by its [index] from the latest chrome_snapshot. " +
      'Indexes come from the same visible-element ordering, so they always agree.',
    promptSnippet: "Click an element in the user's Chrome by index",
    parameters: Type.Object({
      index: Type.Number({ description: 'The [index] from chrome_snapshot.' }),
    }),
    async execute(_id, params, _signal, _upd, ctx) {
      const refused = await chromeGate('chrome_click', ctx);
      if (refused !== null) return said(refused);
      const out = await evalInChrome(ctx, chromeActionJs(params.index, 'click'));
      if (out.ok) return { content: [{ type: 'text', text: out.text }], details: undefined };
      const ack = await ax<{ found?: boolean; mode?: string }>('click', { index: params.index });
      if (ack === null) return { content: [{ type: 'text', text: out.text }], details: undefined };
      await noteChrome();
      return {
        content: [
          {
            type: 'text',
            text:
              ack.found === true
                ? `Pressed [${params.index}] (${ack.mode ?? 'AXPress'}, in the background).`
                : `Nothing at [${params.index}] — take a chrome_snapshot again.`,
          },
        ],
        details: undefined,
      };
    },
  });

  shareTool(pi, {
    name: CHROME_TYPE_TOOL,
    label: 'Chrome: Type',
    description:
      "Type text into an editable element in the user's Chrome, by its [index] from the latest " +
      'chrome_snapshot. Sets the value and fires the input/change events a page listens for.',
    promptSnippet: "Type into a field in the user's Chrome",
    parameters: Type.Object({
      index: Type.Number({ description: 'The [index] from chrome_snapshot.' }),
      text: Type.String({ description: 'The text to enter.' }),
      submit: Type.Optional(
        Type.Boolean({ description: 'Commit the field afterwards (a search box, the URL bar).' }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx) {
      const refused = await chromeGate('chrome_type', ctx);
      if (refused !== null) return said(refused);
      const out = await evalInChrome(ctx, chromeActionJs(params.index, 'focus', params.text));
      if (out.ok) return { content: [{ type: 'text', text: out.text }], details: undefined };
      const ack = await ax<{ ok?: boolean }>('type', {
        index: params.index,
        text: params.text,
        ...(params.submit === true ? { submit: true } : {}),
      });
      if (ack === null) return { content: [{ type: 'text', text: out.text }], details: undefined };
      await noteChrome();
      return {
        content: [
          { type: 'text', text: `Set [${params.index}] to ${JSON.stringify(params.text)}.` },
        ],
        details: undefined,
      };
    },
  });

  shareTool(pi, {
    name: CHROME_GO_TOOL,
    label: 'Chrome: Navigate',
    description: "Navigate the active tab of the user's Chrome to a URL.",
    promptSnippet: "Send the user's Chrome to a URL",
    parameters: Type.Object({ url: Type.String({ description: 'The URL to open.' }) }),
    async execute(_id, params, _signal, _upd, ctx) {
      const url = params.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          content: [{ type: 'text', text: 'Only http(s) URLs can be opened this way.' }],
          details: undefined,
        };
      }
      const refused = await chromeGate('chrome_go', ctx);
      if (refused !== null) return said(refused);
      const out = await evalInChrome(ctx, `location.href = ${JSON.stringify(url)}; location.href`);
      return { content: [{ type: 'text', text: out.text }], details: undefined };
    },
  });
}
