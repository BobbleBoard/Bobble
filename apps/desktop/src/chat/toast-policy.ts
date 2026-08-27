/**
 * Pure toast policy for the pi bridge-exit case (round-blindtest #11). Split out
 * of ToastHost so the dedupe rule + the humanized copy are unit-testable without
 * rendering Radix Toast or touching the IPC bridge.
 *
 * When pi exits unexpectedly the event router emits BOTH a raw
 * `notify('error', 'pi exited (143).')` AND a `bridgeExit(...)`. Rendered
 * naively that stacks TWO scary red toasts, one showing a raw signal code. The
 * policy here suppresses the raw line and lets the single humanized bridge-exit
 * toast stand in for it.
 */

/**
 * The humanized bridge-exit toast copy — never a raw signal/exit code (143).
 *
 * ONE EVENT, ONE STORY. This used to say "The assistant restarted", then
 * "Restart to pick up where you left off", then offer a Restart button: three
 * different accounts of the same moment, one of them false. Nothing has
 * restarted — `restartPi` runs only when the button is pressed.
 *
 * So it says what happened, that nothing was lost, and leaves the button to be
 * the action.
 */
export const BRIDGE_EXIT_TOAST = {
  title: 'The assistant stopped',
  description: 'Your conversation is safe. Restart to keep going.',
} as const;

/**
 * True for the router's raw "pi exited (<code>)." crash line. It carries a raw
 * signal/exit code and is redundant with the humanized bridge-exit toast, so it
 * must never render on its own. Coupled to the router's message prefix
 * (packages/engine event-router.ts).
 */
export function isBridgeExitNotice(message: string): boolean {
  return /^pi exited \(/.test(message);
}
