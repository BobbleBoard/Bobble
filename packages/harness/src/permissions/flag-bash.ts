/**
 * Model-backed "scary bash" flagger for reviewer permission mode.
 *
 * The regex rules (permissions/rules.ts) are the always-available first line —
 * fast and offline. When a utility model is configured, this flagger layers a
 * small-model judgment on TOP: it only runs for commands the regex did NOT
 * already flag (see registerPermissions in modes.ts), catching destructive /
 * irreversible commands the static rules miss. It fails open (returns null on
 * any error/timeout) so the gate never wedges on a slow or absent model — the
 * regex fallback still stands.
 *
 * ## IT COSTS THE CONVERSATION'S KV CACHE, so it is asked sparingly
 *
 * the user: "sometimes at random, prefill for a short follow-up message takes upward
 * of 80 seconds where it hadn't earlier in the same chat."
 *
 * The utility endpoint IS the conversation's own llama-server (pi-main points it
 * there deliberately), and that server holds ONE slot. A request with a
 * different prefix — and this one's prefix is a security-reviewer system prompt
 * and a shell command, which shares nothing with the chat — evicts the
 * conversation's resident KV. The next message then pays a full cold prefill.
 * This is the same mechanism that got the post-turn reviewer removed.
 *
 * Two things keep it off the hot path: commands that are unambiguously READS are
 * never sent (the regex already has a view, and "ls" does not need a second
 * opinion), and every verdict is CACHED by command text — an agent re-runs the
 * same build, the same test, the same grep dozens of times per session.
 */

import type { CallModel } from '../model-call/call-model.js';
import type { BashFlagger } from './modes.js';

const SYSTEM_PROMPT =
  'You are a cautious security reviewer for a coding agent. You are shown a single shell ' +
  'command the agent wants to run. Decide whether it is DANGEROUS: destructive, irreversible, ' +
  'exfiltrates data, damages the system, or is otherwise something a careful user would want to ' +
  'approve first. Reply with a SHORT reason (max ~12 words) if it is dangerous, or the single ' +
  'word SAFE if it is fine. Do not explain safe commands.';

/** How long to wait for the model before failing open to the regex rules. */
const FLAG_TIMEOUT_MS = 4000;

/**
 * Commands that read and nothing else, by the name they run under.
 *
 * The point is the COST, not the classification: each of these asked of the
 * model evicts the conversation's KV for an answer that is always "SAFE".
 * Deliberately conservative — only names with no destructive mode at all. `git`
 * is absent (`git reset --hard`, `git push --force`), so is `find` (`-delete`,
 * `-exec`), and anything with a redirection, a pipe into a shell, or a `&&`
 * falls through to the model on the strength of the operator alone.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'grep',
  'rg',
  'pwd',
  'echo',
  'which',
  'type',
  'stat',
  'du',
  'df',
  'date',
  'whoami',
  'uname',
  'env',
  'printenv',
  'basename',
  'dirname',
  'realpath',
]);

/** Shell syntax that can turn a harmless-looking command into anything. */
const SHELL_METACHARACTERS = /[|;&><`$(){}]|\bsudo\b/;

/**
 * Is this command worth a model's opinion (and the conversation's KV cache)?
 *
 * Exported so the cost decision is testable on its own — it is the half of this
 * module that changes how the app FEELS, and it must never quietly widen.
 */
export function needsModelReview(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_METACHARACTERS.test(trimmed)) return true;
  const head = trimmed.split(/\s+/)[0] ?? '';
  // Strip a leading path so `/bin/ls` is judged the same as `ls`.
  const name = head.slice(head.lastIndexOf('/') + 1);
  return !READ_ONLY_COMMANDS.has(name);
}

/** How many verdicts to remember. An agent repeats itself; a session does not
 * run thousands of DISTINCT commands. */
const VERDICT_CACHE_MAX = 256;
/** Cap the reason we surface to the user. */
const MAX_REASON_LEN = 140;

/** Interpret the model's reply: a reason string when flagged, else null. */
export function interpretFlagReply(reply: string): string | null {
  const trimmed = reply.trim();
  if (trimmed.length === 0) return null;
  // "SAFE" (optionally punctuated) → not scary.
  if (/^safe[.!]?$/i.test(trimmed)) return null;
  // Some models answer "DANGEROUS: <reason>" — strip a leading verdict token.
  const reason = trimmed.replace(/^(dangerous|unsafe|risky|scary)\s*[:-]\s*/i, '').trim();
  const text = reason.length > 0 ? reason : trimmed;
  return `flagged by model: ${text.slice(0, MAX_REASON_LEN)}`;
}

/**
 * Build a {@link BashFlagger} backed by the utility model. Returns a reason
 * string when the model judges the command dangerous, or null when it is safe
 * (or on any error/timeout — fail open).
 */
export function createBashFlagger(callModel: CallModel): BashFlagger {
  // Command text → verdict. See the note at the top: every miss costs the
  // conversation a cold prefill, and agents repeat commands constantly.
  const verdicts = new Map<string, string | null>();
  return async (command: string): Promise<string | null> => {
    const trimmed = command.trim();
    if (trimmed.length === 0) return null;
    if (!needsModelReview(trimmed)) return null;
    const cached = verdicts.get(trimmed);
    if (cached !== undefined) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLAG_TIMEOUT_MS);
    try {
      const reply = await callModel({
        system: SYSTEM_PROMPT,
        prompt: `Command:\n${trimmed}`,
        temperature: 0,
        maxTokens: 40,
        signal: controller.signal,
      });
      const verdict = interpretFlagReply(reply);
      if (verdicts.size >= VERDICT_CACHE_MAX) {
        // Oldest first — insertion order is Map's iteration order.
        const oldest = verdicts.keys().next();
        if (!oldest.done) verdicts.delete(oldest.value);
      }
      verdicts.set(trimmed, verdict);
      return verdict;
    } catch {
      // Model unreachable / timed out / aborted → fall back to the regex rules.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
