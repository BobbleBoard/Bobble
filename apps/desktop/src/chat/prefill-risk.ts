/**
 * SAYING SO BEFORE IT COSTS YOU.
 *
 * the user: "flagged to the user to my face right there whenever anything threatens
 * to cause a full re prefill (including model switches) at over 16k context."
 *
 * Almost everything this app does to keep first-token latency near zero is about
 * NOT throwing away the KV prefix. A few things throw it away unavoidably — and
 * the worst thing the app can do at that moment is stay quiet, because the user
 * then experiences it as the app randomly being slow again. So: when an action
 * would make the model re-read a conversation bigger than the threshold, the app
 * says what it will cost, in tokens and (once it has measured this machine) in
 * seconds, before the action and again while it happens.
 *
 * WHY 16k AND NOT A PERCENTAGE. It is the user's number, and it is a good one: below
 * about that, a re-read is a couple of seconds on this hardware and reads as the
 * model thinking; above it, it is long enough that a person starts wondering
 * whether the app is broken. A percentage of the window would move the warning
 * around whenever the window changed, which is not the thing that hurts.
 */

/** Conversation size, in tokens, at which a re-read is worth interrupting for. */
export const RE_PREFILL_WARN_TOKENS = 16_000;

/** What is about to make the model read everything again. */
export type RePrefillCause =
  | 'model-switch'
  | 'instructions'
  | 'tools'
  | 'compaction'
  | 'edit'
  | 'in-progress';

export interface RePrefillRisk {
  /** Tokens that will have to be read again. */
  readonly tokens: number;
  readonly cause: RePrefillCause;
  /** Seconds on THIS machine, or null when it has not been measured yet. */
  readonly seconds: number | null;
}

/** Whether this is big enough to be worth saying out loud. */
export function worthWarning(tokens: number): boolean {
  return tokens >= RE_PREFILL_WARN_TOKENS;
}

/** "24k" — the size, at the precision a person can act on. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  const k = tokens / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/** "18s" / "1m 20s", or null when there is nothing measured to base it on. */
export function formatSeconds(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const BECAUSE: Record<RePrefillCause, string> = {
  'model-switch': 'a different model has to read this conversation from scratch',
  instructions: 'changing the instructions changes the start of every prompt',
  tools: 'changing the available tools changes the start of every prompt',
  compaction: 'the conversation is being rewritten to fit',
  edit: 'editing an earlier message invalidates everything after it',
  'in-progress': 'the conversation is being read again',
};

/**
 * The sentence shown BEFORE the action — on the control that would cause it.
 * Short, because it rides beside a menu row.
 */
export function riskBadge(risk: RePrefillRisk): string {
  const secs = formatSeconds(risk.seconds);
  return secs === null
    ? `re-reads ${formatTokens(risk.tokens)} tokens`
    : `re-reads ${formatTokens(risk.tokens)} tokens · ~${secs}`;
}

/**
 * The sentence shown WHILE it happens — in the pill above the composer, which is
 * the place the app already uses to say "you are waiting for this".
 */
export function riskSentence(risk: RePrefillRisk): string {
  const secs = formatSeconds(risk.seconds);
  const cost =
    secs === null
      ? `${formatTokens(risk.tokens)} tokens`
      : `${formatTokens(risk.tokens)} tokens, about ${secs}`;
  return `Re-reading the conversation — ${cost}. ${capitalise(BECAUSE[risk.cause])}.`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
