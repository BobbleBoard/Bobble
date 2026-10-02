/**
 * llama-server `streamSimple` for pi's `openai-completions` API surface.
 *
 * Owns the RAW llama-server SSE stream *before* pi's built-in parser sees it, so
 * we can (a) extract llama.cpp `timings` → TPS, and (b) run the tool-call repair
 * ladder (rungs 1–2) on malformed function-call JSON before emitting
 * `toolcall_end`. Translates OpenAI-compat chunks into pi's
 * AssistantMessageEventStream exactly per docs/custom-provider.md.
 *
 * Electron-free; `fetchImpl` is injectable so tests feed fixture SSE without a
 * live server.
 */
import { readFileSync } from 'node:fs';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
} from '@mariozechner/pi-ai';
import { type BlindReason, blindNote } from '@pi-desktop/inference/vision-launch';
import {
  cleanProviderError,
  dropStaleScreenshots,
  MAX_OVERFLOW_RETRIES,
  parseContextOverflow,
  REPLY_MARGIN_TOKENS,
  trimContextForOverflow,
} from './context-trim.js';
import { createLiveTpsReporter } from './live-tps.js';
import {
  type RepairRung,
  reconstructToolCallFromContent,
  repairToolCallArguments,
  resolveUnknownToolName,
  type ToolCallFixer,
  type ToolSchemaLike,
  type UnknownToolResolver,
  validateAgainstSchema,
  withoutWrittenToolCall,
} from './repair.js';
import { buildRequestHeaders } from './request-headers.js';
import { tapRequest, tapUsage } from './request-tap.js';
import { settleNote, settleReply } from './settle-reply.js';
import { parseSSE } from './sse.js';

/** llama.cpp per-response `timings` block (structurally == inference's). */
export interface LlamaCppTimings {
  readonly prompt_n?: number;
  /** Prompt tokens the slot's cache already held (b10603+). */
  readonly cache_n?: number;
  readonly prompt_ms?: number;
  readonly prompt_per_second?: number;
  readonly predicted_n?: number;
  readonly predicted_ms?: number;
  readonly predicted_per_second?: number;
}

/**
 * llama-server prompt-processing progress frame, emitted on the streaming SSE
 * during PREFILL (before the first token) when the request opts in with
 * `return_progress: true`. Confirmed present in the b9934 server binary
 * (`prompt_progress` / "Include prompt processing progress events in stream
 * mode"). `processed`/`total` are prompt tokens; `cache` is the reused prefix.
 */
export interface LlamaPromptProgress {
  readonly total?: number;
  readonly cache?: number;
  readonly processed?: number;
  readonly time_ms?: number;
}

/** Normalized prefill progress the {@link LlamaCppStreamDeps.onPromptProgress}
 * seam reports. `fraction` is processed/total clamped to 0..1 (0 when the total
 * is not yet known), so the host can render "Processing N%". */
export interface PromptProgress {
  readonly processed: number;
  readonly total: number;
  readonly fraction: number;
}

/** processed/total → a clamped 0..1 fraction (0 when total is unknown/0). Pure. */
export function promptProgressFraction(p: LlamaPromptProgress): number {
  // llama-server's `prompt_progress` reports total / cache / processed, where
  // `processed` runs from `cache` up to `total`. The honest "how much of the work
  // that ACTUALLY has to happen is done" is the timed fraction (processed − cache)
  // / (total − cache) — the cached prefix is instant, so counting it would make a
  // mostly-cached follow-up jump to ~100% immediately. A fully-cached prompt
  // (nothing left to prefill) is done → 1.
  const total = p.total ?? 0;
  if (total <= 0) return 0; // total unknown / not reported yet → 0 (no divide-by-zero)
  const cache = p.cache ?? 0;
  const processed = p.processed ?? 0;
  const remaining = total - cache;
  if (remaining <= 0) return 1; // fully cached → nothing to prefill → done
  return Math.min(1, Math.max(0, (processed - cache) / remaining));
}

export interface LlamaCppStreamDeps {
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * How long a request waits for a server that refuses the connection to come
   * back (parked to make room, or restarting after a crash) before the refusal
   * is treated as the error it looks like. 0 disables the wait. See fetchWhenBack.
   */
  readonly serverReturnWaitMs?: number;
  readonly serverReturnPollMs?: number;
  /** Rung-2 fixer-model call (optional; injected by W5 harness in prod). */
  readonly fixer?: ToolCallFixer;
  /** W5 rungs 3–5. */
  readonly extraRungs?: readonly RepairRung[];
  /** Called with the final `timings` block — bridge to the supervisor's TPS. */
  readonly onTimings?: (t: LlamaCppTimings) => void;
  /**
   * Called for each prefill progress frame (`prompt_progress`) the server emits
   * before the first token — the seam a host lane forwards to the UI's
   * "Processing N%" indicator. Like {@link onTimings}, the provider only
   * OBSERVES it here (it runs inside pi); surfacing it to the renderer is the
   * host's job. Fires only when the request opts in via `return_progress`.
   */
  readonly onPromptProgress?: (p: PromptProgress) => void;
  /** Called when a tool call needed repair (observability / W5 seam). */
  readonly onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
  /**
   * Live repair wiring resolved at stream time (the harness pushes this via the
   * `pi.events` repair bridge). When present, its `fixer`/`extraRungs`/`onRepair`
   * take precedence over the static ones above, so effort-slider changes and the
   * harness's rungs 3–5 take effect without re-registering the provider. Absent
   * (or returning undefined) → the static deps are used.
   */
  readonly repairProvider?: () =>
    | {
        fixer?: ToolCallFixer;
        extraRungs?: readonly RepairRung[];
        onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
        /**
         * Per-session RELAXED schema lookup (rung-4 relaxation). When the harness
         * has relaxed a tool's schema this session, it returns the looser schema
         * here; the stream validates that tool's args against it instead of the
         * strict `context.tools` schema, so subsequent calls pass at rung 2 rather
         * than re-escalating. Absent / undefined → the strict schema is used.
         */
        relaxedSchemaFor?: (toolName: string) => ToolSchemaLike | undefined;
        /** Prefill fraction (0..1) sink — the harness publishes it on the live
         * turn's status channel (harness-prefill) for the desktop ring, which the
         * static provider deps can't reach (no per-turn ctx here). */
        onPromptProgress?: (fraction: number) => void;
        /** A command line typed as a tool name → the `bash` call that runs it. */
        resolveUnknownTool?: UnknownToolResolver;
      }
    | undefined;
}

/** streamSimple signature required by pi's ProviderConfig. */
export type LlamaCppStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

// --- request building ------------------------------------------------------

interface OAIMessage {
  role: string;
  content?: string | Array<Record<string, unknown>> | null;
  /**
   * Prior-turn <think> trace, fed back so llama-server's `--reasoning-preserve`
   * can re-render it into the prompt (templates with `supports_preserve_reasoning`).
   * Ignored by templates without support, so it's always safe to send.
   */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Can the server this provider talks to actually see an image?
 *
 * Published by the desktop host at spawn (`PI_DESKTOP_VISION`), because the
 * child cannot otherwise know: llama-server launched WITHOUT `--mmproj` accepts
 * a request carrying `image_url` parts and simply cannot decode them. Absent
 * (a plain CLI pi, or any host that doesn't publish it) → assume vision works
 * and change nothing, so this can only ever downgrade a KNOWN-blind server.
 */
export const VISION_STATE_FILE_ENV = 'PI_DESKTOP_VISION_FILE';

export function serverCanSeeImages(
  env: Record<string, string | undefined> = process.env,
  readFileImpl: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): boolean {
  /*
   * READ THE LIVE STATE, NOT A SPAWN-TIME SNAPSHOT.
   *
   * `PI_DESKTOP_VISION` is fixed when a process starts. A SUBAGENT spawns
   * mid-turn — usually before anything has asked for vision — so it inherited
   * `0` and kept it for its whole life, even after the server relaunched
   * multimodal. the user, watching one: "the subagent says it's in 'text only mode'".
   * It was telling the truth about a value that had gone stale.
   *
   * The host rewrites a one-byte file whenever the launch mode changes (same
   * shape as PI_ADV_SAMPLING_FILE), so parent and children alike see the switch.
   * The env var stays the fallback, and an unreadable file means "assume we can
   * see" — which can only ever downgrade a KNOWN-blind server, never the reverse.
   */
  return visionState(env, readFileImpl).canSee;
}

/**
 * The host's vision state: `1`, or `0` with the reason it cannot see —
 * `0:off` (the user switched vision off), `0:model` (no vision at all),
 * `0:engine` (a text-only engine), `0:projector` (could not load). A bare `0`
 * is a host that predates the reasons.
 */
export function visionState(
  env: Record<string, string | undefined> = process.env,
  readFileImpl: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): { canSee: boolean; reason?: BlindReason } {
  const file = env[VISION_STATE_FILE_ENV];
  if (file !== undefined && file.length > 0) {
    try {
      const raw = readFileImpl(file).trim();
      if (!raw.startsWith('0')) return { canSee: true };
      const reason = raw.slice(2);
      return reason === 'off' || reason === 'model' || reason === 'engine' || reason === 'projector'
        ? { canSee: false, reason }
        : { canSee: false };
    } catch {
      // Fall through to the env snapshot.
    }
  }
  return { canSee: !(env.PI_DESKTOP_VISION ?? '1').startsWith('0') };
}

/**
 * What a blind server is told in place of an image — the REASON it cannot see.
 *
 * THE FAILURE THIS REPLACES. Asked to screenshot a page and rebuild it, the 4B
 * captured the image, was handed tokens it had no encoder for, saw nothing, and
 * tried again — four times. So the model is told plainly that the image did not
 * arrive, and why: the user (2026-09-23) kept reading "this model is currently
 * running in TEXT-ONLY mode" on a machine where vision was never switched off —
 * the ENGINE (rapid-mlx on its MTP lane) could not take images. The words now
 * name the cause (inference/vision-launch.ts `blindNote`).
 */
export function unviewableImageNote(reason?: BlindReason): string {
  return blindNote(reason);
}

function contentToOAI(
  content: string | (TextContent | ImageContent)[],
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  const vision = visionState();
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    // A blind server gets an explanation instead of tokens it cannot decode.
    if (!vision.canSee) return { type: 'text', text: unviewableImageNote(vision.reason) };
    return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
  });
}

/**
 * Whether a pi request context carries any image input — the provider-layer
 * "vision needed" detector. Mirrors the composer's `messageNeedsVision` but
 * reads the ACTUAL pi {@link Context}, so it also catches images that arrive via
 * non-composer paths (browser / computer-use screenshots, folded attachments).
 *
 * Pure. The lazy-mmproj policy uses this signal: a caller that can reach the
 * supervisor transitions the llama-server into an `--mmproj` launch BEFORE a
 * vision turn is dispatched, while a pure-text context returns `false` — so a
 * text-only session never triggers a projector load.
 */
export function contextHasImage(context: Context): boolean {
  for (const msg of context.messages) {
    /*
     * TOOL RESULTS COUNT. This read `msg.role !== 'user'` and skipped everything
     * else, which meant the exact images this app generates itself — a browser
     * screenshot, a rendered frame, an image the model just made — could never
     * turn vision on. Only a human dragging a file into the composer could. That
     * is backwards for an agent: the pictures it needs to look at are almost
     * always ones a tool just handed it.
     */
    if (msg.role !== 'user' && msg.role !== 'toolResult') continue;
    const content = msg.content;
    if (typeof content === 'string') continue;
    if (content.some((part) => part.type === 'image')) return true;
  }
  return false;
}

/** Build the OpenAI chat/completions request body from pi's Context. Pure.
 * (What goes over the wire is recorded by `tapRequest` — see request-tap.ts.) */
export function buildChatCompletionsRequest(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  const messages: OAIMessage[] = [];
  if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: contentToOAI(msg.content) });
    } else if (msg.role === 'assistant') {
      const text = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      /*
       * A NAMELESS TOOL CALL IS NOT A TOOL CALL.
       *
       * A turn aborted mid-`tool_calls` used to leave a half-built block in the
       * assistant message — the name arrives in one delta and the arguments in
       * the next, so a pause between them freezes `{ name: '', arguments: {} }`
       * into history. Replayed here it renders as a `tool_calls` entry the chat
       * template cannot name, with no `role:"tool"` result after it: the prompt
       * the model reads is structurally broken exactly where tool-call framing
       * lives, and the next call it emits comes back as prose instead of a
       * structured call. The abort path below no longer produces one; this is the
       * defense for sessions that already carry one on disk.
       */
      const toolCalls = msg.content.filter(
        (c): c is ToolCall => c.type === 'toolCall' && c.name.length > 0,
      );
      // Carry this turn's reasoning back so `--reasoning-preserve` (server) can
      // re-render it into the prompt. Without this the flag has nothing to
      // preserve — llama-server is stateless per request and only sees history
      // we send. No-op for templates that don't support preserved reasoning.
      const reasoning = msg.content
        .filter((c) => c.type === 'thinking')
        .map((c) => (c as { thinking?: string }).thinking ?? '')
        .join('');
      const out: OAIMessage = { role: 'assistant', content: text.length > 0 ? text : null };
      if (reasoning.length > 0) out.reasoning_content = reasoning;
      if (toolCalls.length > 0) {
        out.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(out);
    } else {
      const text = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      messages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: text,
      });
      /*
       * AND THE IMAGES A TOOL RETURNED.
       *
       * This block used to not exist: tool content was filtered to text and every
       * image was dropped on the floor. So `browser_snapshot({screenshot:true})`
       * dutifully captured a PNG, attached it, and the model never saw a pixel —
       * and the image specialist's "LOOK at it, decide what is wrong with it" was
       * an instruction it had no way to follow. Both features were shipped shapes
       * with nothing behind them.
       *
       * They cannot ride in the tool message itself: the OpenAI shape (which
       * llama-server implements) takes a plain string for `role:"tool"`, so an
       * array with an image part is not carried. The portable move is the one
       * below — hand the image over immediately afterwards as a user turn that
       * says where it came from, which every vision-capable chat template renders.
       */
      const images = msg.content.filter((c) => c.type === 'image');
      const vision = images.length > 0 ? visionState() : { canSee: true };
      if (!vision.canSee) {
        // Text-only server: name the tool and explain — with the REASON, as an
        // attached image gets (contentToOAI) — rather than shipping tokens it
        // has no encoder for and letting the model guess why it saw nothing.
        // This is the exact path a browser screenshot takes.
        messages.push({
          role: 'user',
          content: `[image returned by ${msg.toolName}] ${unviewableImageNote(vision.reason)}`,
        });
      } else if (images.length > 0) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[image returned by ${msg.toolName}]`,
            },
            ...images.map((c) => {
              const img = c as { data: string; mimeType: string };
              return {
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.data}` },
              };
            }),
          ],
        });
      }
    }
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // Opt in to llama-server's prefill progress frames (`prompt_progress`) so the
    // UI can show "Processing N%" while a big prompt is still being ingested,
    // before the first token. Ignored by servers that don't support it.
    return_progress: true,
  };
  if (context.tools !== undefined && context.tools.length > 0) {
    body.tools = context.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  return body;
}

// --- streaming -------------------------------------------------------------

interface OAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OAIDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OAIToolCallDelta[];
}
interface OAIChoice {
  delta?: OAIDelta;
  finish_reason?: string | null;
}
interface OAIChunk {
  choices?: OAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  timings?: LlamaCppTimings;
  /** Prefill progress (present on `return_progress` prefill frames, which carry
   * an empty `choices` array — handled before the per-choice delta logic). */
  prompt_progress?: LlamaPromptProgress;
}

interface ToolState {
  contentIndex: number;
  id: string;
  name: string;
  argStr: string;
}

function mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'toolUse' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'toolUse';
  return 'stop';
}

async function readBody(res: Response): Promise<AsyncIterable<Uint8Array>> {
  if (res.body === null) throw new Error('llama-server returned no response body');
  return res.body as unknown as AsyncIterable<Uint8Array>;
}

/** Flatten a `Headers` object to a plain record for pi's `onResponse` hook. Best-
 * effort: a mock/non-standard headers object degrades to an empty record. */
/** How long a request waits for a parked or restarting server (see fetchWhenBack). */
export const SERVER_RETURN_WAIT_MS = 180_000;
export const SERVER_RETURN_POLL_MS = 500;

/** undici's `fetch failed` with ECONNREFUSED (or a reset) underneath: nobody is listening. */
export function isConnectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  let e: unknown = error;
  while (e !== null && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `Headers` → a plain record, because pi's `ProviderResponse` wants one.
 *
 * Exported so the MLX and Apple-FM providers can call the same host hooks
 * without each growing a copy. When the shared engine contract lands this moves
 * with it; until then, one implementation beats three.
 */
export function headersToRecord(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined || typeof headers.forEach !== 'function') return out;
  try {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    // non-standard headers object — best-effort empty record
  }
  return out;
}

/**
 * Create the streamSimple function for a llama-server provider.
 * `deps.fixer` / `deps.onTimings` are the seams W5 and the supervisor wire.
 */
export function createLlamaCppStream(deps: LlamaCppStreamDeps = {}): LlamaCppStreamFn {
  const doFetch = deps.fetchImpl ?? fetch;
  const waitMs = deps.serverReturnWaitMs ?? SERVER_RETURN_WAIT_MS;
  const pollMs = deps.serverReturnPollMs ?? SERVER_RETURN_POLL_MS;
  /**
   * The request, waiting for a server that is on its way back.
   *
   * A connection refused here is not "no model": the app parks the chat
   * server's process to make room for a generation and brings it back on the
   * same port when the picture is done (gen/make-room.ts), and the supervisor
   * respawns a crashed one on the same port too. Either gap is seconds. A turn
   * that failed with "fetch failed" in it would hand the user an error for the
   * app's own housekeeping, so the request waits — polling /health — up to
   * `waitMs`, and only then is the refusal real.
   */
  const fetchWhenBack: typeof doFetch = async (url, init) => {
    try {
      return await doFetch(url, init);
    } catch (error) {
      if (!isConnectionRefused(error) || waitMs <= 0) throw error;
      const health = `${String(url).replace(/\/v1\/chat\/completions$/, '')}/health`;
      const deadline = Date.now() + waitMs;
      // eslint-disable-next-line no-console
      console.log(
        `[pi-llm] server not answering — waiting up to ${Math.round(waitMs / 1000)}s for it to come back`,
      );
      while (Date.now() < deadline) {
        if (init?.signal?.aborted === true) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        try {
          const h = await doFetch(health, { signal: init?.signal ?? null });
          if (h.ok) return await doFetch(url, init);
        } catch {
          // still away
        }
      }
      throw error;
    }
  };

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    void (async () => {
      let textIndex: number | undefined;
      let thinkingIndex: number | undefined;
      const toolStates = new Map<number, ToolState>();
      /**
       * Tool-call blocks that reached `toolcall_end` — i.e. whose arguments are
       * COMPLETE (parsed, or repaired by the ladder). Held by object identity so
       * the abort path can tell a finished call from one still accumulating
       * argument deltas without any index arithmetic.
       */
      const finalizedTools = new Set<ToolCall>();
      let lastTimings: LlamaCppTimings | undefined;
      let finishReason: 'stop' | 'length' | 'toolUse' = 'stop';

      /**
       * Emit `thinking_end` / `text_end` for the blocks this stream opened.
       *
       * Called on BOTH the normal finish and the abort/error path: a stream cut
       * mid-block used to just push `error` and stop, leaving the block it had
       * opened with no closing event at all. Idempotent (a failure raised AFTER
       * the normal close must not double-emit), and it reads `textIndex` /
       * `thinkingIndex` live so the abort path can call it once the aborted
       * content has been pruned and the indices re-based.
       */
      let blocksClosed = false;
      const closeOpenBlocks = (): void => {
        if (blocksClosed) return;
        blocksClosed = true;
        if (thinkingIndex !== undefined) {
          const block = output.content[thinkingIndex];
          stream.push({
            type: 'thinking_end',
            contentIndex: thinkingIndex,
            content: block?.type === 'thinking' ? block.thinking : '',
            partial: output,
          });
        }
        if (textIndex !== undefined) {
          const block = output.content[textIndex];
          stream.push({
            type: 'text_end',
            contentIndex: textIndex,
            content: block?.type === 'text' ? block.text : '',
            partial: output,
          });
        }
      };

      // Resolve the live harness repair wiring once for this stream (fixer, rungs
      // 3–5, telemetry, per-session relaxed schemas). Falls back to static deps.
      const live = deps.repairProvider?.();
      const registeredNames = context.tools?.map((t) => t.name) ?? [];

      const schemaFor = (name: string): ToolSchemaLike | undefined => {
        // A per-session RELAXED schema (rung-4) wins over the strict one so a tool
        // the harness relaxed this session validates cleanly on subsequent calls.
        const relaxed = live?.relaxedSchemaFor?.(name);
        if (relaxed !== undefined) return relaxed;
        const tool = context.tools?.find((t) => t.name === name);
        return tool?.parameters as ToolSchemaLike | undefined;
      };

      try {
        stream.push({ type: 'start', partial: output });

        // Build the request body, then give the host a chance to inspect/replace it
        // via pi's `onPayload` (the `before_provider_request` hook) — the SAME seam
        // the built-in providers honor. The corp coordination harness relies on this
        // to (a) merge its owner-tuned qwen sampling (temperature/top_p/top_k/min_p/
        // penalties + max_tokens) onto the outgoing body and (b) ARM its per-call
        // hang watchdog. `onPayload` returns the (possibly new) payload, or a value
        // we ignore unless it is a fresh object; absent (normal chat) → unchanged.
        // Context-overflow recovery loop. llama-server rejects a prompt bigger
        // than its `n_ctx` with HTTP 400 `exceed_context_size_error`. Instead of
        // throwing that raw blob into the chat (or letting pi's compaction hard-
        // fail), we TRIM the oldest/largest tool results out of the request and
        // retry — re-reading the fresh token counts the server reports on each
        // pass — until the prompt fits or nothing is left to trim. This keeps the
        // turn going transparently; pi never sees the overflow. See context-trim.ts.
        /*
         * Stale screenshots go before the request is built, every time — not
         * only when the prompt overflows. An old screenshot is wrong as well as
         * expensive: it shows a screen that has since been clicked and typed
         * into. See dropStaleScreenshots for the measurement that found it.
         */
        const pruned = dropStaleScreenshots(context);
        let sendContext = pruned.context;
        let res: Response;
        for (let attempt = 0; ; attempt++) {
          let body = buildChatCompletionsRequest(model, sendContext, options);
          const replaced = await options?.onPayload?.(body, model);
          if (replaced !== null && typeof replaced === 'object') {
            body = replaced as Record<string, unknown>;
          }
          tapRequest(body, 'llamacpp');
          res = await fetchWhenBack(`${model.baseUrl}/chat/completions`, {
            method: 'POST',
            // models.json headers / apiKey arrive in `options`, not on the model.
            headers: buildRequestHeaders(model, options),
            body: JSON.stringify(body),
            signal: options?.signal,
          });
          // A response arrived (headers received, before the body is consumed) → notify
          // the host via pi's `onResponse` (`after_provider_response`), mirroring the
          // built-in openai-completions handler. The corp uses this to DISARM its
          // per-call watchdog: the server responded, so this request is not a hung
          // socket and the (legitimately long) stream may run unbounded. No-op in
          // normal chat (no handler). Fired on ANY status so an error response also
          // clears the watchdog rather than tripping it. Re-fired on each retry so a
          // recovered request re-arms/re-disarms the watchdog like a fresh call.
          await options?.onResponse?.(
            { status: res.status, headers: headersToRecord(res.headers) },
            model,
          );
          if (res.ok) break;

          const detail = await res.text().catch(() => '');
          const overflow = parseContextOverflow(detail);
          if (overflow !== undefined && attempt < MAX_OVERFLOW_RETRIES) {
            // Free the overshoot plus a reply margin, shedding stale tool results.
            const target = overflow.nPromptTokens - overflow.nCtx + REPLY_MARGIN_TOKENS;
            const trim = trimContextForOverflow(sendContext, target);
            if (trim.trimmedCount > 0) {
              sendContext = trim.context;
              // eslint-disable-next-line no-console
              console.log(
                `[pi-ctx] overflow ${overflow.nPromptTokens}/${overflow.nCtx} tok — trimmed ~${trim.removedTokens} tok from ${trim.trimmedCount} tool result(s), retrying (attempt ${attempt + 1}/${MAX_OVERFLOW_RETRIES})`,
              );
              continue;
            }
          }
          // Unrecoverable: a non-overflow error, retries exhausted, or nothing
          // left to trim (pathological). Surface a CLEAN short message — never the
          // raw HTTP/JSON blob (log the detail for debugging only).
          if (detail.length > 0) {
            // eslint-disable-next-line no-console
            console.error(`[pi-ctx] llama-server HTTP ${res.status}: ${detail.slice(0, 500)}`);
          }
          throw new Error(cleanProviderError(res.status, overflow));
        }

        // KV-reuse visibility (the user): log ONCE per turn from the first prefill
        // frame — the whole context length, how much of it the server reused from
        // the KV cache (the stable prefix), and how many NEW tokens it had to
        // prefill (the latest message). A big `reused` + small `new` on a
        // follow-up means the cache is working and we're not re-prefilling.
        let kvLogged = false;
        // The live readout: counted here, read by the app off stderr (live-tps.ts).
        const liveTps = createLiveTpsReporter();
        try {
          for await (const payload of parseSSE(await readBody(res))) {
            let chunk: OAIChunk;
            try {
              chunk = JSON.parse(payload) as OAIChunk;
            } catch {
              continue; // skip non-JSON keep-alives
            }
            if (chunk.timings !== undefined) {
              lastTimings = chunk.timings;
              tapUsage('llamacpp', {
                prompt: (chunk.timings.prompt_n ?? 0) + (chunk.timings.cache_n ?? 0),
                cached: chunk.timings.cache_n,
              });
            }
            if (chunk.usage != null) {
              output.usage.input = chunk.usage.prompt_tokens ?? output.usage.input;
              output.usage.output = chunk.usage.completion_tokens ?? output.usage.output;
            }

            // Prefill progress: emitted during prompt ingestion (before the first
            // token), typically on a frame with an empty `choices` array. Observe
            // it here — ahead of the per-choice delta logic below, which `continue`s
            // past choice-less frames — and hand it to the host's "Processing N%"
            // seam.
            if (chunk.prompt_progress !== undefined) {
              const pp = chunk.prompt_progress;
              if (!kvLogged && (pp.total ?? 0) > 0) {
                kvLogged = true;
                const total = pp.total ?? 0;
                const reused = pp.cache ?? 0;
                const pctReused = total > 0 ? Math.round((reused / total) * 100) : 0;
                // Fingerprint the cached PREFIX so a churn is visible: the tool count
                // + system-prompt length are what the chat template renders BEFORE the
                // messages. A follow-up with the SAME fingerprint but LOW reuse means
                // the prefix moved for another reason; a CHANGED fingerprint (tools/
                // sys grew or shrank) is the churn itself. Healthy follow-up = high
                // reuse% + unchanged fingerprint (the user: "view actual context changes").
                const nTools = context.tools?.length ?? 0;
                const sysLen = context.systemPrompt?.length ?? 0;
                // eslint-disable-next-line no-console
                console.log(
                  `[pi-kv] context=${total} tok · reused=${reused} (${pctReused}%) · new=${Math.max(0, total - reused)} · prefix{tools=${nTools} sys=${sysLen}ch}`,
                );
              }
              const fraction = promptProgressFraction(pp);
              deps.onPromptProgress?.({
                processed: pp.processed ?? 0,
                total: pp.total ?? 0,
                fraction,
              });
              // The LIVE (harness-provided) sink — the harness has the per-turn ctx
              // to publish `harness-prefill` for the desktop ring, which the static
              // provider deps can't reach. Best-effort; absent off-harness.
              deps.repairProvider?.()?.onPromptProgress?.(fraction);
            }

            const choice = chunk.choices?.[0];
            if (choice === undefined) continue;
            const delta = choice.delta;
            if (
              (delta?.content != null && delta.content.length > 0) ||
              (delta?.reasoning_content != null && delta.reasoning_content.length > 0) ||
              (delta?.tool_calls?.length ?? 0) > 0
            ) {
              liveTps.tick();
            }

            if (delta?.reasoning_content != null && delta.reasoning_content.length > 0) {
              if (thinkingIndex === undefined) {
                output.content.push({ type: 'thinking', thinking: '' });
                thinkingIndex = output.content.length - 1;
                stream.push({
                  type: 'thinking_start',
                  contentIndex: thinkingIndex,
                  partial: output,
                });
              }
              const block = output.content[thinkingIndex];
              if (block?.type === 'thinking') block.thinking += delta.reasoning_content;
              stream.push({
                type: 'thinking_delta',
                contentIndex: thinkingIndex,
                delta: delta.reasoning_content,
                partial: output,
              });
            }

            if (delta?.content != null && delta.content.length > 0) {
              if (textIndex === undefined) {
                output.content.push({ type: 'text', text: '' });
                textIndex = output.content.length - 1;
                stream.push({ type: 'text_start', contentIndex: textIndex, partial: output });
              }
              const block = output.content[textIndex];
              if (block?.type === 'text') block.text += delta.content;
              stream.push({
                type: 'text_delta',
                contentIndex: textIndex,
                delta: delta.content,
                partial: output,
              });
            }

            for (const tc of delta?.tool_calls ?? []) {
              const key = tc.index ?? toolStates.size;
              let state = toolStates.get(key);
              if (state === undefined) {
                const block: ToolCall = {
                  type: 'toolCall',
                  id: tc.id ?? `call_${key}`,
                  name: tc.function?.name ?? '',
                  arguments: {},
                };
                output.content.push(block);
                state = {
                  contentIndex: output.content.length - 1,
                  id: block.id,
                  name: block.name,
                  argStr: '',
                };
                toolStates.set(key, state);
                stream.push({
                  type: 'toolcall_start',
                  contentIndex: state.contentIndex,
                  partial: output,
                });
              }
              if (tc.function?.name !== undefined && state.name.length === 0) {
                state.name = tc.function.name;
                const block = output.content[state.contentIndex];
                if (block?.type === 'toolCall') block.name = state.name;
              }
              const argDelta = tc.function?.arguments;
              if (argDelta !== undefined && argDelta.length > 0) {
                state.argStr += argDelta;
                const block = output.content[state.contentIndex];
                if (block?.type === 'toolCall') {
                  try {
                    block.arguments = JSON.parse(state.argStr) as Record<string, unknown>;
                  } catch {
                    // partial JSON; finalized at toolcall_end
                  }
                }
                stream.push({
                  type: 'toolcall_delta',
                  contentIndex: state.contentIndex,
                  delta: argDelta,
                  partial: output,
                });
              }
            }

            if (choice.finish_reason != null) finishReason = mapFinishReason(choice.finish_reason);
          }
        } finally {
          liveTps.end();
        }

        // --- finalize blocks ------------------------------------------------
        closeOpenBlocks();

        // --- RUNG 0: reconstruct a tool call written into the CONTENT ---------
        // If the model emitted NO structured tool_calls frame but wrote a call as
        // prose/markdown (a fenced JSON envelope, an XML/paren call, or "… call
        // web_search with {…}"), reconstruct it into the SAME structured path the
        // ladder consumes. Pure heuristics — guarded to a registered tool name +
        // parseable args (see reconstructToolCallFromContent) so it never fires on
        // prose that merely mentions a tool. The synthesized state then flows
        // through the arg loop below (validate → fixer → rungs 3–5) unchanged.
        if (toolStates.size === 0 && registeredNames.length > 0 && textIndex !== undefined) {
          const textBlock = output.content[textIndex];
          const assistantText = textBlock?.type === 'text' ? textBlock.text : '';
          const reconstructed = reconstructToolCallFromContent(assistantText, registeredNames);
          if (reconstructed !== undefined) {
            // The call is a real tool call now, so the text stops carrying it:
            // the thread shows an activity row instead of raw markup, and the
            // next prompt has the call once (the template's), not also as prose.
            if (textBlock?.type === 'text') {
              textBlock.text = withoutWrittenToolCall(assistantText, reconstructed);
            }
            const block: ToolCall = {
              type: 'toolCall',
              id: `call_rung0_${output.content.length}`,
              name: reconstructed.toolName,
              arguments: {},
            };
            output.content.push(block);
            const contentIndex = output.content.length - 1;
            toolStates.set(toolStates.size, {
              contentIndex,
              id: block.id,
              name: reconstructed.toolName,
              argStr: reconstructed.argsText,
            });
            stream.push({ type: 'toolcall_start', contentIndex, partial: output });
            // Record the pre-ladder structural repair (rung 0).
            (live?.onRepair ?? deps.onRepair)?.({
              toolName: reconstructed.toolName,
              rung: 0,
              ok: true,
            });
          }
        }

        for (const state of toolStates.values()) {
          const block = output.content[state.contentIndex];
          if (block?.type !== 'toolCall') continue;

          // An unknown structured tool name: one of the host's command lines
          // typed as a name becomes the `bash` call that runs it (the harness
          // answers over the bridge), a misspelling maps to the nearest
          // REGISTERED tool above the confidence threshold so the correct schema
          // resolves and the call executes; anything else is left for pi's
          // existing "tool not found" path. See resolveUnknownToolName.
          const resolvedName = resolveUnknownToolName(
            state.name,
            state.argStr,
            registeredNames,
            live?.resolveUnknownTool,
          );
          if (resolvedName !== undefined) {
            state.name = resolvedName.name;
            state.argStr = resolvedName.argStr;
            block.name = resolvedName.name;
            (live?.onRepair ?? deps.onRepair)?.({ toolName: resolvedName.name, rung: 0, ok: true });
          }

          const schema = schemaFor(state.name);

          // Parse first; a parse failure OR a syntactically-valid but
          // SCHEMA-invalid call both enter the repair ladder (rung 1 normalize →
          // rung 2 fixer → rungs 3–5). A schema-clean parse skips repair entirely.
          let parsed: Record<string, unknown> | undefined;
          let parseOk = true;
          try {
            parsed =
              state.argStr.length > 0 ? (JSON.parse(state.argStr) as Record<string, unknown>) : {};
          } catch {
            parseOk = false;
          }
          const schemaInvalid =
            parseOk && parsed !== undefined && schema !== undefined
              ? !validateAgainstSchema(parsed, schema).valid
              : false;

          let finalArgs: Record<string, unknown>;
          if (!parseOk || schemaInvalid) {
            // Use the live harness wiring (fixer + rungs 3–5 + telemetry) resolved
            // once at stream start, falling back to any static deps.
            const result = await repairToolCallArguments(state.argStr, {
              toolName: state.name,
              schema,
              fixer: live?.fixer ?? deps.fixer,
              extraRungs: live?.extraRungs ?? deps.extraRungs,
            });
            (live?.onRepair ?? deps.onRepair)?.({
              toolName: state.name,
              rung: result.rung,
              ok: result.ok,
            });
            finalArgs = result.value ?? parsed ?? {};
          } else {
            finalArgs = parsed ?? {};
          }
          block.arguments = finalArgs;
          if (finishReason === 'stop') finishReason = 'toolUse';
          // This call is COMPLETE — record it so an error raised later in this
          // loop (a throwing fixer/rung) can't prune an already-finished call.
          finalizedTools.add(block);
          stream.push({
            type: 'toolcall_end',
            contentIndex: state.contentIndex,
            toolCall: { type: 'toolCall', id: state.id, name: state.name, arguments: finalArgs },
            partial: output,
          });
        }

        output.usage.totalTokens = output.usage.input + output.usage.output;
        calculateCost(model, output.usage);
        if (lastTimings !== undefined) deps.onTimings?.(lastTimings);

        /*
         * KV REUSE, MEASURED FROM DATA THE SERVER ALWAYS SENDS.
         *
         * THIS IS WHY THE PREFIX-CACHE REGRESSION KEEPS COMING BACK — five times
         * now, each time found by the user noticing the app is slow. There WAS a
         * `[pi-kv]` line for exactly this, and it is inert: it hangs off
         * `chunk.prompt_progress`, which llama-server only emits when asked, so
         * it never printed. Zero occurrences across every run log on this
         * machine. A detector that cannot fire is indistinguishable from a
         * detector that keeps passing, which is how four fixes in a row were
         * aimed at whichever caller happened to be blamed that month.
         *
         * `timings.prompt_n` (tokens actually PROCESSED) and `usage.prompt_tokens`
         * (tokens SENT) both arrive on every completion — MEASURED with
         * kv-eviction-probe: a cache hit reports prompt_n 17 against a 1,121-token
         * conversation, a cold send reports 1,121. So reuse is
         * `1 - processed/sent`, and it needs nothing optional turned on.
         *
         * Logged every turn with the prefix fingerprint, so a follow-up that
         * re-prefills the world is visible in the line itself rather than
         * inferred from a stopwatch.
         */
        const sent = output.usage.input;
        const processed = lastTimings?.prompt_n;
        if (typeof processed === 'number' && sent > 0) {
          const reused = Math.max(0, sent - processed);
          const pct = Math.round((reused / sent) * 100);
          const nTools = context.tools?.length ?? 0;
          const sysLen = context.systemPrompt?.length ?? 0;
          // eslint-disable-next-line no-console
          console.log(
            `[pi-kv] sent=${sent} tok · reused=${reused} (${pct}%) · prefilled=${processed} · prefix{tools=${nTools} sys=${sysLen}ch}`,
          );
        }

        // The final message is what the thread shows and the next prompt
        // carries: settle it (see settle-reply.ts — a reply that is only a
        // thought the model ended itself is the reply).
        const settled = settleReply(output.content, finishReason);
        const settling = settleNote(output.content, settled, output.usage.output, finishReason);
        // eslint-disable-next-line no-console
        if (settling !== null) console.log(`[pi-ctx] ${settling}`);
        output.content = settled;
        output.stopReason = finishReason;
        stream.push({ type: 'done', reason: finishReason, message: output });
        stream.end();
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        /*
         * AN ABORTED STREAM MUST NOT LEAVE HALF A MESSAGE BEHIND.
         *
         * A pause is an abort mid-stream, and this handler used to push `error`
         * and stop — handing pi (and the transcript, and the next request built
         * from it) a message with blocks that were still OPEN and a tool call
         * that was still ACCUMULATING. Two things went wrong downstream:
         *
         *  - the open thinking/text block never got its closing event, so a
         *    consumer that finalizes on `*_end` was left holding a block that,
         *    from its point of view, never ended;
         *  - the in-progress tool call survived into history as `{ name: '',
         *    arguments: {} }` (or a name with argument JSON that stops halfway),
         *    which the next turn replays as a `tool_calls` entry with no result
         *    after it — a prompt that is broken precisely where the model reads
         *    how to frame a tool call, and it answers with prose instead.
         *
         * So: prune what never completed, THEN close what stayed open. Order
         * matters — pruning shifts the surviving blocks down, so the text /
         * thinking indices are re-based before the close events quote them.
         */
        for (let i = output.content.length - 1; i >= 0; i--) {
          const block = output.content[i];
          if (block === undefined || block.type !== 'toolCall' || finalizedTools.has(block)) {
            continue;
          }
          output.content.splice(i, 1);
          if (thinkingIndex !== undefined && i < thinkingIndex) thinkingIndex--;
          if (textIndex !== undefined && i < textIndex) textIndex--;
        }
        closeOpenBlocks();
        output.stopReason = aborted ? 'aborted' : 'error';
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}
