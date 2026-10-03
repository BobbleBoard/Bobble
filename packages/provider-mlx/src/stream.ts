/**
 * MLX `mlx_lm.server` `streamSimple` for pi.
 *
 * `mlx_lm.server` speaks the SAME OpenAI `/v1/chat/completions` SSE shape
 * @pi-desktop/provider-llamacpp already parses, so this REUSES that package's
 * pure pieces verbatim — the request builder (`buildChatCompletionsRequest`),
 * the SSE line parser (`parseSSE`), and the tool-call repair ladder
 * (`repairToolCallArguments` + `validateAgainstSchema`, rungs 1–2 + the harness's
 * rungs 3–5 via `extraRungs`). The repair ladder matters MORE here: MLX's
 * per-model-family tool-call parsing is weaker than llama.cpp's (e.g. Gemma4
 * leaks calls as raw text — mlx-lm #1096), so a malformed `tool_calls` is more
 * likely and the ladder is the safety net.
 *
 * The ONE real difference from the llamacpp stream: MLX emits **no `timings`
 * block**, so throughput is timed CLIENT-side — first-token wall clock →
 * stream-end over `usage.completion_tokens` — and reported via `onTps`.
 *
 * Electron-free; `fetchImpl` is injectable so tests feed fixture SSE without a
 * live server.
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from '@mariozechner/pi-ai';
import {
  buildChatCompletionsRequest,
  buildRequestHeaders,
  createLiveTpsReporter,
  headersToRecord,
  parseSSE,
  type RepairRung,
  reconstructToolCallFromContent,
  repairToolCallArguments,
  resolveUnknownToolName,
  settleNote,
  settleReply,
  streamErrorMessage,
  type ToolCallFixer,
  type ToolSchemaLike,
  tapRequest,
  tapUsage,
  type UnknownToolResolver,
  validateAgainstSchema,
  withoutWrittenToolCall,
} from '@pi-desktop/provider-llamacpp';
import { fitPicturesToVisionBudget } from './picture-budget.js';

export interface MlxStreamDeps {
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Rung-2 fixer-model call (optional; injected by the harness in prod). */
  readonly fixer?: ToolCallFixer;
  /** The harness's rungs 3–5. */
  readonly extraRungs?: readonly RepairRung[];
  /**
   * Called with CLIENT-side tokens/sec at stream end (MLX emits no `timings`, so
   * this is the only throughput signal). `tokens` = completion tokens; `ms` =
   * first-token → stream-end wall clock.
   */
  readonly onTps?: (info: { tps: number; tokens: number; ms: number }) => void;
  /** Called when a tool call needed repair (observability). */
  readonly onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
  /**
   * Live repair wiring resolved at stream time (the harness pushes this via the
   * `pi.events` repair bridge). Takes precedence over the static deps above, so
   * effort-slider changes + rungs 3–5 take effect without re-registering.
   */
  readonly repairProvider?: () =>
    | {
        fixer?: ToolCallFixer;
        extraRungs?: readonly RepairRung[];
        onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
        /** A command line typed as a tool name → the `bash` call that runs it. */
        resolveUnknownTool?: UnknownToolResolver;
      }
    | undefined;
}

/** streamSimple signature required by pi's ProviderConfig. */
export type MlxStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface OAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OAIDelta {
  content?: string | null;
  reasoning_content?: string | null;
  /** mlx_lm.server's name for the same thing (0.31: `delta.reasoning`). */
  reasoning?: string | null;
  tool_calls?: OAIToolCallDelta[];
}
interface OAIChoice {
  delta?: OAIDelta;
  finish_reason?: string | null;
}
interface OAIChunk {
  choices?: OAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** What the engine's prefix cache served (rapid-mlx, mlx_lm.server). */
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
  /** A failure after the response began — an error, never an empty reply. */
  error?: unknown;
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
  if (res.body === null) throw new Error('mlx_lm.server returned no response body');
  return res.body as unknown as AsyncIterable<Uint8Array>;
}

/**
 * ONLY WHAT AN OPENAI-SHAPED SERVER ACCEPTS.
 *
 * The request body is built for llama-server and then handed to every hook
 * that runs on it. Two of those speak llama.cpp's dialect: the intent bias
 * writes `logit_bias` as `[["_click", 4.5]]` — an ARRAY, with STRING keys the
 * server tokenizes itself — and the OpenAI shape is `{ "<token id>": bias }`.
 * MEASURED (2026-09-13, engine-matrix probe on Qwen3.5-4B): rapid-mlx answered
 * `HTTP 400 Invalid request body: logit_bias: Value error, logit_bias must be
 * a mapping of token-id (str) → …` on the second turn of a chat, which the
 * chat showed as "The local model server returned an error" — the user's report.
 *
 * No tokenizer lives here to turn a string into an id, so the llama.cpp forms
 * are DROPPED for these engines (the bias is a nudge, never a requirement);
 * an object already keyed by numeric ids passes through. `return_progress` is
 * llama-server's prefill-progress opt-in and is stripped for the same reason,
 * even though today's engines ignore it.
 */
export function shapeForOpenAiServer(
  body: Record<string, unknown>,
  target: { readonly engine?: string; readonly maxTokens?: number } = {},
): Record<string, unknown> {
  const out = { ...body };
  /*
   * NO OUTPUT CAP BY DEFAULT — the reply ends when the model ends it, like
   * llama.cpp's `n_predict -1`. Four of the engines cap a request that names
   * no `max_tokens` at a few hundred tokens (mlx_lm.server and dflash-mlx 512,
   * oMLX and mlx-dspark 2048), which cuts a thought mid-sentence and ends the
   * turn with nothing said (the user: "never put any cap that by default"). Those
   * get the model's own ceiling (pi's `maxTokens`: the context less a reply
   * margin; mlx-dspark clamps it to its `--max-tokens-cap`). rapid-mlx keeps
   * its own default: it checks `prompt + max_tokens` against the model's
   * context on every request and would refuse a large one outright.
   */
  if (
    out.max_tokens === undefined &&
    target.maxTokens !== undefined &&
    target.maxTokens > 0 &&
    engineCapsByDefault(target.engine)
  ) {
    out.max_tokens = Math.floor(target.maxTokens);
  }
  /*
   * THINKING ON, AND KEPT, LIKE LLAMA.CPP.
   *
   * llama.cpp passes `enable_thinking=true` to any template that supports it
   * (`--reasoning auto`) and `preserve_thinking` under `--reasoning-preserve`.
   * The MLX engines get it per request, and they disagree when asked nothing:
   * MEASURED 2026-09-13 on Qwen3.5-4B — rapid-mlx answers WITHOUT thinking
   * unless told (its own default), mlx-lm / oMLX / mlx-dspark / dflash-mlx
   * follow the template (on). A caller that set `enable_thinking` itself (the
   * calibration bench, the titler) is left alone. `preserve_thinking` (and the
   * spellings Ling's and froggeric's templates use) keeps every past turn's
   * think block in the rendered history, so the prefix cache holds across turns
   * — see patchPreserveThinking in @pi-desktop/inference. Templates that never
   * read a variable ignore it.
   */
  const kwargs =
    out.chat_template_kwargs !== null && typeof out.chat_template_kwargs === 'object'
      ? { ...(out.chat_template_kwargs as Record<string, unknown>) }
      : {};
  if (kwargs.enable_thinking === undefined) kwargs.enable_thinking = true;
  for (const key of ['preserve_thinking', 'preserved_thinking', 'preserve_reasoning']) {
    if (kwargs[key] === undefined) kwargs[key] = true;
  }
  out.chat_template_kwargs = kwargs;
  const bias = out.logit_bias;
  if (Array.isArray(bias)) {
    delete out.logit_bias;
  } else if (bias !== null && typeof bias === 'object') {
    const kept = Object.fromEntries(
      Object.entries(bias as Record<string, unknown>).filter(
        ([k, v]) => /^\d+$/.test(k) && typeof v === 'number',
      ),
    );
    if (Object.keys(kept).length === 0) delete out.logit_bias;
    else out.logit_bias = kept;
  }
  delete out.return_progress;
  return out;
}

/**
 * rapid-mlx's cut-mid-think notice — "[truncated — reasoning incomplete;
 * raise max_tokens]" followed by the tail of the thought — arrives as content
 * (or, on some builds, as reasoning). The launch env turns it off
 * (RAPID_MLX_REASONING_CUTOFF_NOTICE=disabled); this is for an engine that
 * sends it anyway: the sentence goes, and what follows it is the THOUGHT's
 * tail, not an answer. finish_reason "length" already says the reply was cut.
 */
const CUTOFF_SENTINEL = /\[truncated — reasoning incomplete; raise max_tokens\]\s*/g;
export function stripCutoffNotice(text: string): { text: string; hit: boolean } {
  const out = text.replace(CUTOFF_SENTINEL, '');
  return { text: out, hit: out !== text };
}

/**
 * The engine behind a served id: `<catalog>@<engine>` for rapid-mlx, oMLX and
 * vLLM; the others (mlx_lm.server, dflash-mlx, mlx-dspark) serve the model
 * under its directory path, which is `mlx` here.
 */
function engineOf(model: { id: string }): string {
  return model.id.includes('@') ? model.id.slice(model.id.lastIndexOf('@') + 1) : 'mlx';
}

/**
 * One picture, described by the model on the same server — the stand-in for a
 * picture in a conversation too long for rapid-mlx's vision lane (see
 * picture-budget.ts). Thinking off and a short reply: this is a caption.
 */
async function describePicture(
  baseUrl: string,
  modelId: string,
  url: string,
  deps: { fetch: typeof fetch; headers: Record<string, string>; signal?: AbortSignal },
): Promise<string | null> {
  const res = await deps.fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: deps.headers,
    body: JSON.stringify({
      model: modelId,
      stream: false,
      max_tokens: 320,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'system',
          content: 'You describe pictures exactly, for someone who cannot see them.',
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url } },
            {
              type: 'text',
              text:
                'Describe this picture in 3 to 6 plain sentences: what it shows, its layout and ' +
                'any text on it, and anything that looks blank, broken, cut off or wrong.',
            },
          ],
        },
      ],
    }),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;
  const text = j?.choices?.[0]?.message?.content ?? '';
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return clean === '' ? null : clean;
}

/** Engines that cut a reply short when the request names no `max_tokens`. */
function engineCapsByDefault(engine: string | undefined): boolean {
  return engine !== undefined && engine !== 'rapid-mlx' && engine !== 'vllm';
}

/**
 * Create the streamSimple function for an `mlx_lm.server` provider. Mirrors the
 * llamacpp stream's delta→AssistantMessageEventStream translation + repair, but
 * times TPS on the client (MLX sends no `timings`).
 */
export function createMlxStream(deps: MlxStreamDeps = {}): MlxStreamFn {
  const doFetch = deps.fetchImpl ?? fetch;

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
      let finishReason: 'stop' | 'length' | 'toolUse' = 'stop';
      // Client-side TPS timing: first content byte → stream end.
      let firstTokenAt: number | undefined;
      /** rapid-mlx's cut-mid-think notice arrived: content from here on is the thought's tail. */
      let cutoffTail = false;

      const schemaFor = (name: string): ToolSchemaLike | undefined => {
        const tool = context.tools?.find((t) => t.name === name);
        return tool?.parameters as ToolSchemaLike | undefined;
      };

      try {
        stream.push({ type: 'start', partial: output });

        /*
         * THE HOST'S HOOKS, which this provider was not calling.
         *
         * `onPayload` is pi's `before_provider_request` and `onResponse` its
         * `after_provider_response`. Four mechanisms hang off them and were all
         * silently inert on MLX while working on llama.cpp: the user's advanced
         * sampling overrides, the prose loop detector, intent-bias tool
         * activation, and the corp's hang watchdog — which is armed per call and
         * DISARMED by `onResponse`, so on this engine it could arm and never
         * disarm. A user switching engines lost four behaviours and was told
         * nothing.
         */
        let body = buildChatCompletionsRequest(model, context, options);
        const replaced = await options?.onPayload?.(body, model);
        if (replaced !== null && replaced !== undefined && typeof replaced === 'object') {
          body = replaced as typeof body;
        }
        // After the hooks, since it is the hooks' llama.cpp-isms this removes.
        body = shapeForOpenAiServer(body, { engine: engineOf(model), maxTokens: model.maxTokens });
        // rapid-mlx's vision lane: a conversation too long to carry its pictures
        // gets their descriptions instead of a refusal or an out-of-memory crash.
        if (engineOf(model) === 'rapid-mlx') {
          const headers = buildRequestHeaders(model, options);
          body = (await fitPicturesToVisionBudget(body, {
            describe: (url) =>
              describePicture(model.baseUrl, model.id, url, {
                fetch: doFetch,
                headers,
                ...(options?.signal !== undefined ? { signal: options.signal } : {}),
              }),
          })) as typeof body;
        }
        tapRequest(body, engineOf(model));
        const res = await doFetch(`${model.baseUrl}/chat/completions`, {
          method: 'POST',
          // models.json headers / apiKey arrive in `options`, not on the model.
          headers: buildRequestHeaders(model, options),
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        await options?.onResponse?.(
          { status: res.status, headers: headersToRecord(res.headers) },
          model,
        );
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`mlx_lm.server HTTP ${res.status}: ${detail.slice(0, 500)}`);
        }

        // The live readout, read by the app off stderr (provider-llamacpp/live-tps).
        const liveTps = createLiveTpsReporter();
        try {
          for await (const payload of parseSSE(await readBody(res))) {
            let chunk: OAIChunk;
            try {
              chunk = JSON.parse(payload) as OAIChunk;
            } catch {
              continue; // skip non-JSON keep-alives
            }
            if (chunk.error != null) {
              // eslint-disable-next-line no-console
              console.error(
                `[pi-ctx] ${engineOf(model)} stream error: ${JSON.stringify(chunk.error).slice(0, 500)}`,
              );
              throw new Error(streamErrorMessage(chunk.error));
            }
            if (chunk.usage != null) {
              output.usage.input = chunk.usage.prompt_tokens ?? output.usage.input;
              output.usage.output = chunk.usage.completion_tokens ?? output.usage.output;
              const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
              if (typeof cached === 'number') output.usage.cacheRead = cached;
              tapUsage(engineOf(model), {
                prompt: chunk.usage.prompt_tokens,
                cached: typeof cached === 'number' ? cached : undefined,
              });
            }

            const choice = chunk.choices?.[0];
            if (choice === undefined) continue;
            const delta = choice.delta;
            // `reasoning_content` (llama.cpp, rapid-mlx, oMLX, mlx-dspark,
            // dflash-mlx) or `reasoning` (mlx_lm.server) — one stream of thought.
            const rawReasoning =
              delta?.reasoning_content != null && delta.reasoning_content.length > 0
                ? delta.reasoning_content
                : delta?.reasoning != null && delta.reasoning.length > 0
                  ? delta.reasoning
                  : undefined;
            const reasoningDelta =
              rawReasoning === undefined
                ? undefined
                : stripCutoffNotice(rawReasoning).text || undefined;
            // Content that opens with the notice is the thought's tail: it and
            // everything after it in this stream belong to the thinking block.
            let contentDelta =
              delta?.content != null && delta.content.length > 0 ? delta.content : undefined;
            if (contentDelta !== undefined) {
              const stripped = stripCutoffNotice(contentDelta);
              if (stripped.hit) cutoffTail = true;
              contentDelta = stripped.text.length > 0 ? stripped.text : undefined;
            }
            const tailDelta = cutoffTail && contentDelta !== undefined ? contentDelta : undefined;
            if (tailDelta !== undefined) contentDelta = undefined;
            if (
              contentDelta !== undefined ||
              reasoningDelta !== undefined ||
              tailDelta !== undefined ||
              (delta?.tool_calls?.length ?? 0) > 0
            ) {
              liveTps.tick();
            }

            const thoughtDelta =
              reasoningDelta !== undefined && tailDelta !== undefined
                ? reasoningDelta + tailDelta
                : (reasoningDelta ?? tailDelta);
            if (thoughtDelta !== undefined) {
              if (firstTokenAt === undefined) firstTokenAt = Date.now();
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
              if (block?.type === 'thinking') block.thinking += thoughtDelta;
              stream.push({
                type: 'thinking_delta',
                contentIndex: thinkingIndex,
                delta: thoughtDelta,
                partial: output,
              });
            }

            if (contentDelta !== undefined) {
              /*
               * oMLX, cut off by max_tokens INSIDE the think block, hands the
               * whole thought back once more as content (MEASURED 2026-09-13:
               * one closing delta equal to everything it had streamed as
               * reasoning_content). That is not an answer; it is the thought
               * again, and it would render twice.
               */
              const thought =
                thinkingIndex !== undefined ? output.content[thinkingIndex] : undefined;
              if (
                textIndex === undefined &&
                thought?.type === 'thinking' &&
                thought.thinking.length > 0 &&
                contentDelta === thought.thinking
              ) {
                continue;
              }
              if (firstTokenAt === undefined) firstTokenAt = Date.now();
              if (textIndex === undefined) {
                output.content.push({ type: 'text', text: '' });
                textIndex = output.content.length - 1;
                stream.push({ type: 'text_start', contentIndex: textIndex, partial: output });
              }
              const block = output.content[textIndex];
              if (block?.type === 'text') block.text += contentDelta;
              stream.push({
                type: 'text_delta',
                contentIndex: textIndex,
                delta: contentDelta,
                partial: output,
              });
            }

            for (const tc of delta?.tool_calls ?? []) {
              if (firstTokenAt === undefined) firstTokenAt = Date.now();
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

        /*
         * RUNG 0 — a tool call WRITTEN INTO THE CONTENT, the same rung
         * provider-llamacpp has and this provider did not.
         *
         * MEASURED 2026-09-13 (engine-matrix probe, MiniCPM5 2B): on mlx-lm,
         * rapid-mlx and oMLX the model's call came back as the text
         * `<function name="bash"><param name="command">echo …</param></function>`
         * — MiniCPM5's own contract, which those engines' parsers do not know
         * (rapid-mlx auto-picked hermes) — so no tool ran and the model then
         * made the output up. llama.cpp and mlx-dspark parsed it. The heuristics
         * are guarded to a registered tool name + parseable args, so prose that
         * merely mentions a tool never fires; the synthesized call then goes
         * through the same validate → repair path as a structured one.
         */
        const registeredNames = context.tools?.map((t) => t.name) ?? [];
        if (toolStates.size === 0 && registeredNames.length > 0 && textIndex !== undefined) {
          const textBlock = output.content[textIndex];
          const assistantText = textBlock?.type === 'text' ? textBlock.text : '';
          const reconstructed = reconstructToolCallFromContent(assistantText, registeredNames);
          if (reconstructed !== undefined) {
            // The call is a real tool call now, so the text stops carrying it
            // (see provider-llamacpp: no raw markup in the thread, and the next
            // prompt carries the call once).
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
            const live = deps.repairProvider?.();
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
          /*
           * An unknown structured tool name — the same step provider-llamacpp
           * takes, which this provider did not: a command line typed as a name
           * (`media generate image`, bash-CLI mode) becomes the `bash` call that
           * runs it, a misspelling maps to the nearest registered tool, and
           * anything else is left for pi's "not found". MEASURED here first:
           * qwen3.5-4b on rapid-mlx named the command instead of running it.
           */
          if (!registeredNames.includes(state.name)) {
            const live = deps.repairProvider?.();
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
              (live?.onRepair ?? deps.onRepair)?.({
                toolName: resolvedName.name,
                rung: 0,
                ok: true,
              });
            }
          }
          const schema = schemaFor(state.name);

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
            const live = deps.repairProvider?.();
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
          stream.push({
            type: 'toolcall_end',
            contentIndex: state.contentIndex,
            toolCall: { type: 'toolCall', id: state.id, name: state.name, arguments: finalArgs },
            partial: output,
          });
        }

        output.usage.totalTokens = output.usage.input + output.usage.output;
        calculateCost(model, output.usage);

        // Client-side TPS: MLX sends no timings, so time first-token → now over
        // the completion-token count. Guard against a zero/negative window.
        if (firstTokenAt !== undefined && output.usage.output > 0) {
          const ms = Math.max(1, Date.now() - firstTokenAt);
          deps.onTps?.({ tps: (output.usage.output / ms) * 1000, tokens: output.usage.output, ms });
        }

        // The final message is what the thread shows and the next prompt
        // carries: settle it (provider-llamacpp/settle-reply.ts — the newlines
        // after </think>, a flushed call fragment, a reply that is only a
        // thought the model ended itself).
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
        output.stopReason = aborted ? 'aborted' : 'error';
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}
