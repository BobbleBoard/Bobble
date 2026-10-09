/**
 * The thinking cap: how much a reasoning model may think on one step, and the
 * words that end the thought when it runs out. Pure — shared by the llama-server
 * launch (`--reasoning-budget-message`), the per-request body the providers
 * build (`thinking_budget_tokens` + `reasoning_budget_message`) and the
 * renderer's settings contract, so it carries no Node imports.
 *
 * The user (2026-10-09): "cap thinking but put a clever 'thinking end message'
 * … the thing that injects something to make it cut off more naturally like
 * 'i've been thinking a while now, I have to stop and just do something' …
 * that message is mandatory". Before this the budget was off (`-1`) and the
 * 27B could think through its whole output budget and stop on `length` with no
 * reply at all.
 */

/**
 * What the model reads when its thinking budget runs out, in its own voice, so
 * the thought ends in a decision to act rather than a dropped sentence.
 *
 * - It opens on a blank line: llama.cpp splices it in wherever the budget runs
 *   out, mid-word as often as not ("…Travel" + message, measured on the 4B).
 * - It closes the matter. The old line ended "before I decide if I should keep
 *   thinking", an invitation to go on thinking that the template has just
 *   taken away.
 * - It names no particular kind of action, so it reads right before an answer
 *   and before a tool call alike (measured: the 4B, cut at 80 tokens, went
 *   straight to a correct `bash` call).
 */
export const REASONING_BUDGET_MESSAGE =
  "\n\nOkay, I've been thinking about this for a long while now. I have enough to go on, so I'll stop here and act on the best plan I have.\n";

/** No single step thinks past this, whatever the window: a model 16k tokens deep
 * into one thought is circling, and at a 27B's ~10 tok/s that is half an hour. */
export const THINKING_BUDGET_CEILING = 16_384;
/** Never less than this: a cap of a few dozen tokens is no thought at all. */
export const THINKING_BUDGET_FLOOR = 512;

export interface ThinkingBudgetInput {
  /** The model's context window in tokens. */
  readonly contextWindow: number;
  /** The request's output cap (`max_tokens`), when there is one. */
  readonly maxTokens?: number;
  /** Characters of everything the prompt carries (messages + tool schemas). */
  readonly promptChars: number;
}

/**
 * How many tokens this step may spend thinking: what is left of the window
 * after the prompt (and under the request's own output cap), less room for the
 * reply that has to follow the thought — a tool call that writes a whole file
 * is thousands of tokens, so the reply keeps 30% of what is left, between 1.5k
 * and 8k — then held between {@link THINKING_BUDGET_FLOOR} and
 * {@link THINKING_BUDGET_CEILING}.
 *
 * The prompt is counted at 3 characters a token, which over-counts English and
 * code (closer to 3.5–4): erring that way leaves the reply more room, never
 * less.
 */
export function autoThinkingBudget(input: ThinkingBudgetInput): number {
  const promptTokens = Math.ceil(Math.max(0, input.promptChars) / 3);
  const room = Math.max(0, input.contextWindow - promptTokens);
  const out =
    input.maxTokens !== undefined && input.maxTokens > 0 ? Math.min(input.maxTokens, room) : room;
  const reply = Math.min(8192, Math.max(1536, Math.round(out * 0.3)));
  return Math.max(THINKING_BUDGET_FLOOR, Math.min(THINKING_BUDGET_CEILING, out - reply));
}

/**
 * The message to send: the user's own wording when they set one, otherwise
 * ours — never nothing, because a budget that runs out with no message cuts
 * the thought mid-sentence and the model has no cue to act.
 */
export function thinkingEndMessage(custom?: string | null): string {
  const text = custom?.trim() ?? '';
  if (text.length === 0) return REASONING_BUDGET_MESSAGE;
  return `\n\n${text}\n`;
}
