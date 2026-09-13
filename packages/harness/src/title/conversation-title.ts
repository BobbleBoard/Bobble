/**
 * The conversation title — a CACHE-REUSING piggyback on the main model.
 *
 * This used to be half of a tier-2 TASK CLASSIFIER: one grammar-constrained
 * `{title, class}` call that named the conversation and guessed what kind of
 * task it was. The class half is gone (see presets/presets.ts) — nothing read it
 * but a tool table that no longer exists. The title is a real feature and the
 * cache trick underneath it is the valuable part, so both are kept.
 *
 * ## Why a piggyback (round-10 #8)
 * The old path sent a SEPARATE prompt to the same single-slot (`--parallel 1`)
 * llama-server. That prompt shared almost no prefix with the live conversation,
 * so it was itself a cache miss AND — being the only slot — it evicted the
 * conversation's KV, forcing the real turn to reprocess the whole transcript. A
 * double penalty on every naming.
 *
 * Instead we send `{ messages: [...live conversation prefix, {short JSON ask}] }`.
 * The prefix (system + full transcript, ending at the current user prompt) is
 * IDENTICAL to what the real turn will process, so the slot's KV for it is
 * primed/kept; only the short instruction + a ~10-token JSON answer are new.
 * Naming becomes a cache PRE-WARM, not a cost.
 *
 * ## Grammar-constrained title
 * The output is constrained to `{"title": string}` via `response_format:
 * {type:"json_schema", …}` — reachable through the frozen OpenAI-compat seam and
 * compiled to a grammar by llama-server, so even a ~2B model returns a
 * guaranteed-parseable object.
 *
 * ## App hook
 * Titling activates automatically once a utility endpoint is configured
 * (`PI_DESKTOP_UTILITY_BASE_URL`, see model-call/call-model.ts) — the same seam
 * the fixer/review use. Absent endpoint ⇒ no titles, and nothing else changes.
 */

import type { CallModel } from '../model-call/call-model.js';

/** One message of the live conversation prefix this request rides on. */
export interface TitleMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** What the titler needs: the prompt, the live prefix, and the turn's tools. */
export interface TitleInput {
  readonly prompt: string;
  readonly turnIndex?: number;
  /** [system, …prior turns, current user prompt] — the prefix to share. */
  readonly priorMessages?: readonly TitleMessage[];
  /**
   * The turn's tools, in the turn's order. Carried so this request's prefix
   * ([system][tools][convo]) matches the resident slot EXACTLY — without them it
   * re-prefills the whole conversation and evicts the tool KV.
   */
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  }[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Resolves to the title, or undefined on any failure (fail-open). */
export type ConversationTitler = (input: TitleInput) => Promise<{ title: string } | undefined>;

/** Max characters for the model-produced conversation title. */
const TITLE_MAX_CHARS = 60;

/**
 * Token cap for the reply. The output is a ~10-token JSON object, but a reasoning
 * model may "think" first — this leaves headroom so it still reaches the JSON if
 * thinking isn't suppressed (see {@link NO_THINKING}). It's a cap, not a target:
 * with thinking off the decode stops at the closing brace in a handful of tokens.
 */
const MAX_TOKENS = 512;

const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } } as const;

/**
 * The short instruction appended AFTER the shared conversation prefix. Kept tiny
 * so only a handful of uncached tokens follow the (reused) transcript.
 */
const HEADER_INSTRUCTION = [
  'Before continuing, respond with ONLY a JSON object naming this conversation',
  "after what the user asked for — the user's topic or task, in 3-6 words:",
  '{"title": "<3-6 words: the user\'s topic or task>"}',
  'Output the JSON object and nothing else.',
].join('\n');

/**
 * Titles that name nothing: the instruction's own words handed back, or a stock
 * placeholder. SEEN 2026-09-13 with MiniCPM5 2B — a chat about running a shell
 * command sat in the sidebar as "Conversation Title". A reply like this is no
 * title (the caller keeps the first-message summary), and the instruction above
 * now says what the title is ABOUT so a small model has something to name.
 */
const GENERIC_TITLES = new Set([
  'conversation title',
  'conversation',
  'title',
  'chat title',
  'chat',
  'new chat',
  'untitled',
  'topic or task',
  'the users topic or task',
]);

function isGenericTitle(title: string): boolean {
  const norm = title
    .toLowerCase()
    .replace(/[<>"'`.!?:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return norm.length === 0 || GENERIC_TITLES.has(norm) || /^(?:a )?3-6 words?\b/.test(norm);
}

/**
 * A JSON-schema response format constraining the reply to exactly `{title}`.
 * llama-server (and other OpenAI-compat servers) compile this to a decoding
 * grammar, guaranteeing a parseable object from a small model.
 */
function titleResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'pi_conversation_title',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', maxLength: TITLE_MAX_CHARS } },
        required: ['title'],
      },
    },
  };
}

/**
 * Parse `{title}` out of the model reply. Tolerates prose around the JSON (a
 * small model may still wrap it) by extracting the first balanced object.
 */
export function parseTitle(text: string): string | undefined {
  const raw = extractFirstJsonObject(text);
  if (raw === undefined) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    return title.length > 0 && !isGenericTitle(title) ? title : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the first balanced `{…}` substring, or undefined. */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Build a {@link ConversationTitler} that piggybacks a grammar-constrained
 * `{title}` request on the live conversation prefix (see file header).
 */
export function createConversationTitler(callModel: CallModel): ConversationTitler {
  return async (input) => {
    // Share the exact live conversation prefix. `priorMessages` is
    // [system, …prior turns, current user prompt]; the only new tokens are the
    // short instruction + the tiny JSON answer, so the slot's KV is reused.
    const prefix: TitleMessage[] = input.priorMessages
      ? [...input.priorMessages]
      : // No transcript available (e.g. a programmatic caller) → fall back to the
        // bare prompt so we still return a usable title.
        [{ role: 'user', content: input.prompt }];
    const messages = [...prefix, { role: 'user' as const, content: HEADER_INSTRUCTION }];

    let text: string;
    try {
      text = await callModel({
        messages,
        temperature: 0,
        maxTokens: MAX_TOKENS,
        responseFormat: titleResponseFormat(),
        extraBody: NO_THINKING,
        // Carry the turn's tools so this request's prefix ([system][tools][convo])
        // matches the resident slot exactly — otherwise it re-prefills the whole
        // conversation and evicts the tool KV (see TitleInput.tools).
        ...(input.tools !== undefined && input.tools.length > 0 ? { tools: input.tools } : {}),
        // Fire-and-forget naming opts into a longer timeout than the tight default
        // (a warm reasoning model can still spend a few seconds before the JSON).
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        // The user sending their next message cancels this — it is background
        // work about a finished turn, and it is sitting on the only slot.
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch {
      return undefined;
    }

    const title = parseTitle(text);
    return title === undefined ? undefined : { title };
  };
}
