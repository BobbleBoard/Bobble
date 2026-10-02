/**
 * Context-overflow recovery (the user, 2026-07-24): llama-server rejects a prompt
 * that exceeds its `n_ctx` with an HTTP 400 `exceed_context_size_error`, e.g.
 *
 *   {"error":{"code":400,"message":"request (32978 tokens) exceeds the available
 *    context size (32768 tokens), try increasing it","type":
 *    "exceed_context_size_error","n_prompt_tokens":32978,"n_ctx":32768}}
 *
 * Two things must NEVER happen when this fires:
 *   1. the raw JSON blob must not reach the chat (see stream.ts / cleanProviderError);
 *   2. the turn must not hard-fail — we recover by TRIMMING context and retrying.
 *
 * Recovery lives in the PROVIDER (the layer we own, closest to the error) rather
 * than in pi's compaction: the provider holds the full {@link Context} and can
 * re-issue the request transparently, so pi never sees the overflow and its
 * "compaction failed" path is bypassed entirely.
 *
 * The bulk of an overflowing prompt is almost always accumulated TOOL RESULTS —
 * a session that ran a stack of `find` / `grep` / `read` calls and dumped their
 * output into the history. So we drop the OLDEST tool results first (they're the
 * stalest, and typically the biggest exploration dumps), replacing each with a
 * short placeholder, while preserving every user message and the most recent
 * turns. The caller loops, re-reading the fresh token counts the server reports
 * on each retry, until the request fits or nothing is left to trim.
 *
 * All functions here are PURE (the {@link Context} is copied, never mutated) so
 * they unit-test without a live server.
 */
import type { Context, Message, TextContent, ToolResultMessage } from '@mariozechner/pi-ai';

/** Conservative chars-per-token for mixed code/CLI output — matches the harness
 * tool-output truncator. A low ratio over-counts tokens, so we trim a touch more
 * than strictly needed (safe: overshooting the trim just leaves more headroom). */
const CHARS_PER_TOKEN = 4;

/** Extra tokens to free BEYOND the raw overshoot, so the trimmed prompt leaves
 * room for the model's reply (and absorbs our char-estimate slop). */
export const REPLY_MARGIN_TOKENS = 2_048;

/** Hard cap on trim→retry passes, so a pathological prompt can't loop forever.
 * Each pass strips more tool results; in practice one or two passes suffice. */
export const MAX_OVERFLOW_RETRIES = 6;

/** Replacement text for a dropped tool result. Kept tiny + recognizable so a
 * later pass skips an already-trimmed result (idempotent) and the model still
 * sees that a tool ran here. */
export const OVERFLOW_TRIM_PLACEHOLDER = '[earlier tool output trimmed to fit context]';

/** Parsed shape of a llama-server context-overflow error. */
export interface ContextOverflow {
  /** The server's configured context window (`n_ctx`). */
  readonly nCtx: number;
  /** How many tokens the rejected prompt was (`n_prompt_tokens`). */
  readonly nPromptTokens: number;
}

/** ~token count of a string (chars / {@link CHARS_PER_TOKEN}, rounded up). Pure. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Detect + parse a llama-server context-overflow error from an HTTP error body.
 * Reads the structured `exceed_context_size_error` fields first (robust to key
 * order), then falls back to the human message's token counts. Returns
 * `undefined` for any other error, so the caller only enters recovery for a real
 * overflow. Pure.
 */
export function parseContextOverflow(body: string): ContextOverflow | undefined {
  // Structured form: {"error":{"type":"exceed_context_size_error","n_ctx":…,
  // "n_prompt_tokens":…}} (the error object may also be at the top level).
  try {
    const parsed = JSON.parse(body) as {
      error?: Record<string, unknown>;
      type?: unknown;
      n_ctx?: unknown;
      n_prompt_tokens?: unknown;
    };
    const err = (parsed.error ?? parsed) as Record<string, unknown>;
    const looksOverflow =
      err.type === 'exceed_context_size_error' ||
      (typeof err.n_ctx === 'number' && typeof err.n_prompt_tokens === 'number');
    if (looksOverflow) {
      const nCtx = Number(err.n_ctx);
      const nPromptTokens = Number(err.n_prompt_tokens);
      if (nCtx > 0 && nPromptTokens > 0) return { nCtx, nPromptTokens };
    }
  } catch {
    // not JSON — fall through to the message-text regex
  }
  // Message-text fallback: "request (32978 tokens) exceeds the available context
  // size (32768 tokens)". Guards against a future server that drops the fields.
  const m = body.match(
    /\((\d+)\s*tokens?\)\s*exceeds the available context size\s*\((\d+)\s*tokens?\)/i,
  );
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const nPromptTokens = Number(m[1]);
    const nCtx = Number(m[2]);
    if (nCtx > 0 && nPromptTokens > 0) return { nCtx, nPromptTokens };
  }
  return undefined;
}

/** Concatenated text of a tool-result message's text parts. Pure. */
function toolResultText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** A tool-result message with its text replaced by `text` (other fields kept).
 * Drops any image parts too — a tool result big enough to trim is text, and an
 * inline image is exactly the kind of bulk an overflowing prompt can't afford. */
function replaceToolResultText(msg: ToolResultMessage, text: string): ToolResultMessage {
  return { ...msg, content: [{ type: 'text', text }] };
}

/** Result of one {@link trimContextForOverflow} pass. */
export interface TrimResult {
  /** A new context with oldest tool results replaced by the placeholder (the
   * input is returned unchanged when nothing was trimmable). */
  readonly context: Context;
  /** Estimated tokens freed this pass. */
  readonly removedTokens: number;
  /** How many tool results were replaced. */
  readonly trimmedCount: number;
}

/** What a dropped screenshot leaves behind. Says WHY, so a model that wonders
 * where the picture went is told rather than left to infer it was never there. */
export const STALE_SHOT_PLACEHOLDER =
  '[screenshot removed — it showed the screen as it was several actions ago, ' +
  'which is no longer what is there. Take a fresh one if you need to look.]';

/** How many of the most recent screenshots are worth keeping. */
export const KEEP_RECENT_SHOTS = 1;

/**
 * DROP SCREENSHOTS THAT HAVE STOPPED BEING TRUE.
 *
 * Not an overflow measure — this runs on every request, because an old
 * screenshot is WRONG as well as expensive. It shows a screen that has since
 * been clicked, typed into and navigated away from, and the model has to reason
 * about which of five pictures is the current one.
 *
 * The cost is the reason it was found. MEASURED on two runs of the same Maps
 * task on the same build, differing only in how many screenshots the model
 * happened to take:
 *
 *   1 screenshot  → 42 ingests, 3 over 2s, worst 3.5s
 *   12 screenshots → 31 ingests, 14 over 2s, worst 51.1s
 *
 * and the second run's prefill grew monotonically — 0.5s, 1.0s, 2.5s, 3.0s,
 * 3.7s, 4.3s, 5.0s, 5.8s, 7.0s — because every turn re-ingests every picture
 * taken so far. A screenshot is ~200KB and on the order of a thousand vision
 * tokens; keeping twelve of them makes a computer-use conversation quadratic in
 * the number of looks.
 *
 * This was hiding behind a power-mode question. It is not a power problem: the
 * same task in "low power" was FASTER, because it took one screenshot.
 *
 * Pure, and idempotent — an already-placeholdered result has no image left to
 * drop, so repeated passes are no-ops.
 */
export function dropStaleScreenshots(context: Context, keep = KEEP_RECENT_SHOTS): TrimResult {
  const withImages: number[] = [];
  context.messages.forEach((msg, i) => {
    if (msg.role !== 'toolResult') return;
    if (msg.content.some((c) => c.type === 'image')) withImages.push(i);
  });
  // The newest `keep` stay exactly as they are.
  const stale = withImages.slice(0, Math.max(0, withImages.length - keep));
  if (stale.length === 0) return { context, removedTokens: 0, trimmedCount: 0 };

  const out: Message[] = context.messages.slice();
  let removed = 0;
  for (const i of stale) {
    const msg = out[i];
    if (msg === undefined || msg.role !== 'toolResult') continue;
    const kept = msg.content.filter((c) => c.type !== 'image');
    const text = toolResultText(msg);
    /* The TEXT of the result is kept — it is the indexed element list, which is
       small and still tells the model what was on screen. Only the picture goes. */
    out[i] = {
      ...msg,
      content: [
        ...(kept.length > 0 ? kept : [{ type: 'text' as const, text }]),
        { type: 'text' as const, text: STALE_SHOT_PLACEHOLDER },
      ],
    };
    // A screenshot at point size costs on the order of a thousand vision tokens;
    // the exact number is the model's business, so this is deliberately a floor.
    removed += 1000;
  }
  return {
    context: { ...context, messages: out },
    removedTokens: removed,
    trimmedCount: stale.length,
  };
}

/** What a tool call's long argument becomes: its size, so the model knows what it wrote. */
export function elidedArgument(chars: number): string {
  return `[${chars} chars elided to fit context]`;
}
const ELIDED = /^\[\d+ chars elided to fit context\]$/;

/** What an older thought becomes once tool output alone could not make room. */
export const OVERFLOW_THOUGHT_PLACEHOLDER = '[earlier thinking trimmed to fit context]';

/** An argument shorter than this is the call's meaning (a path, a command), not its bulk. */
const ARG_KEEP_CHARS = 400;

/** A tool call's arguments with every long string (at any depth) elided; null when none was. */
function elideArguments(
  value: unknown,
  depth = 0,
): { value: unknown; freed: number; count: number } | null {
  if (typeof value === 'string') {
    if (value.length <= ARG_KEEP_CHARS || ELIDED.test(value)) return null;
    const placeholder = elidedArgument(value.length);
    return {
      value: placeholder,
      freed: estimateTokens(value) - estimateTokens(placeholder),
      count: 1,
    };
  }
  if (depth >= 3 || value === null || typeof value !== 'object') return null;
  const entries = Array.isArray(value)
    ? value.map((v, i) => [i, v] as const)
    : Object.entries(value as Record<string, unknown>);
  let out: unknown[] | Record<string, unknown> | null = null;
  let freed = 0;
  let count = 0;
  for (const [key, v] of entries) {
    const r = elideArguments(v, depth + 1);
    if (r === null) continue;
    out ??= Array.isArray(value) ? value.slice() : { ...(value as Record<string, unknown>) };
    (out as Record<string | number, unknown>)[key] = r.value;
    freed += r.freed;
    count += r.count;
  }
  return out === null ? null : { value: out, freed, count };
}

/**
 * Free ~`tokensToRemove` tokens from `context`, oldest first, stopping as soon
 * as the target is met. First the OLDEST not-yet-trimmed tool results become
 * {@link OVERFLOW_TRIM_PLACEHOLDER} — stale tool output is usually the bulk.
 *
 * When it is not — MEASURED (Ling 3.0 Tiny, 32k window, 2026-10-01): three
 * attempts at writing a hand-drawn SVG, each ~4k tokens of ARGUMENTS, each
 * refused in two lines, and the chat could never send again ("too long … even
 * after trimming older tool output") — the long arguments of older tool calls
 * are elided (their size kept, so the model knows what it wrote), then older
 * thoughts. User messages are never touched, nor the last assistant message
 * (the step the model is on). Pure — returns a fresh context, never mutates.
 *
 * Idempotent across passes: what was already replaced is skipped, so a caller
 * can loop (trim → retry → trim more) and each pass makes real progress until
 * nothing trimmable is left.
 */
export function trimContextForOverflow(context: Context, tokensToRemove: number): TrimResult {
  if (tokensToRemove <= 0) return { context, removedTokens: 0, trimmedCount: 0 };

  const placeholderTokens = estimateTokens(OVERFLOW_TRIM_PLACEHOLDER);
  const out: Message[] = context.messages.slice();
  let removed = 0;
  let trimmedCount = 0;

  // Oldest-first: index 0 is the start of the conversation. Preserving recent
  // turns means we shed from the front and stop the moment we've freed enough.
  for (let i = 0; i < out.length && removed < tokensToRemove; i++) {
    const msg = out[i];
    if (msg === undefined || msg.role !== 'toolResult') continue;
    const text = toolResultText(msg);
    if (text === OVERFLOW_TRIM_PLACEHOLDER) continue; // already trimmed on a prior pass
    const cost = estimateTokens(text);
    if (cost <= placeholderTokens) continue; // nothing meaningful to reclaim
    out[i] = replaceToolResultText(msg, OVERFLOW_TRIM_PLACEHOLDER);
    removed += cost - placeholderTokens;
    trimmedCount++;
  }

  // Then what the model itself carried: older calls' long arguments, older thoughts.
  let lastAssistant = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  for (let i = 0; i < out.length && removed < tokensToRemove; i++) {
    const msg = out[i];
    if (msg === undefined || msg.role !== 'assistant' || i === lastAssistant) continue;
    let changed = false;
    const content = msg.content.map((block) => {
      if (removed >= tokensToRemove) return block;
      if (block.type === 'toolCall') {
        const r = elideArguments(block.arguments);
        if (r === null) return block;
        removed += r.freed;
        trimmedCount += r.count;
        changed = true;
        return { ...block, arguments: r.value as Record<string, unknown> };
      }
      if (
        block.type === 'thinking' &&
        block.thinking.length > ARG_KEEP_CHARS &&
        block.thinking !== OVERFLOW_THOUGHT_PLACEHOLDER
      ) {
        removed += estimateTokens(block.thinking) - estimateTokens(OVERFLOW_THOUGHT_PLACEHOLDER);
        trimmedCount += 1;
        changed = true;
        return { ...block, thinking: OVERFLOW_THOUGHT_PLACEHOLDER };
      }
      return block;
    });
    if (changed) out[i] = { ...msg, content };
  }

  if (trimmedCount === 0) return { context, removedTokens: 0, trimmedCount: 0 };
  return { context: { ...context, messages: out }, removedTokens: removed, trimmedCount };
}

/**
 * A short, human, NON-RAW message for a provider error that reached the chat.
 * We never surface the HTTP status + JSON body verbatim — that blob is log-only.
 * An overflow that survived recovery (retries exhausted / nothing left to trim)
 * gets its own guidance; anything else gets a generic retry nudge. Pure.
 */
export function cleanProviderError(status: number, overflow: ContextOverflow | undefined): string {
  if (overflow !== undefined) {
    return "This conversation is too long for the model's context window, even after trimming older tool output. Start a new chat or switch to a larger-context model.";
  }
  return `The local model server returned an error (HTTP ${status}). Please try again.`;
}
