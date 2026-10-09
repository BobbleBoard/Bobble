/**
 * WHAT A FAILURE TOAST SAYS.
 *
 * Every error notification used to render as a red "Error" toast carrying the
 * raw line it was raised with — "pi rejected set_model: …", "Extension error:
 * TypeError …", "Compaction failed: llama-server http 500 …" (the 2026-10-08
 * audit, after the user: "red text that's just a real unknown error … just can't
 * exist anymore"). This turns each known line into what happened, plainly, and
 * anything else into plainError's sentence; the raw line goes to the console.
 * `null` means stay quiet: the line has a better surface already (the bridge
 * exit's own toast). Pure.
 */
import { plainError } from '@pi-desktop/shared';

export interface ToastCopy {
  readonly title: string;
  readonly description: string;
}

export function toastCopy(message: string): ToastCopy | null {
  const m = message.trim();
  // The bridge's own exit/health toast carries the story and the Restart.
  if (/^pi (exited|bridge error)\b/.test(m)) return null;
  if (/^Loop guard aborted the turn/i.test(m)) {
    return {
      title: 'The turn was stopped',
      description:
        'The model kept repeating the same steps, so it was stopped. Rephrasing the ask, or a larger model, usually gets past it.',
    };
  }
  if (/^Compaction failed/i.test(m)) {
    return {
      title: 'The conversation was not shortened',
      description: 'It carries on as it is. If it grows too long, a new chat starts fresh.',
    };
  }
  if (/^Extension error/i.test(m)) {
    return {
      title: 'An extension hit a problem',
      description: 'It was skipped; the rest of the chat carries on.',
    };
  }
  if (/^pi rejected /i.test(m)) {
    return { title: 'That did not go through', description: 'Try it again.' };
  }
  if (/^(Unknown (effort|mode|subcommand)|Usage: \/harness)/i.test(m)) {
    return { title: 'That setting did not apply', description: 'Choose it again.' };
  }
  // Lines the app already wrote for people (they start with what failed).
  if (
    /^(Could not|Couldn't|Couldn’t|That message|Not compacted)/.test(m) &&
    !/[{}]|Error:/.test(m)
  ) {
    return { title: 'That did not work', description: m };
  }
  return { title: 'That did not work', description: plainError(m) };
}
