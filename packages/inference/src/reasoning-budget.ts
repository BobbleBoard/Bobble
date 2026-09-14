/**
 * The reasoning budget's last words. Pure — shared by the llama-server launch
 * (`--reasoning-budget-message`) and the renderer's settings contract, so it
 * carries no Node imports.
 */

/**
 * What the model reads when a reasoning budget runs out, in its own voice, so
 * the thought ends in a decision to act rather than a dropped sentence. The
 * budget itself is off by default (`--reasoning-budget -1`: no cap on
 * thinking); this is only for a user who sets one. the user's wording.
 */
export const REASONING_BUDGET_MESSAGE =
  "I've been thinking too long, let me try to act on something now, before I decide if I should keep thinking.";
