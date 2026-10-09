/**
 * WHAT WENT WRONG WITH A TURN, AND WHAT TO DO ABOUT IT.
 *
 * The user (2026-10-08): "anything like this including but absolutely not limited
 * to 'the voice model is not installed' our dreaded 'fetch failed' 'this file
 * couldn't be found' … red text that's just a real unknown error or something
 * that doesn't have handling attached to it or can be easily done something
 * about just can't exist anymore."
 *
 * A turn that ends in an error used to print the error under the reply in red.
 * This reads the error a turn ended with and says, in the person's words, what
 * happened and which one thing fixes it: the card under the reply
 * (TurnProblemCard) carries that action as its button. The engine's own fixes
 * run before anything reaches here — a request waits for a server that is on
 * its way back, an overflowing context is trimmed and sent again, a stalled
 * stream is sent again once — so what arrives is what those could not fix.
 *
 * Pure: the raw error text in, a description out. The raw text is kept as
 * `detail`, behind "Details", never as the message.
 */
import { cleanErrorText, isAbortMessage, stripAnsi } from '@pi-desktop/engine';

/** The fixes a turn problem can offer, each a button wired by the card. */
export type TurnFix =
  /** Send the same message again. */
  | 'retry'
  /** Start the model engine afresh, then send the message again. */
  | 'restart'
  /** Open the model picker on a model that needs less memory. */
  | 'smaller-model'
  /** Open the model picker on a model that reads more. */
  | 'longer-model'
  /** Carry on in a new chat. */
  | 'new-chat';

export type TurnProblemKind =
  | 'engine-away'
  | 'memory'
  | 'too-long'
  | 'stalled'
  | 'engine-error'
  | 'unexpected';

export interface TurnProblem {
  readonly kind: TurnProblemKind;
  /** One plain sentence: what happened. */
  readonly title: string;
  /** What the buttons will do, or what the person can do. */
  readonly body: string;
  /** The main fix, first and filled. */
  readonly fix: TurnFix;
  /** Other fixes worth a button. */
  readonly also: readonly TurnFix[];
  /** The error as the engine said it, for "Details" and a bug report. */
  readonly detail: string;
}

/** Button labels, the same everywhere a fix is offered. */
export const FIX_LABEL: Readonly<Record<TurnFix, string>> = {
  retry: 'Try again',
  restart: 'Restart the model and try again',
  'smaller-model': 'Choose a smaller model',
  'longer-model': 'Choose a model that reads more',
  'new-chat': 'Continue in a new chat',
};

const ENGINE_AWAY =
  /fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|socket hang up|other side closed|network ?error|connect(ion)? refused|terminated/i;
const MEMORY =
  /compute error|short of memory|out of memory|\bOOM\b|failed to allocate|insufficient memory|not enough memory|kIOGPUCommandBufferCallbackErrorOutOfMemory|metal.*(allocat|memory)/i;
const TOO_LONG =
  /too long for the model's context|exceed_context_size|exceeds the available context|context (window|length|size).*(exceed|too)|maximum context length/i;
const STALLED = /stopped responding|stalled/i;
const ENGINE_ERROR =
  /returned an error|stopped with an error|server returned|HTTP \d{3}|returned no response body|mlx_lm\.server|llama-server|apply-template|internal server error/i;

/**
 * The problem a turn's error describes, or null when there is none to show —
 * no error, or the person stopped the turn themselves.
 */
export function describeTurnProblem(raw: string | undefined): TurnProblem | null {
  if (raw === undefined) return null;
  const detail = stripAnsi(raw).trim();
  if (detail === '' || isAbortMessage(detail)) return null;
  const said = cleanErrorText(detail);

  if (MEMORY.test(detail)) {
    return {
      kind: 'memory',
      title: 'The model ran out of memory before it could answer.',
      body: 'Closing other apps frees some up; a smaller model needs less of it.',
      fix: 'retry',
      also: ['smaller-model'],
      detail,
    };
  }
  if (TOO_LONG.test(detail)) {
    return {
      kind: 'too-long',
      title: 'This chat has grown longer than the model can read at once.',
      body: 'A new chat starts fresh; a model that reads more can carry on here.',
      fix: 'new-chat',
      also: ['longer-model'],
      detail,
    };
  }
  if (STALLED.test(detail)) {
    return {
      kind: 'stalled',
      title: 'The model stopped responding partway through.',
      body: 'Restarting it clears whatever it was stuck on.',
      fix: 'restart',
      also: ['retry'],
      detail,
    };
  }
  if (ENGINE_AWAY.test(detail)) {
    return {
      kind: 'engine-away',
      title: 'The model engine was not running when this was sent.',
      body: 'Restarting it brings it back with the same model.',
      fix: 'restart',
      also: [],
      detail,
    };
  }
  if (ENGINE_ERROR.test(detail) || said !== detail) {
    return {
      kind: 'engine-error',
      title: 'The model engine hit a problem while answering.',
      body: 'Sending it again usually works; if it does not, restart the model.',
      fix: 'retry',
      also: ['restart'],
      detail,
    };
  }
  return {
    kind: 'unexpected',
    title: 'This reply did not finish.',
    body: 'Sending it again usually works.',
    fix: 'retry',
    also: ['restart'],
    detail,
  };
}
