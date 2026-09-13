import { readFileSync } from 'node:fs';
import { tapRequest } from '@pi-desktop/provider-llamacpp';
/**
 * The "call a model" seam.
 *
 * Several reliability features need a utility model: the rung-2 tool-call fixer,
 * the reviewer/adversarial passes, and the tier-2 classifier escalation. pi's
 * ExtensionAPI exposes no one-shot completion call, so this module defines a
 * small injectable {@link CallModel} async seam plus a default implementation
 * that hits any OpenAI-compatible `/chat/completions` endpoint.
 *
 * ## What the app injects (zero code, env only)
 * The desktop app loads the harness via `-e src/index.ts` (no way to pass a
 * function), and already configures other extensions through env vars. So the
 * utility endpoint is configured the same way — {@link callModelFromEnv} reads:
 *
 *   - `PI_DESKTOP_UTILITY_BASE_URL`  openai-compat base, e.g. the local
 *                                    llama-server (`http://127.0.0.1:PORT/v1`)
 *                                    or a separate small model. NO default —
 *                                    absent ⇒ every model-dependent feature
 *                                    degrades gracefully (fixer skipped, review
 *                                    skipped, classify stays heuristic-only).
 *   - `PI_DESKTOP_UTILITY_MODEL`     model id (default `"utility"`).
 *   - `PI_DESKTOP_UTILITY_API_KEY`   optional bearer token.
 *
 * A programmatic caller (or a future app-bridge) can instead pass a custom
 * `callModel` to `wireHarness(pi, { callModel })`.
 */

/**
 * One message of a utility request, in the OpenAI chat shape the chat provider
 * itself sends — thoughts, tool calls and tool results included. A background
 * request that shares the conversation's prefix must render the SAME bytes as
 * the turn did, or the server's single slot is rewritten from the first
 * difference and the next real turn prefills that tail again (MEASURED
 * 2026-09-13: the titler carried the reply as bare text, so its empty think
 * block replaced the turn's thoughts in the cache — 160 tokens re-prefilled on
 * every second turn of every chat).
 */
export interface UtilityMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  /** The wire content: a string, `null` (an assistant turn that was all tool
   * calls), or OpenAI content parts — passed through untouched. */
  readonly content: string | null | readonly unknown[];
  /** The assistant turn's thoughts, as the provider carries them back. */
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  /** `role: 'tool'` — which call this result answers, and the tool's name. */
  readonly tool_call_id?: string;
  readonly name?: string;
}

/** A single utility-model request. Supply `prompt`, or `messages`, or both. */
export interface CallModelRequest {
  /** Optional system instruction prepended to the message list. */
  readonly system?: string;
  /** A single user prompt (appended after `messages`). */
  readonly prompt?: string;
  /** Explicit multi-turn messages. */
  readonly messages?: readonly UtilityMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * Tool definitions to include in the request (OpenAI `tools`). Used by the
   * WARM-UP so the primed KV prefix matches a real turn's — chat templates render
   * tools at the START of the prompt, so a system-only warm-up reuses NOTHING
   * once the real turn carries tools. Mapped to `{type:'function',function:{…}}`.
   */
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  }[];
  /**
   * OpenAI-compatible `response_format` for constrained/structured decoding,
   * e.g. `{type:'json_schema', json_schema:{…}}`. llama-server compiles this to
   * a grammar, guaranteeing a parseable object from a small model — used by the
   * classify+title piggyback. Ignored by callers that don't set it (the
   * fixer/reviewer). Kept as `unknown` so this seam stays provider-agnostic.
   */
  readonly responseFormat?: unknown;
  /**
   * Extra top-level fields merged into the request body — an escape hatch for
   * provider-specific params the OpenAI schema doesn't cover. The classify+title
   * piggyback uses it to pass llama.cpp's
   * `chat_template_kwargs: {enable_thinking:false}` so a reasoning model doesn't
   * burn its whole token budget "thinking" before emitting the tiny JSON (a ~9×
   * speedup on Gemma E2B: ~350ms vs ~3.2s). Servers that don't know these fields
   * ignore them. Does NOT override the fields this seam sets explicitly.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /**
   * Per-call timeout override (ms). The shared default ({@link DEFAULT_TIMEOUT_MS})
   * is tuned for calls that BLOCK a turn (fixer / reviewer-in-path), so it's
   * deliberately tight. Background, fire-and-forget calls that never block the
   * reply — notably the post-turn conversation NAMING — should pass a larger
   * value: even a warm reasoning model can spend several seconds "thinking" before
   * the tiny JSON, and clipping that at 5s just drops the title. Composed with the
   * default via `AbortSignal.any`, so whichever fires first still wins.
   */
  readonly timeoutMs?: number;
}

/** Call a model and get its text back. Throws on transport/HTTP failure. */
export type CallModel = (req: CallModelRequest) => Promise<string>;

/**
 * Default per-call timeout. Utility-model calls (reviewer / classifier
 * escalation / tool-call fixer) run on paths that BLOCK the agent turn — the
 * escalation is awaited inside `before_agent_start`, so a hung endpoint would
 * mean the turn never starts. A default timeout bounds every call and fails
 * open (mirrors flag-bash's 4s abort). Callers that pass their own `signal`
 * still get it — the two are composed.
 */
const DEFAULT_TIMEOUT_MS = 5000;

export interface OpenAiCompatConfig {
  /** Base URL, e.g. `http://127.0.0.1:8080/v1`. Trailing slash tolerated. */
  readonly baseUrl: string;
  /** Model id sent in the request body. */
  readonly model: string;
  /** Optional bearer token. */
  readonly apiKey?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Default per-call timeout (ms). Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Build a {@link CallModel} that POSTs to an OpenAI-compatible chat endpoint. */
export function createOpenAiCompatCallModel(config: OpenAiCompatConfig): CallModel {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (req) => {
    const messages: Record<string, unknown>[] = [];
    if (req.system !== undefined) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages ?? []) {
      messages.push({
        role: m.role,
        // The provider sends `null` for an assistant turn that was all tool
        // calls; the same bytes must render here.
        content: m.role === 'assistant' && m.content === '' ? null : m.content,
        ...(m.reasoning_content !== undefined && m.reasoning_content.length > 0
          ? { reasoning_content: m.reasoning_content }
          : {}),
        ...(m.tool_calls !== undefined && m.tool_calls.length > 0
          ? { tool_calls: m.tool_calls }
          : {}),
        ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name !== undefined ? { name: m.name } : {}),
      });
    }
    if (req.prompt !== undefined) messages.push({ role: 'user', content: req.prompt });

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey !== undefined && config.apiKey.length > 0) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }
    // Compose the caller's signal (if any) with a timeout so a hung endpoint can
    // never wedge the turn — whichever aborts first wins. A per-request override
    // lets background calls (naming) opt into a longer bound than blocking ones.
    const timeoutSignal = AbortSignal.timeout(req.timeoutMs ?? timeoutMs);
    const signal =
      req.signal !== undefined ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
    const extra = (req.extraBody ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = {
      // Provider-specific extras first so the fields this seam sets always win.
      ...extra,
      model: config.model,
      messages,
      stream: false,
      temperature: req.temperature ?? 0,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.tools !== undefined && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(req.responseFormat !== undefined ? { response_format: req.responseFormat } : {}),
      // The history renders with every turn's think block, as the chat's own
      // requests do (provider-mlx sets the same; llama.cpp has it from
      // --reasoning-preserve) — a caller's own kwargs win.
      chat_template_kwargs: {
        preserve_thinking: true,
        preserved_thinking: true,
        preserve_reasoning: true,
        ...((extra.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}),
      },
    };
    tapRequest(body, 'utility');
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`utility model HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content ?? '';
  };
}

/** Env var the app sets to point at the utility/fixer model endpoint. */
export const UTILITY_BASE_URL_ENV = 'PI_DESKTOP_UTILITY_BASE_URL';
/** Env var for the utility model id. */
export const UTILITY_MODEL_ENV = 'PI_DESKTOP_UTILITY_MODEL';
/** Env var for an optional bearer token. */
export const UTILITY_API_KEY_ENV = 'PI_DESKTOP_UTILITY_API_KEY';

/**
 * A stable path the app REWRITES whenever the local server comes up or changes.
 *
 * The env vars above are a SPAWN-TIME SNAPSHOT, and on a normal app open pi
 * starts BEFORE the model server does — so they are simply absent, this returns
 * undefined, and every consumer (the prefix warm-up above all) is dead for the
 * life of that pi process. The app's own comment already named it: "a server that
 * starts WITHOUT a subsequent pi respawn won't re-point the already-running
 * child until the next spawn."
 *
 * MEASURED, which is why this exists: the system-prompt warm-up never ran in a
 * real session, so a first message paid a full cold prefill — ~12s of
 * "processing" on a question worth a hundred milliseconds. It only ever worked
 * in the probe, which restarts pi AFTER the server is up.
 *
 * Same fix the codebase already uses for vision (`PI_DESKTOP_VISION_FILE`): a
 * live file the child re-reads, rather than a value captured once.
 */
export const UTILITY_FILE_ENV = 'PI_DESKTOP_UTILITY_FILE';

/** The endpoint as the app writes it. */
interface UtilityEndpoint {
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly apiKey?: unknown;
}

/** Read the live endpoint file, or undefined when absent/unreadable/empty. */
export function readUtilityFile(
  file: string,
): { baseUrl: string; model: string; apiKey?: string } | undefined {
  try {
    // Required lazily so this module stays importable where `node:fs` is not
    // (the renderer never imports it today, and this keeps that true).
    const raw = readFileSync(file, 'utf8');
    const json = JSON.parse(raw) as UtilityEndpoint;
    const baseUrl = typeof json.baseUrl === 'string' ? json.baseUrl : '';
    if (baseUrl.length === 0) return undefined;
    const model = typeof json.model === 'string' && json.model.length > 0 ? json.model : 'utility';
    const apiKey =
      typeof json.apiKey === 'string' && json.apiKey.length > 0 ? json.apiKey : undefined;
    return { baseUrl, model, ...(apiKey !== undefined ? { apiKey } : {}) };
  } catch {
    // No server yet, or a half-written file — indistinguishable from "not ready",
    // and both mean the same thing to a caller: try again later.
    return undefined;
  }
}

/**
 * Build the default {@link CallModel} from env config, or `undefined` when no
 * base URL is known (so callers degrade to heuristic-only behavior). Never
 * hardcodes a URL.
 *
 * The env vars win when set (a spawn that already knew the server); otherwise
 * the LIVE FILE is consulted, which is what makes a server that came up after pi
 * usable without respawning the child. Callers that ran before the server
 * existed should call this again rather than caching `undefined` forever.
 */
/**
 * The utility endpoint itself — for a caller that speaks to the server on its
 * own (a Python pipeline handed a base URL) rather than through {@link CallModel}.
 * Same precedence as {@link callModelFromEnv}: the spawn-time env, then the live file.
 */
export function utilityEndpointFromEnv(
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; model: string; apiKey?: string } | undefined {
  const envUrl = env[UTILITY_BASE_URL_ENV];
  if (envUrl !== undefined && envUrl.length > 0) {
    const apiKey = env[UTILITY_API_KEY_ENV];
    return {
      baseUrl: envUrl,
      model: env[UTILITY_MODEL_ENV] ?? 'utility',
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
  }
  const file = env[UTILITY_FILE_ENV];
  if (file === undefined || file.length === 0) return undefined;
  return readUtilityFile(file);
}

export function callModelFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): CallModel | undefined {
  const envUrl = env[UTILITY_BASE_URL_ENV];
  if (envUrl !== undefined && envUrl.length > 0) {
    const model = env[UTILITY_MODEL_ENV] ?? 'utility';
    const apiKey = env[UTILITY_API_KEY_ENV];
    return createOpenAiCompatCallModel({ baseUrl: envUrl, model, apiKey, fetchImpl });
  }
  const file = env[UTILITY_FILE_ENV];
  if (file === undefined || file.length === 0) return undefined;
  const live = readUtilityFile(file);
  if (live === undefined) return undefined;
  return createOpenAiCompatCallModel({ ...live, fetchImpl });
}
