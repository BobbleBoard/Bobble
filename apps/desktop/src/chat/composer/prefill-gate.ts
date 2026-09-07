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

export interface PrefillInputs {
  /** The harness's canonical system prompt, as published. */
  readonly system: unknown;
  /** The harness's tool list as a JSON string, as published. */
  readonly toolsJson: unknown;
  /** Is a model server actually up? */
  readonly serverRunning: boolean;
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
   * Is there anything worth priming? An attachment over the threshold, or a
   * conversation with something in it — or an empty chat that the window has
   * just come back to, where the whole prefix may have been reclaimed while the
   * app was away.
   */
  const worth =
    input.prefixChars >= input.minPrefixChars || input.historyTurns > 0 || input.focusEpoch > 0;
  if (!worth) return { prime: false, because: 'nothing fixed to prime' };
  return { prime: true, tools };
}
