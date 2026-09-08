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
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { MacBridge } from './bridge-client.js';
import {
  CHROME_SNAPSHOT_JS,
  chromeActionJs,
  chromeEval,
  chromeJsAllowed,
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
} from './format.js';
import type { MacConsentGate } from './permissions.js';
import { createMacConsentGate } from './permissions.js';
import type {
  MacActAck,
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
import {
  CHROME_CLICK_TOOL,
  CHROME_GO_TOOL,
  CHROME_SNAPSHOT_TOOL,
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
  readonly elementCap?: number;
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

/** Register every mac_* tool onto `pi`. */
export function registerMacComputerUseTools(
  pi: ExtensionAPI,
  options: MacComputerUseOptions,
): void {
  const bridge = options.bridge;
  const cap = options.elementCap ?? DEFAULT_ELEMENT_CAP;
  const consent = options.consent ?? createMacConsentGate();

  /**
   * Per-session CONTROLLED-APP state (see ./session-state.ts). Each pi session
   * (main agent or a spawned subagent) has its own extension instance → its own
   * controlled app, whose pid it stamps onto EVERY act. The helper namespaces
   * its index→element map by pid (concurrent sessions driving different apps
   * never resolve each other's indices) and delivers fallback events to that
   * pid only (postToPid — background, no focus steal).
   */
  const session = options.session ?? createMacSessionState();

  /*
   * END THE SESSION WHEN THE TURN ENDS.
   *
   * Nothing was ever telling the app that driving had stopped, so the phantom
   * cursor kept floating over the user's app and the screen capture kept
   * running — indefinitely, long after the model had finished and the user had
   * moved on. A "Thinking…" bubble hovering over an app nobody is driving is
   * the most alarming thing this feature can do, and it costs battery to say it.
   *
   * Control resumes by itself: the next look or act takes the app again. So
   * releasing at the end of a turn is free, and holding on is not.
   */
  pi.on?.('agent_end', () => {
    if (bridge === null || session.controlled() === null) return;
    session.release?.();
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

  /** What an act should be remembered as: `clicked [7] "Save"`. */
  function actOn(verb: string, index: number): string {
    const name = names.get(index);
    return `${verb} [${index}]${name !== undefined && name !== '' ? ` "${name}"` : ''}`;
  }

  /** What the tool layer knows and the snapshot does not — today, the model's
   * own last act, which the header reads back so it is not re-derived. */
  function view(): MacSnapshotView {
    return { lastAct: session.controlled()?.lastAct };
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
    });
    blocked = blockedIndexes(snap, dialog);
    /* A filtered/paged look ADDS to the names it knows, matching the helper's
     * own merge of the index→element map: page two must not forget page one. */
    if (params.find === undefined && params.from === undefined) names = new Map();
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
      'Look at a Mac app: a compact, indexed list of its controls, which you then act on by ' +
      '[index]. Defaults to the app you are controlling; name another running app to switch to ' +
      'it.\n' +
      'BIG APPS: only the first 60 controls come back. find:"save" lists just the matching ones ' +
      'and from:60 continues the list — indexes never change, so anything you find is clickable ' +
      'straight away.\n' +
      'DIALOGS: a save panel or file picker belongs to the app that opened it, so it is in this ' +
      'same list, announced first, and driven the same way.\n' +
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
      screenshot: Type.Optional(
        Type.Boolean({
          description:
            'Force a screenshot even when Accessibility answers (heavier). Default false — an ' +
            'app with no AX elements attaches one on its own. The image covers every window the ' +
            'app has open, sheets and dialogs included, and the text gives the screen rect it ' +
            'covers so a point read off it maps onto the screen.',
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
        let snap = await snapshot(params.app, params.screenshot === true, page);
        if (params.screenshot !== true && isAxOpaque(snap)) {
          snap = await snapshot(params.app, true, page);
        }
        const content: AgentToolResult<MacDetails>['content'] = [
          { type: 'text', text: formatMacSnapshot(snap, view()) },
        ];
        const shot = snap.screenshot;
        const wantImage = params.screenshot === true || isAxOpaque(snap);
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
            'Screen x (points) for a raw coordinate click; pass with y. Read it off the ' +
            'snapshot image using the image bounds the snapshot prints.',
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
          return textResult(
            `Clicked at (${params.x}, ${params.y}).${backgroundNote(ack)}` +
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
        const ack = await bridge.request<{ ok: boolean; background?: boolean }>(
          'key',
          withTarget({ combo: params.combo }),
        );
        await sleep(SETTLE_MS);
        const note =
          ack.background === true ? ' (delivered to the controlled app, no focus change)' : '';
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

  // --- mac_scroll ----------------------------------------------------------
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
      amount: Type.Optional(Type.Number({ description: 'Pixels to scroll (default ~300).' })),
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
              `Launched ${ack.app ?? params.app} ${where}. ${control} All mac_* actions now ` +
              `target it automatically. ${shotNote}\n\n${snapText}`,
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
export function registerChromeTools(pi: ExtensionAPI): void {
  let askedThisSession = false;

  /** Make sure Chrome will run our JavaScript, asking the user once if not. */
  async function ensureChromeJs(ctx: ExtensionContext): Promise<string | null> {
    if (await chromeJsAllowed()) return null;
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
    const res = await enableChromeJs();
    if (!res.ok) return `Could not change the Chrome setting: ${res.stderr}`;
    return (
      'ENABLED — but Chrome must be RESTARTED before it takes effect. Tell the user to quit ' +
      'and reopen Chrome, then try again.'
    );
  }

  /** Shared: gate, evaluate, and turn a failure into something actionable. */
  async function evalInChrome(
    ctx: ExtensionContext,
    js: string,
  ): Promise<{ text: string; ok: boolean }> {
    const blocked = await ensureChromeJs(ctx);
    if (blocked !== null) return { text: blocked, ok: false };
    const res = await chromeEval(js);
    if (!res.ok) return { text: res.error ?? 'Chrome did not respond.', ok: false };
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
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _upd, ctx) {
      const out = await evalInChrome(ctx, CHROME_SNAPSHOT_JS);
      return { content: [{ type: 'text', text: out.text }], details: undefined };
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
      const out = await evalInChrome(ctx, chromeActionJs(params.index, 'click'));
      return { content: [{ type: 'text', text: out.text }], details: undefined };
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
    }),
    async execute(_id, params, _signal, _upd, ctx) {
      const out = await evalInChrome(ctx, chromeActionJs(params.index, 'focus', params.text));
      return { content: [{ type: 'text', text: out.text }], details: undefined };
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
      const out = await evalInChrome(ctx, `location.href = ${JSON.stringify(url)}; location.href`);
      return { content: [{ type: 'text', text: out.text }], details: undefined };
    },
  });
}
