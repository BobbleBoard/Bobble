/**
 * What this app can do, said by the APP.
 *
 * From the blind test: asked "what can you actually do?", the model answered
 * with `ask_user`, `update_plan`, `spawn_subagent`, `talk_to_manager`. The
 * tester: "That's internal machinery. It's like asking a colleague what they do
 * and being told 'I can hold meetings and delegate.'"
 *
 * Her conclusion, which is the design here: the answer to "what can you do?"
 * should not come from the model at all. The model is the wrong source — it is
 * describing its own plumbing, and it is always one refactor from being wrong
 * about itself. So this list is product copy, hand-written, sitting on the
 * opening screen where it is read BEFORE the question gets asked.
 *
 * Each one is a real sentence a person would type, not a category. A chip that
 * says "Writing" teaches nothing; a chip that fills the box with "Draft a short
 * announcement email for a product launch" shows the shape of a request.
 */

export interface Starter {
  /** The chip's own words — four or five, readable at a glance. */
  label: string;
  /** What lands in the composer. A whole request, editable before sending. */
  prompt: string;
  /** Which icon the chip carries (resolved in the component). */
  icon: 'write' | 'search' | 'image' | 'file';
}

export const STARTERS: readonly Starter[] = [
  {
    label: 'Write something',
    prompt: 'Draft a short, friendly announcement email for a product launch.',
    icon: 'write',
  },
  {
    label: 'Look something up',
    prompt: 'Search the web and summarise what changed recently in EU packaging rules.',
    icon: 'search',
  },
  {
    label: 'Make an image',
    prompt: 'Make an image of a cosy neighbourhood coffee shop at sunrise.',
    icon: 'image',
  },
  {
    label: 'Work with a file',
    prompt: 'Read a file on my Mac and turn it into a short summary I can send.',
    icon: 'file',
  },
] as const;
