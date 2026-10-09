/**
 * The per-session CONTROLLED-APP state machine.
 *
 * The user's core computer-use requirement: once the model opens (or snapshots) an
 * app, the session must KNOW that app is the controlled target — every
 * subsequent click/type/key/scroll routes to it unambiguously (pid-stamped, so
 * the helper resolves indices in the right namespace AND delivers fallback
 * events to that app only, in the background), and the model is told what it
 * is controlling.
 *
 * Pure state in a closure — no bridge, no timers — so the contract unit-tests
 * exactly: which events take control, which merely refresh it, and what gets
 * stamped onto acts.
 *
 * Transitions:
 *   - `noteLaunched(app, pid)`   → takes control (mac_launch resolved a pid).
 *   - `noteSnapshot(snap)`       → takes/refreshes control: an explicit-app or
 *     first snapshot moves control to the snapshotted app; a default snapshot
 *     of the already-controlled app just refreshes its metadata.
 *   - `release()`                → drops control (app gone / session reset).
 *
 * And, beside control, whether this session DROVE anything this turn
 * (`noteDriving` / `endTurn`) — which is not the same question: a chat can hold
 * control it restored from a record and not touch the Mac all turn.
 */

/** The app this session is currently driving. */
export interface ControlledApp {
  readonly pid: number;
  readonly app: string;
  readonly windowId?: number;
  /**
   * The app answered Accessibility with nothing, so the only way to see it is
   * the screenshot and the only way to act on it is coordinates and keystrokes.
   *
   * This is recorded because the SAFE rule for typing — "never type without an
   * index, it would land in the user's frontmost app" — has no safe alternative
   * here: an app with no AX tree has no indices to pass. Without knowing which
   * kind of app is being controlled, the tools tell the model to do something
   * it cannot do, and the turn dead-ends.
   */
  readonly visualOnly?: boolean;
  /** Controls from the last snapshot of THIS app, for the coordinate check. */
  readonly elements?: readonly SnapElementLike[];
  /**
   * The modal surface that was up at the last look, as a comparable signature
   * ('' for none).
   *
   * Why it is remembered: an index the model is about to act on was read from a
   * snapshot taken at some earlier moment. If a sheet or file picker has opened
   * since, that number now belongs to whatever the helper resolves TODAY —
   * quite possibly a control in the window BEHIND the dialog. Comparing this
   * against a fresh snapshot is what lets the retry path stop and show the
   * dialog instead of silently acting behind it.
   */
  readonly dialogKey?: string;
  /**
   * The last act this session performed, in the model's own vocabulary:
   * `clicked [7] "Save"`, `pressed cmd+s`, `typed into [3]`.
   *
   * The snapshot header reads it back so the model does not re-derive "what did
   * I just do" from the transcript on every look. It is the cheapest continuity
   * there is — one clause, written by the tool that did the thing.
   */
  readonly lastAct?: string;
  /**
   * Restored from the app ANOTHER chat last drove (tools.ts), and not yet looked
   * at here. A guess, not a choice: the first look that uses it says so, and
   * work elsewhere may replace it — nothing may replace an app this chat chose.
   */
  readonly carriedOver?: boolean;
}

/** Snapshot-shaped input (structural: the wire MacSnapshot satisfies it). */
export interface ControlledSnapshotNote {
  readonly app?: string;
  readonly pid?: number;
  readonly windowId?: number;
  /** True when the snapshot came back with no Accessibility elements. */
  readonly visualOnly?: boolean;
  /** Signature of the modal surface this snapshot saw ('' / absent = none). */
  readonly dialogKey?: string;
  /** The indexed controls this snapshot listed, kept so a blind coordinate can
   * be checked against them (see `missAt`). */
  readonly elements?: readonly SnapElementLike[];
}

/** The part of a snapshot element a coordinate check needs. */
export interface SnapElementLike {
  readonly index: number;
  readonly name: string;
  readonly role: string;
  readonly bbox?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

export interface MacSessionState {
  /** The controlled app, or null before anything was launched/snapshotted. */
  controlled(): ControlledApp | null;
  /** mac_launch resolved a background-opened app → it takes control. */
  noteLaunched(app: string, pid: number, windowId?: number): void;
  /** A snapshot resolved → the snapshotted app takes/refreshes control. */
  noteSnapshot(snap: ControlledSnapshotNote): void;
  /** Record what this session just did, for the next snapshot's header. */
  noteAct(act: string): void;
  /** Drop control (controlled app quit / explicit reset). */
  release(): void;
  /**
   * Take control back from a record — the app this session was driving before
   * the pi child was restarted or the chat reopened (see the `mac-control`
   * entry in tools.ts), or, `carriedOver`, the one another chat last drove.
   * Nothing is known about its windows or its last act.
   */
  restore(record: { app: string; pid: number; windowId?: number; carriedOver?: boolean }): void;
  /** Params every act must be stamped with: `{ pid, app }` while controlling
   * (the name is the fallback for a pid that has since quit), `{}` before
   * control exists (legacy frontmost behavior). */
  targetParams(): Record<string, unknown>;
  /** One human/model-readable line naming the controlled target ('' if none). */
  describe(): string;
  /** A look or an act went to the Mac — the overlay and the monitor follow those. */
  noteDriving(): void;
  /**
   * The turn ended: whether THIS session drove anything in it, and a clean
   * slate for the next.
   *
   * Only a session that drove may put the driving away (tools.ts, agent_end).
   * The overlay, the monitor and the user's Stop / Take-over brake belong to the
   * app, not to whichever session's turn happens to end: a chat that carried an
   * app over from another chat — or a subagent, a corp role, a scheduled run —
   * holds control without having touched anything, and its turn ending used to
   * tear down another chat's live run and lift the brake the user had pressed.
   */
  endTurn(): boolean;
  /**
   * What a click at this point ACTUALLY hit, when the answer is "nothing".
   *
   * A coordinate click used to answer "Clicked at (380, 450)." whatever happened
   * — indistinguishable from a click that worked. MEASURED: a 4B handed a
   * snapshot of Calculator's 25 named buttons clicked (380,450), (430,450),
   * (300,450) — none of which is a button — and was told each time that it had
   * clicked. It never learned it was pressing empty window.
   *
   * Returns null when the point is inside a known control (or when there is
   * nothing to check against), and otherwise a line naming the nearest few by
   * index. The click still happens: a coordinate is the only way to drive an app
   * that exposes nothing, and correcting the point would break sheets that sit
   * outside their parent's frame.
   */
  missAt(x: number, y: number): string | null;
}

/** The three or four buttons every macOS window has. An app that lists only
 * these has told Accessibility nothing about itself — see missAt. Kept here
 * rather than imported from format.ts, which imports this module's protocol
 * types; one small list is cheaper than a cycle. */
const WINDOW_FURNITURE = new Set([
  'close button',
  'full screen button',
  'minimize button',
  'zoom button',
]);

/** Centre-distance ordering, so "nearest" means what it looks like on screen. */
function distance(el: SnapElementLike, x: number, y: number): number {
  const b = el.bbox;
  if (b === undefined) return Number.POSITIVE_INFINITY;
  return Math.hypot(b.x - x, b.y - y);
}

function contains(el: SnapElementLike, x: number, y: number): boolean {
  const b = el.bbox;
  if (b === undefined) return false;
  return x >= b.x - b.w / 2 && x <= b.x + b.w / 2 && y >= b.y - b.h / 2 && y <= b.y + b.h / 2;
}

/** Build a fresh session state (one per extension instance / pi session). */
export function createMacSessionState(): MacSessionState {
  let current: ControlledApp | null = null;
  let drove = false;

  return {
    controlled: () => current,

    noteDriving(): void {
      drove = true;
    },

    endTurn(): boolean {
      const did = drove;
      drove = false;
      return did;
    },

    noteLaunched(app: string, pid: number, windowId?: number): void {
      current = { pid, app, windowId, lastAct: `opened ${app}` };
    },

    noteSnapshot(snap: ControlledSnapshotNote): void {
      if (typeof snap.pid !== 'number') return; // unresolved snapshot cannot take control
      current = {
        pid: snap.pid,
        app: snap.app ?? current?.app ?? '',
        windowId: snap.windowId ?? (snap.pid === current?.pid ? current?.windowId : undefined),
        visualOnly: snap.visualOnly === true,
        /* A look ALWAYS overwrites this, including with '' — "no dialog now" is
         * as important as "a dialog appeared", or a dismissed sheet would keep
         * blocking retries forever. */
        dialogKey: snap.dialogKey ?? '',
        elements: snap.elements ?? (snap.pid === current?.pid ? current?.elements : undefined),
        /* A LOOK IS NOT AN ACT. Snapshotting must not erase what the model
         * actually did, or the header would say "your last act: looked at it"
         * on the very turn the model needs to remember it pressed Save. Control
         * moving to a DIFFERENT app does clear it, because the act belonged to
         * the app it was aimed at. */
        lastAct: snap.pid === current?.pid ? current?.lastAct : undefined,
      };
    },

    noteAct(act: string): void {
      if (current !== null) current = { ...current, lastAct: act };
    },

    release(): void {
      current = null;
    },

    restore(record: { app: string; pid: number; windowId?: number; carriedOver?: boolean }): void {
      current = {
        pid: record.pid,
        app: record.app,
        windowId: record.windowId,
        ...(record.carriedOver === true ? { carriedOver: true } : {}),
      };
    },

    targetParams(): Record<string, unknown> {
      if (current === null) return {};
      // The name rides along: a pid that has quit since (a restart, a relaunch
      // of the app) resolves by name instead of failing the look.
      return current.app !== '' ? { pid: current.pid, app: current.app } : { pid: current.pid };
    },

    missAt(x: number, y: number): string | null {
      const els = current?.elements ?? [];
      // Nothing to check against, or an app that genuinely has no controls —
      // coordinates are the right and only way to drive that, so say nothing.
      if (current === null || current.visualOnly === true || els.length === 0) return null;
      /*
       * AND CHECK IT AGAIN HERE, because `visualOnly` is a judgement made at
       * SNAPSHOT time and this runs later.
       *
       * MEASURED on a Blender run: the model clicked a point it had worked out
       * carefully from the screenshot and was told "NOTHING IS AT (263, 106) —
       * the click landed on empty window. Blender lists its controls, so click
       * them by [index]". Blender lists three: close, full screen, minimize.
       * The model was right to distrust it — "this may be because the hit test
       * is only looking at accessible controls (Blender doesn't expose its
       * controls)" — and a harness that tells a model its correct action failed
       * is worse than one that says nothing.
       *
       * An app whose entire list is window furniture cannot adjudicate a click
       * anywhere inside it.
       */
      if (!els.some((e) => !WINDOW_FURNITURE.has(e.name.trim().toLowerCase()))) return null;
      if (els.some((e) => contains(e, x, y))) return null;
      const near = [...els]
        .sort((a, b) => distance(a, x, y) - distance(b, x, y))
        .slice(0, 3)
        .map((e) => `[${e.index}] ${e.name !== '' ? `"${e.name}"` : e.role}`)
        .join(' · ');
      return (
        `NOTHING IS AT (${x}, ${y}) — the click landed on empty window. ` +
        `"${current.app}" lists its controls, so click them by [index] instead of guessing a ` +
        `point. Nearest to where you aimed: ${near}. mac_snapshot lists them all.`
      );
    },

    describe(): string {
      return current === null ? '' : `You are controlling "${current.app}" (pid ${current.pid}).`;
    },
  };
}
