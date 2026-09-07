/**
 * ONE RULE FOR "THIS IS ABOUT TO COST YOU".
 *
 * the user: "flagged to the user to my face right there whenever anything threatens
 * to cause a full re prefill (including model switches) at over 16k context."
 *
 * The list of things that can cause one is longer than it looks — a model
 * switch, an instruction edit, a tool set that changed because the classifier
 * picked a different preset, the network dropping and taking the web tools with
 * it, a compaction. Enumerating them means five places to remember and a sixth
 * added next month that nobody wires up.
 *
 * So this does not enumerate causes. It watches the PREFIX ITSELF — the three
 * things every prompt is built from — and says something whenever one of them
 * changes under a conversation big enough for the re-read to hurt. Whatever
 * causes it, this notices; and the cause is inferred from WHICH part moved,
 * which is also the only honest thing to tell someone.
 */

import type { RePrefillCause } from './prefill-risk';

/** The three parts of a prompt that can change out from under a cached one. */
export interface PrefixIdentity {
  /** Which model's KV this is. */
  readonly modelId: string | null;
  /** The harness's canonical system prompt (its exact text). */
  readonly system: string;
  /** The tool list as published, in render order. */
  readonly toolsJson: string;
}

/** Do we actually know what this prefix is made of? */
function known(id: PrefixIdentity): boolean {
  return id.system.length > 0 && id.toolsJson.length > 0;
}

/** What changed, if anything, and therefore what to call it. */
export function prefixChange(
  before: PrefixIdentity | null,
  after: PrefixIdentity,
): RePrefillCause | null {
  if (before === null) return null;
  /*
   * AN UNKNOWN PREFIX IS NOT A CHANGED ONE.
   *
   * The harness publishes the system prompt and tool list asynchronously, so
   * there is a window at startup — and after a session reset — where they are
   * simply absent. Comparing against "" reads every one of those as an
   * instruction change, which would fire a "re-reading 24k tokens" warning at
   * the very moment nothing has happened. Found by a probe whose baseline was
   * captured a beat too early; the real app hits the same window on a restored
   * conversation.
   */
  if (!known(before) || !known(after)) return null;
  // The model first: it subsumes everything else, and it is the cause a person
  // recognises because they are the one who just pressed it.
  if (before.modelId !== after.modelId && after.modelId !== null) return 'model-switch';
  if (before.system !== after.system) return 'instructions';
  if (before.toolsJson !== after.toolsJson) return 'tools';
  return null;
}

/**
 * Whether a change is worth interrupting for.
 *
 * A tool list that GREW is appended to (the harness keeps it append-only for
 * exactly this reason), so the prompt still shares everything up to the
 * addition — expensive, but not a full re-read, and not worth a warning on its
 * own. A list that SHRANK or was reordered moves everything after the change,
 * which on a tools-first chat template is the whole prompt.
 */
export function toolChangeIsCostly(beforeJson: string, afterJson: string): boolean {
  const names = (json: string): string[] => {
    try {
      const v: unknown = JSON.parse(json);
      return Array.isArray(v) ? v.map((t) => String((t as { name?: unknown }).name ?? '')) : [];
    } catch {
      return [];
    }
  };
  const a = names(beforeJson);
  const b = names(afterJson);
  if (a.length === 0 || b.length === 0) return false;
  // Purely appended: every old name still there, in the same order, at the front.
  const appendedOnly = a.every((name, i) => b[i] === name);
  return !appendedOnly;
}
