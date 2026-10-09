/**
 * EVERY INPUT EVENT IN THE QUICK PANEL GOES THROUGH HERE.
 *
 * Keystrokes, a paste, a dropped file, the start of a capture, the start of
 * push-to-talk: each one means the person is about to ask something, which is
 * the moment to have the model loaded and the conversation's prefix prefilled
 * so the answer starts the instant they press Return.
 *
 * It is the same signal the main composer sends (state/input-activity.ts): it
 * restarts the five-minute idle clock and loads back a model that was unloaded
 * while idle (electron/inference/idle-unload.ts). The panel is often the first
 * thing touched after a long break, so it matters most here.
 */
import { noteInputActivity } from '../state/input-activity';

/** What kind of input it was. The signal itself does not distinguish them yet. */
export type QuickInputKind = 'key' | 'paste' | 'drop' | 'capture' | 'talk';

export function markInputActivity(_kind: QuickInputKind): void {
  noteInputActivity();
}
