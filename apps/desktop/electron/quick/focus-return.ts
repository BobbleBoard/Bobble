/**
 * WHO GETS THE KEYBOARD BACK WHEN THE QUICK PANEL GOES AWAY.
 *
 * The panel is a non-activating panel (Electron's `type: 'panel'`): showing it
 * gives it the keyboard WITHOUT making Bobble the active app, the way Spotlight
 * works. The app you were in stays active the whole time, so in the common case
 * there is nothing to give back — hiding the panel returns the keyboard to that
 * app's own window by itself, and doing anything more would fight it.
 *
 * Something has to happen only when Bobble DID become the active app while the
 * panel was up (the person clicked into Bobble's main window and back, a system
 * sheet activated it) or when an action needs the other app in front on
 * purpose — pasting a reply into it. That is this decision; mac-side code
 * carries it out with the helper's `focus`, which activates by pid.
 *
 * Pure, so the rule is testable without moving anyone's focus.
 */

/** The app that was in front when the panel was summoned. */
export interface PreviousApp {
  readonly pid: number;
  readonly name: string;
  readonly bundleId?: string;
}

export type DismissReason =
  /** Esc, the hotkey again, or the panel's own close. */
  | 'escape'
  /** The person clicked another window — focus is already where they put it. */
  | 'blur'
  /** "Open in Bobble": the main window is where they are going. */
  | 'open-in-main'
  /** "Replace selection": the reply has to land in the app it came from. */
  | 'paste'
  /** The panel stepped aside for an area or window pick. */
  | 'capture';

export type FocusDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'activate-previous'; readonly pid: number; readonly name: string }
  | { readonly kind: 'focus-main' };

export function focusReturnDecision(input: {
  readonly reason: DismissReason;
  readonly previous: PreviousApp | null;
  /** Bobble's own process (and any helper it runs): never "the previous app". */
  readonly ownPids: readonly number[];
  /** The active app right now, when it can be read; null when it cannot. */
  readonly frontmostPid: number | null;
  /** Test runs never move anyone's focus. */
  readonly background: boolean;
}): FocusDecision {
  if (input.background) return { kind: 'none' };
  if (input.reason === 'open-in-main') return { kind: 'focus-main' };
  // They clicked somewhere: that is where the keyboard is meant to be.
  if (input.reason === 'blur') return { kind: 'none' };
  // The overlay or picker that replaces the panel takes over from here.
  if (input.reason === 'capture') return { kind: 'none' };
  const prev = input.previous;
  if (prev === null || prev.pid <= 0 || input.ownPids.includes(prev.pid)) {
    // Summoned over Bobble itself (or we never learned what was in front):
    // the keyboard goes back to Bobble's window on its own.
    return { kind: 'none' };
  }
  if (input.reason === 'paste') {
    return { kind: 'activate-previous', pid: prev.pid, name: prev.name };
  }
  // Esc: only when something made Bobble the active app in the meantime.
  if (input.frontmostPid !== null && input.ownPids.includes(input.frontmostPid)) {
    return { kind: 'activate-previous', pid: prev.pid, name: prev.name };
  }
  return { kind: 'none' };
}
