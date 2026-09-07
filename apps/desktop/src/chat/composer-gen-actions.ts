/**
 * Composer "+" modality force-actions → harness class + prompt scaffold (spec
 * §3.2). Kept in a pure, React-free module so it unit-tests in the node env and
 * stays the single source of truth mapping the UI's {@link GenActionKey} to the
 * keystone `forcedClass` seam.
 *
 * The `forcedClass` is TYPE-checked against the harness's `TaskClass` via a
 * TYPE-ONLY import (the barrel's value graph is renderer-hostile — see
 * auto-router.ts — but its types erase at build), so a plan can never name a
 * class the classifier doesn't have: it's a compile error, not a silent miss.
 */
import type { TaskClass } from '@pi-desktop/harness';
import type { GenActionKey } from '@pi-desktop/ui';

export type { GenActionKey, TaskClass };

export interface GenActionPlan {
  /**
   * The harness task class this force-action pins for the next send. Fed into
   * both the renderer Auto-route classify (via `forcedClass`) and the
   * `/harness preset` toolset pin, so "+ → Generate video" deterministically
   * loads the advanced-video preset no matter how the prompt reads.
   */
  readonly forcedClass: TaskClass;
  /**
   * A tiny prompt scaffold prefilled into the composer editor when the action is
   * chosen. Deliberately plain natural language (NOT a `/slash` lead-in, which
   * would route through pi's command path instead of a normal prompt).
   *
   * It is now the PILL'S PAYLOAD rather than typed text — the words still reach
   * the model exactly as before, but in the box they are one object you can
   * remove with a click. the user: "including for buttons in the + menu no raw text."
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
    forcedClass: '2d-art',
    scaffold: 'Generate an image of ',
    pill: 'Generate image',
    icon: 'image',
  },
  video: {
    forcedClass: 'advanced-video',
    scaffold: 'Generate a video of ',
    pill: 'Generate video',
    icon: 'video',
  },
  motion: {
    forcedClass: 'motion-graphics',
    scaffold: 'Create a motion-graphics animation of ',
    pill: 'Motion graphics',
    icon: 'motion',
  },
  perception: {
    forcedClass: 'perception',
    scaffold: 'Find and segment ',
    pill: 'Find / segment',
    icon: 'search',
  },
};
