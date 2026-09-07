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
  /** Real prefill percentage when one is being reported, else null. */
  prefillPercent: number | null;
  /** An image is attached (or in the thread) and the model cannot read images. */
  imageOnBlindModel: boolean;
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
  const { readyStage, prefillPercent, imageOnBlindModel } = input;
  if (readyStage === 'loading') {
    return { text: 'Loading model', tone: 'busy', percent: null, kind: 'loading' };
  }
  if (readyStage === 'preparing') {
    return {
      text: 'Getting ready',
      tone: 'busy',
      // A real fraction only when the provider is actually reporting one.
      percent: prefillPercent,
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
