/**
 * SAYING WHY AN OPEN DID NOT HAPPEN.
 *
 * the user: "open buttons in the canvas / file presentation cards don't work, even
 * with selection of specific applications to open with." Every Open, Open-with
 * and Show in the app was `void window.piDesktop.invoke(…)` — main answered
 * `{ ok: false, error }` and nobody read it, so a refusal and a success looked
 * the same: nothing happened. Main now says WHY in one sentence
 * (electron/canvas/os-open.ts); this names the file and puts it on screen.
 */
import { plainError as sayError } from '@pi-desktop/shared';
import { usePiStore } from '../../state/pi-slice';
import { locateChatFile } from './file-tabs';

/** What main answers for every hand-to-the-OS request. */
export interface OpenOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** Open it in an app, or select it in Finder. */
export type OpenVerb = 'open' | 'reveal';

export interface OpenContext {
  readonly verb: OpenVerb;
  /** The file, as the control that was clicked knows it. */
  readonly path: string;
  /** The app picked from Open with, when one was. */
  readonly appName?: string;
  /**
   * The same hand-off at another path: a file that is not where the control
   * thinks is looked for in the chat's folders (fs:locate) and, found, opened
   * there instead of reported missing.
   */
  readonly retryAt?: (path: string) => Promise<OpenOutcome>;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Electron wraps a handler's throw as "Error invoking remote method 'x': Error: why". */
function plainError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim();
}

/**
 * The sentence a failed open is shown with — the file, the app when one was
 * chosen, then main's reason — or null when it worked.
 */
export function openFailureMessage(context: OpenContext, outcome: OpenOutcome): string | null {
  if (outcome.ok) return null;
  const name = baseName(context.path) || 'the file';
  const head =
    context.verb === 'reveal'
      ? `Couldn't show ${name} in Finder.`
      : `Couldn't open ${name}${context.appName !== undefined && context.appName !== '' ? ` in ${context.appName}` : ''}.`;
  const raw = plainError(outcome.error ?? '');
  // Main's reasons are mostly sentences already; a raw one (an errno, a quoted
  // path, a stack's first line) is said in words instead.
  const why =
    raw === ''
      ? 'The Mac did not say why.'
      : /\b(E[A-Z]{3,}|errno)\b|[{}]|^[A-Z]\w*Error\b|\(\w*Error/.test(raw)
        ? sayError(raw, 'open')
        : raw;
  return `${head} ${why}`;
}

let toastSeq = 0;

/** The app's error toast (ToastHost), the same surface every other failure uses —
 * raised the way pi-connect raises "Could not open that chat". */
function toast(message: string): void {
  toastSeq += 1;
  const id = `open-${Date.now()}-${toastSeq}`;
  usePiStore.setState((s) => ({
    notifications: [
      ...s.notifications.slice(-3),
      { id, level: 'error' as const, message, timestamp: Date.now() },
    ],
  }));
}

/**
 * Run one hand-to-the-OS invoke and SAY so when it did not work. Never throws:
 * an invoke that rejects (main refusing the call) is a failure like any other.
 */
export async function reportOpen(
  run: () => Promise<OpenOutcome>,
  context: OpenContext,
  report: (message: string) => void = toast,
): Promise<OpenOutcome> {
  let outcome: OpenOutcome;
  try {
    outcome = await run();
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (
    !outcome.ok &&
    context.retryAt !== undefined &&
    /not there any more|no longer there|cannot be found|not a file|ENOENT|no such file/i.test(
      outcome.error ?? '',
    )
  ) {
    const found = await locateChatFile(context.path).catch(() => null);
    if (found !== null && found !== context.path) {
      try {
        outcome = await context.retryAt(found);
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  const message = openFailureMessage(context, outcome);
  if (message !== null) report(message);
  return outcome;
}
