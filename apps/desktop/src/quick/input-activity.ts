/**
 * EVERY INPUT EVENT IN THE QUICK PANEL GOES THROUGH HERE.
 *
 * Keystrokes, a paste, a dropped file, the start of a capture, the start of
 * push-to-talk: each one means the person is about to ask something, which is
 * the moment to have the model loaded and the conversation's prefix prefilled
 * so the answer starts the instant they press Return.
 *
 * TODO(input-activity): a parallel change on main is adding an "input
 * activity" signal that loads the model and prefills as soon as the user starts
 * typing. Wire this function to it when this branch is merged; until then it
 * deliberately does nothing. Every call site in src/quick already routes here,
 * so the wiring is this one function body.
 */

/** What kind of input it was — for the signal's own use once it is wired. */
export type QuickInputKind = 'key' | 'paste' | 'drop' | 'capture' | 'talk';

export function markInputActivity(_kind: QuickInputKind): void {
  // Intentionally empty until the input-activity signal lands (see the TODO above).
}
