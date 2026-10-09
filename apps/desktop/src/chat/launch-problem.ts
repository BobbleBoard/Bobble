/**
 * WHY A MESSAGE IS WAITING: THE MODEL DID NOT START.
 *
 * A send waits for the chat model; when the wait ends without one, the message
 * is held (held-send-store.ts) and this says why, in the person's words, with
 * the fix that applies — instead of the send going on to a server that was not
 * there and coming back as a red "fetch failed" (the user, 2026-10-08). Pure: the
 * recorded reason in (auto-router `ServerProblem`), a description out; the
 * supervisor's own words are kept as `detail`, behind Details.
 */
import type { ServerProblem } from './auto-router';

export type LaunchFix = 'retry' | 'other-model' | 'models';

export const LAUNCH_FIX_LABEL: Readonly<Record<LaunchFix, string>> = {
  retry: 'Try again',
  'other-model': 'Choose another model',
  models: 'Open Models',
};

export interface LaunchProblem {
  readonly title: string;
  readonly body: string;
  readonly fix: LaunchFix;
  readonly also: readonly LaunchFix[];
  readonly detail: string;
}

const MEMORY =
  /memory|\bRAM\b|won.?t fit|does not fit|too large|insufficient|not enough|reserve|compute error|out of memory|OOM/i;
const OFFLINE =
  /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|network|offline|could not fetch|ECONNRESET/i;
const MISSING = /no such file|ENOENT|missing|not downloaded|not on (this )?disk/i;
const ENGINE = /is not installed/i;
const NOT_LOADED = /never became healthy|did not start|timed? ?out|health|exited|crash/i;

export function describeLaunchProblem(problem: ServerProblem): LaunchProblem {
  const detail = (problem.detail ?? '').trim();
  const name = problem.modelName ?? 'The model';
  if (problem.kind === 'no-model') {
    return {
      title: 'There is no model on this Mac to answer with yet.',
      body: 'The Models page suggests one that fits this Mac; your message sends once it is in.',
      fix: 'models',
      also: [],
      detail,
    };
  }
  if (problem.kind === 'timeout') {
    return {
      title: `${name} is taking more than five minutes to load.`,
      body: 'It may still finish — Try again keeps waiting for it. A smaller model loads faster.',
      fix: 'retry',
      also: ['other-model'],
      detail,
    };
  }
  const why = MEMORY.test(detail)
    ? {
        body: 'There is not enough free memory for it right now. Closing other apps frees some; a smaller model needs less.',
        fix: 'retry' as const,
        also: ['other-model' as const],
      }
    : OFFLINE.test(detail)
      ? {
          body: 'Starting it needed a download, and this Mac could not reach the internet. Reconnect, then Try again.',
          fix: 'retry' as const,
          also: ['other-model' as const],
        }
      : ENGINE.test(detail)
        ? {
            body: 'The engine it runs on is not installed. Another model can answer now; the Models page can set this one up.',
            fix: 'other-model' as const,
            also: ['models' as const],
          }
        : MISSING.test(detail)
          ? {
              body: 'Some of its files are not on this Mac any more. The Models page can download them again.',
              fix: 'models' as const,
              also: ['other-model' as const],
            }
          : NOT_LOADED.test(detail)
            ? {
                body: 'It did not finish loading. Trying again usually works; a smaller model loads faster.',
                fix: 'retry' as const,
                also: ['other-model' as const],
              }
            : {
                body: 'It stopped while it was loading. Trying again usually works.',
                fix: 'retry' as const,
                also: ['other-model' as const],
              };
  return { title: `${name} could not start.`, ...why, detail };
}
