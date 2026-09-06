/**
 * WHETHER TO INTERRUPT SOMEONE — the decision, separated from the interrupting.
 *
 * This lived inline in `app:notify`, three early returns deep, and could not be
 * exercised without a real window and a real OS notification. So the probe that
 * meant to test the focus gate did the only thing available to it: it called
 * `app.focus({ steal: true })` and `win.show()` to MAKE the window frontmost —
 * on every suite run, over whatever the user was doing, which is the one thing
 * the test mode exists to prevent. And it never tested the gate anyway: test
 * mode suppresses first, so the focused branch was unreachable and the probe
 * took a vacuous `else` every time it did not manage to steal the screen.
 *
 * The decision is a pure function of three facts, so it is one here, and the
 * screen stays the user's.
 */

/** What `app:notify` answers, and why. */
export interface NotifyDecision {
  readonly shown: boolean;
  readonly reason?: string;
}

export interface NotifyConditions {
  /** A test run. Nothing may reach the screen, whatever else is true. */
  readonly backgroundMode: boolean;
  /** The main window has keyboard focus — the user is already looking. */
  readonly windowFocused: boolean;
  /** The platform can post notifications at all. */
  readonly supported: boolean;
}

/**
 * The order matters and is not arbitrary: suppression beats everything (a suite
 * must never post a banner), then "they are already looking", then "the platform
 * cannot". Only when all three pass is a notification worth showing.
 */
export function notifyDecision(c: NotifyConditions): NotifyDecision {
  if (c.backgroundMode) return { shown: false, reason: 'suppressed: background test mode' };
  if (c.windowFocused) return { shown: false, reason: 'the window is focused' };
  if (!c.supported) return { shown: false, reason: 'notifications are unavailable here' };
  return { shown: true };
}
