/**
 * Composer "+" modality actions → the prompt scaffold they prefill. Kept in a
 * pure, React-free module so it unit-tests in the node env and stays the single
 * source of truth for the UI's {@link GenActionKey}.
 *
 * These used to also pin a harness TASK CLASS, which loaded a toolset for the
 * next send. Task classification is gone: there is one base set now and every
 * other toolset arrives through `capability`, which lands inside the turn that
 * asks for it. So "Generate an image of …" reaches the generation tools the same
 * way any other phrasing does, and the button's job is back to what it says on
 * it — putting the words in the box.
 */
import type { GenActionKey } from '@pi-desktop/ui';

export type { GenActionKey };

export interface GenActionPlan {
  /**
   * A tiny prompt scaffold prefilled into the composer editor when the action is
   * chosen. Deliberately plain natural language (NOT a `/slash` lead-in, which
   * would route through pi's command path instead of a normal prompt).
   *
   * It is now the PILL'S PAYLOAD rather than typed text — the words still reach
   * the model exactly as before, but in the box they are one object you can
   * remove with a click. The user: "including for buttons in the + menu no raw text."
   */
  readonly scaffold: string;
  /** The pill's own words in the box. Short: it is a token, not a sentence. */
  readonly pill: string;
  /** The pill's glyph. */
  readonly icon: 'image' | 'video' | 'motion' | 'search';
}

/** One plan per "+" gen row. Keys mirror {@link GenActionKey} exactly. */
export const GEN_ACTION_PLANS: Record<GenActionKey, GenActionPlan> = {
  image: {
    scaffold: 'Generate an image of ',
    pill: 'Generate image',
    icon: 'image',
  },
  video: {
    scaffold: 'Generate a video of ',
    pill: 'Generate video',
    icon: 'video',
  },
  motion: {
    scaffold: 'Create a motion-graphics animation of ',
    pill: 'Motion graphics',
    icon: 'motion',
  },
  perception: {
    scaffold: 'Find and segment ',
    pill: 'Find / segment',
    icon: 'search',
  },
};
