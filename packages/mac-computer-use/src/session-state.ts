/**
 * The per-session CONTROLLED-APP state machine.
 *
 * the user's core computer-use requirement: once the model opens (or snapshots) an
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
  readonly bbox?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
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
  /** Params every act must be stamped with: `{ pid }` while controlling, `{}`
   * before control exists (legacy frontmost behavior). */
  targetParams(): Record<string, unknown>;
  /** One human/model-readable line naming the controlled target ('' if none). */
  describe(): string;
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

/** Centre-distance ordering, so "nearest" means what it looks like on screen. */
function distance(el: SnapElementLike, x: number, y: number): number {
  const b = el.bbox;
  if (b === undefined) return Number.POSITIVE_INFINITY;
  return Math.hypot(b.x - x, b.y - y);
}

function contains(el: SnapElementLike, x: number, y: number): boolean {
  const b = el.bbox;
  if (b === undefined) return false;
  return (
    x >= b.x - b.w / 2 && x <= b.x + b.w / 2 && y >= b.y - b.h / 2 && y <= b.y + b.h / 2
  );
}

/** Build a fresh session state (one per extension instance / pi session). */
export function createMacSessionState(): MacSessionState {
  let current: ControlledApp | null = null;

  return {
    controlled: () => current,

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

    targetParams(): Record<string, unknown> {
      return current === null ? {} : { pid: current.pid };
    },

    missAt(x: number, y: number): string | null {
      const els = current?.elements ?? [];
      // Nothing to check against, or an app that genuinely has no controls —
      // coordinates are the right and only way to drive that, so say nothing.
      if (current === null || current.visualOnly === true || els.length === 0) return null;
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
