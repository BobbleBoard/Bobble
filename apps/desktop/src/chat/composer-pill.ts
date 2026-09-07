/**
 * What the pill above the input bar says, and whether it can honestly show a
 * percentage.
 *
 * the user, on the "getting ready" text that appears when you move to a new chat:
 * "I'd like to move [it] to a pill that floats above the input bar we can use …
 * both should have a % bar able to be accurately made. If no % is available or
 * able to be shown ACCURATELY, then make the circle a loading spinner."
 *
 * So the rule this module encodes is: a ring ONLY where a real number exists.
 * Today exactly one of the three waits has one:
 *
 *   loading the model   llama-server reports no load progress over HTTP → spinner
 *   getting ready       the warm-up is a non-streaming call, so no
 *                       `prompt_progress` frames come back → spinner
 *   a turn's prefill    the provider forwards real fractions (harness
 *                       `onPromptProgress`) → ring
 *
 * Inventing a number for the first two is the 99%-bar mistake that made a blind
 * tester decide the app was lying to her. A spinner promises only "something is
 * happening", which is all we actually know.
 *
 * Pure: no React, no store.
 */

export type PillTone = 'busy' | 'warn';

/** 0:07 — mm:ss so the width never changes under the eye. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * "Getting ready — usually about 8s on this Mac · 0:03".
 *
 * THE CLOCK IS THE WHOLE POINT, and the first cut left it out. The tester's rule
 * was never "no numbers": it was "a number going up is more trustworthy than a
 * number that stops", and she had to say it a second time — "the spinner isn't
 * what reassures me. The changing digits are. The spinner is just something to
 * look at while they change." A bare spinner starts reading as stuck at about
 * four seconds.
 *
 * The ESTIMATE is the other half of her original four (name, timer, estimate,
 * cancel) and it was missing here too. It is not a guess: once this machine has
 * done the wait twice, how long it took IS a ground truth the app can check —
 * which by her own principle means the app reports it rather than anyone
 * guessing. Before that, it says nothing rather than inventing one.
 */
function waitText(name: string, elapsedMs: number | null, typicalSec: number | null): string {
  const head =
    typicalSec === null ? name : `${name} — usually about ${Math.round(typicalSec)}s on this Mac`;
  // Under a second there is nothing to say yet, and a "0:00" sitting there reads
  // as stopped — which is the failure this exists to avoid.
  if (elapsedMs === null || elapsedMs < 1000) return head;
  return `${head} · ${clock(elapsedMs)}`;
}

/** One candidate for the slot — a derived wait or an ad-hoc publish. */
export interface PillCandidate {
  readonly text: string;
  readonly tone: PillTone;
  readonly spinner?: boolean;
  readonly priority?: number;
  readonly kind?: string;
}

/**
 * ONE PILL AT A TIME, and it is the most urgent one.
 *
 * The slot is deliberately singular: two pills stacked above the composer is a
 * notification centre, and the thing that makes this readable is that there is
 * never more than one sentence to read. Ties go to whatever arrived last, so a
 * fresh message from an equally urgent source replaces a stale one.
 */
export function pickPill<T extends PillCandidate>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (best === null || (c.priority ?? 50) >= (best.priority ?? 50)) best = c;
  }
  return best;
}

export interface PillView {
  /** What the pill says. */
  text: string;
  tone: PillTone;
  /**
   * 0-100 for a ring, or null for a spinner. Null is the honest default: see
   * the note above.
   */
  percent: number | null;
  /** Distinguishes the states for probes and for the tone/icon choice. */
  kind: 'loading' | 'preparing' | 'no-vision';
}

export interface PillInput {
  /** {@link modelReadyStage}: the model is coming up, or the prompt is loading. */
  readyStage: 'loading' | 'preparing' | null;
  /** An image is attached (or in the thread) and the model cannot read images. */
  imageOnBlindModel: boolean;
  /** Milliseconds in the current wait — the number that is going UP. */
  elapsedMs: number | null;
  /** How long this wait has typically taken ON THIS MAC, or null before it has
   * happened twice. */
  typicalSec: number | null;
}

/**
 * The one thing the pill should say, or null for nothing.
 *
 * ONE AT A TIME, and the order is the order of urgency. A model that is still
 * loading cannot answer at all, so that outranks a warning about an attachment
 * it has not been asked about yet; and the image warning outranks nothing,
 * which is why it is last.
 */
export function composerPill(input: PillInput): PillView | null {
  const { readyStage, imageOnBlindModel, elapsedMs, typicalSec } = input;
  /*
   * THREE WAITS, THREE PHRASES. Two of them said the same words in the first
   * cut, and only one could ever carry a number. The tester: "I will see both of
   * those in my first week. The moment I do, the one without the number becomes
   * a bug — because you've proved to me, with the other one, that this app can
   * count." So the turn's own prefill left this component entirely (it is about
   * the message you just sent, and it belongs in the thread with it), and the
   * two that remain are named for what is actually happening.
   */
  if (readyStage === 'loading') {
    return {
      text: waitText('Starting up', elapsedMs, typicalSec),
      tone: 'busy',
      percent: null,
      kind: 'loading',
    };
  }
  if (readyStage === 'preparing') {
    return {
      text: waitText('Getting ready', elapsedMs, typicalSec),
      tone: 'busy',
      percent: null,
      kind: 'preparing',
    };
  }
  if (imageOnBlindModel) {
    return {
      text: 'Selected model does not support images',
      tone: 'warn',
      percent: null,
      kind: 'no-vision',
    };
  }
  return null;
}
