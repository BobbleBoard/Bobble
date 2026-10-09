/**
 * WHEN IT IS SAFE TO PRIME, and — the part that matters — when it is NOT.
 *
 * A prefill writes a rendered prompt PREFIX into llama-server's single slot.
 * That is worth doing when the prefix is a true prefix of the turn that follows,
 * and actively harmful when it is not: the slot holds one sequence, so priming
 * the wrong thing EVICTS the right thing. A prime that diverges from the real
 * turn at token 20 does not merely fail to help, it turns a fully-cached turn
 * into a full re-prefill.
 *
 * MEASURED, and this is why the file exists: an empty chat, primed on a window
 * return, came back `reused 20 of 9750` — a complete re-read of a prompt that
 * had been resident a moment earlier. The prime had rendered `[system]` with no
 * tools, because the harness had not published its tool list for that session
 * yet; chat templates render tools at the START, so the two prompts parted
 * company in the first line and the slot was left holding the wrong one.
 *
 * The rule that follows is small and absolute: prime only what you can render
 * exactly as the turn will render it. Both halves of the prefix, or neither.
 */

/**
 * Below this many characters an attachment is not worth priming on its own —
 * its send already prefills near-instantly against the warm [system][tools].
 *
 * It lives HERE, in the pure gate, because three surfaces now read it and they
 * must not disagree: the prefill hook (what to prime), the composer chips
 * (which show a spinner instead of a token count) and the chips on a message
 * that has already been sent (sent-prefill.ts).
 */
export const PREFILL_MIN_CHARS = 400;

export interface PrefillInputs {
  /** The harness's canonical system prompt, as published. */
  readonly system: unknown;
  /** The harness's tool list as a JSON string, as published. */
  readonly toolsJson: unknown;
  /** Is a model server actually up? */
  readonly serverRunning: boolean;
  /** Is it parked — its process stopped while its URL is kept (LlmStatus.parked)? */
  readonly parked?: boolean;
  /** Is a turn using the slot right now? */
  readonly busy: boolean;
  /** Characters of fixed attachment prefix (0 when nothing is attached). */
  readonly prefixChars: number;
  /** Turns already in the conversation. */
  readonly historyTurns: number;
  /** How many times the window has come back into view. */
  readonly focusEpoch: number;
  /** Below this an attachment is not worth priming on its own. */
  readonly minPrefixChars: number;
}

export type PrefillDecision =
  | { readonly prime: false; readonly because: string }
  | { readonly prime: true; readonly tools: { name: string }[] };

/**
 * Decide whether to prime, and hand back the parsed tools when the answer is
 * yes — so the caller cannot prime with a tool list it never successfully read.
 */
export function prefillDecision(input: PrefillInputs): PrefillDecision {
  if (!input.serverRunning) return { prime: false, because: 'no model server' };
  // Unloaded (idle, or making room): there is no process to read the prompt
  // into. The prime runs again the moment it is back (`parked` is in the hook's
  // signature), which is the point of loading it on the first keystroke.
  if (input.parked === true) return { prime: false, because: 'the model is unloaded' };
  if (input.busy) return { prime: false, because: 'a turn is using the slot' };
  if (typeof input.system !== 'string' || input.system.length === 0) {
    return { prime: false, because: 'no system prompt published yet' };
  }
  /*
   * NO TOOLS, NO PRIME. This is the whole point of the module — see the header.
   * An unparseable or empty list is the same case as an absent one: whatever we
   * would render, the turn will not begin with it.
   */
  let tools: { name: string }[];
  try {
    const parsed: unknown = JSON.parse(input.toolsJson as string);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { prime: false, because: 'the turn tools are not known yet' };
    }
    tools = parsed as { name: string }[];
  } catch {
    return { prime: false, because: 'the turn tools are not known yet' };
  }

  /*
   * AN EMPTY CHAT IS NEVER PRIMED FROM HERE, and this one was learned twice.
   *
   * Its whole prefix is [tools][system], which the HARNESS already makes
   * resident on every model load and session start — through `warmSystemPrompt`,
   * which goes down the same `/v1/chat/completions` path a real turn does. This
   * hook primes over raw `/completion` with a hand-rendered prefix instead
   * (necessary for a long conversation: the closed chat shape only reuses
   * partially), and for an empty chat that second rendering has nothing to add
   * and one way to be wrong.
   *
   * It WAS primed on a window return for a while, added to mitigate a long-idle
   * problem that could not be reproduced. MEASURED afterwards: 18 minutes idle
   * keeps 100% reuse without it, and a blank chat primed on a return came back
   * `reused 41 of 9771` — the prime had replaced a perfectly good prefix with
   * one that diverged 41 tokens in. A mitigation for a problem nobody could
   * reproduce, causing the problem it was named after.
   *
   * A chat WITH history still re-primes on a return (measured: it reuses), and
   * so does an attachment over the threshold.
   */
  const worth = input.prefixChars >= input.minPrefixChars || input.historyTurns > 0;
  if (!worth) return { prime: false, because: "an empty chat is the warm-up's job" };
  return { prime: true, tools };
}
