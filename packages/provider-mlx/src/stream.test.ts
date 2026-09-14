import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  Type,
} from '@mariozechner/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createMlxStream } from './stream.js';

function makeModel(baseUrl = 'http://127.0.0.1:8181/v1'): Model<'openai-completions'> {
  return {
    id: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    name: 'Qwen3.5 4B (MLX)',
    api: 'openai-completions',
    provider: 'mlx',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  };
}

/** A fake fetch that streams the given chunk objects as OpenAI SSE. */
function sseFetch(chunks: unknown[]): { fetchImpl: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      for (const c of chunks) yield enc.encode(`data: ${JSON.stringify(c)}\n\n`);
      yield enc.encode('data: [DONE]\n\n');
    }
    return { ok: true, status: 200, body: body() } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function consume(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<{ events: AssistantMessageEvent[]; final: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  let final: AssistantMessage | undefined;
  for await (const e of stream) {
    events.push(e);
    if (e.type === 'done') final = e.message;
    if (e.type === 'error') final = e.error;
  }
  if (final === undefined) throw new Error('stream never terminated');
  return { events, final };
}

const emptyContext = (tools?: Context['tools']): Context => ({
  systemPrompt: 'You are a test.',
  messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  tools,
});

describe('createMlxStream — text + CLIENT-side TPS', () => {
  it('streams text deltas, extracts usage, and reports client-side TPS (no timings)', async () => {
    // MLX chunks carry NO `timings` block — only `usage`.
    const { fetchImpl, calls } = sseFetch([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' MLX' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 12 },
      },
    ]);
    const onTps = vi.fn();
    const stream = createMlxStream({ fetchImpl, onTps })(makeModel(), emptyContext());
    const { events, final } = await consume(stream);

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    const text = final.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && text.text).toBe('Hello MLX');
    expect(final.stopReason).toBe('stop');
    expect(final.usage.output).toBe(12);
    // TPS was computed on the client from completion tokens + wall clock.
    expect(onTps).toHaveBeenCalledOnce();
    const info = onTps.mock.calls[0]?.[0] as { tps: number; tokens: number; ms: number };
    expect(info.tokens).toBe(12);
    expect(info.ms).toBeGreaterThan(0);
    expect(info.tps).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
  });

  it('does not report TPS when no tokens were produced', async () => {
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 0 } },
    ]);
    const onTps = vi.fn();
    await consume(createMlxStream({ fetchImpl, onTps })(makeModel(), emptyContext()));
    expect(onTps).not.toHaveBeenCalled();
  });
});

describe('createMlxStream — thoughts, whichever key the engine uses', () => {
  // MEASURED 2026-09-13 on Qwen3.5-4B: mlx_lm.server 0.31 streams `delta.reasoning`;
  // rapid-mlx, oMLX, mlx-dspark and dflash-mlx stream `delta.reasoning_content`.
  it("reads mlx-lm's `reasoning` as the same thinking block", async () => {
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { reasoning: 'Let me ' } }] },
      { choices: [{ delta: { reasoning: 'see.' } }] },
      { choices: [{ delta: { content: '391' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 4 } },
    ]);
    const { events, final } = await consume(
      createMlxStream({ fetchImpl })(makeModel(), emptyContext()),
    );
    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(2);
    expect(final.content).toEqual([
      { type: 'thinking', thinking: 'Let me see.' },
      { type: 'text', text: '391' },
    ]);
  });

  it("drops oMLX's closing repeat of an unfinished thought as content", async () => {
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { reasoning_content: 'Thinking ' } }] },
      { choices: [{ delta: { reasoning_content: 'hard' } }] },
      { choices: [{ delta: { content: 'Thinking hard' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 3 } },
    ]);
    const { final } = await consume(createMlxStream({ fetchImpl })(makeModel(), emptyContext()));
    expect(final.content).toEqual([{ type: 'thinking', thinking: 'Thinking hard' }]);
    // A genuine answer after a thought is still an answer.
    const real = sseFetch([
      { choices: [{ delta: { reasoning_content: 'Thinking hard' } }] },
      { choices: [{ delta: { content: 'Thinking hard is what I did.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 3 } },
    ]);
    const { final: answered } = await consume(
      createMlxStream({ fetchImpl: real.fetchImpl })(makeModel(), emptyContext()),
    );
    expect(answered.content.find((c) => c.type === 'text')).toEqual({
      type: 'text',
      text: 'Thinking hard is what I did.',
    });
  });

  it("never shows rapid-mlx's cut-mid-think notice; what follows it is the thought's tail", async () => {
    // SEEN (the user, 2026-09-13): a Thought reading "[truncated — reasoning
    // incomplete; raise max_tokens]". finish_reason "length" already says it.
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { reasoning_content: 'Let me work it out' } }] },
      {
        choices: [
          {
            delta: {
              content: '[truncated — reasoning incomplete; raise max_tokens]\n\nout: 17 × 23 = 391',
            },
          },
        ],
      },
      { choices: [{ delta: { content: '. So the' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 9 } },
    ]);
    const { events, final } = await consume(
      createMlxStream({ fetchImpl })(makeModel(), emptyContext()),
    );
    expect(final.stopReason).toBe('length');
    expect(final.content).toEqual([
      { type: 'thinking', thinking: 'Let me work it outout: 17 × 23 = 391. So the' },
    ]);
    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
    expect(JSON.stringify(final)).not.toContain('truncated');
  });

  it('asks every engine to think and to keep its thoughts, unless the caller said otherwise', async () => {
    const { fetchImpl, calls } = sseFetch([
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 0 } },
    ]);
    await consume(createMlxStream({ fetchImpl })(makeModel(), emptyContext()));
    const sent = JSON.parse(String(calls[0]?.body)) as {
      chat_template_kwargs: Record<string, unknown>;
    };
    expect(sent.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
      preserved_thinking: true,
      preserve_reasoning: true,
    });
  });
});

describe('createMlxStream — REUSES the repair ladder (matters more for MLX #1096)', () => {
  const tools: Context['tools'] = [
    { name: 'read', description: 'read a file', parameters: Type.Object({ path: Type.String() }) },
  ];

  it('repairs a truncated tool-call JSON before emitting toolcall_end', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/etc/hosts' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createMlxStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/etc/hosts' });
    expect(final.stopReason).toBe('toolUse');
    expect(onRepair).toHaveBeenCalledOnce();
    expect(onRepair.mock.calls[0]?.[0]).toMatchObject({ toolName: 'read', ok: true, rung: 2 });
  });

  it('prefers live repairProvider deps (the harness bridge) over static ones', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c5', function: { name: 'read' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"wrong":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const staticFixer = vi.fn(async () => ({ path: '/static' }));
    const liveFixer = vi.fn(async () => ({ path: '/live' }));
    const stream = createMlxStream({
      fetchImpl,
      fixer: staticFixer,
      repairProvider: () => ({ fixer: liveFixer }),
    })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    expect(liveFixer).toHaveBeenCalledOnce();
    expect(staticFixer).not.toHaveBeenCalled();
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/live' });
  });
});

describe('the host hooks', () => {
  /*
   * MEASURED by a repo audit: this provider called neither `onPayload` nor
   * `onResponse`, so four host mechanisms were silently inert on MLX while
   * working on llama.cpp — the user's advanced sampling overrides, the prose
   * loop detector, intent-bias tool activation, and the corp hang watchdog,
   * which is armed per call and disarmed by `onResponse`. On this engine it
   * could arm and never disarm.
   *
   * A user switching engines lost four behaviours and was told nothing.
   */
  it('offers the payload to the host, and sends back what it returns', async () => {
    let seen: Record<string, unknown> | null = null;
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      seen = JSON.parse(init.body);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const events = createMlxStream({ fetchImpl })(makeModel(), emptyContext(), {
      onPayload: async (body: Record<string, unknown>) => ({ ...body, temperature: 0.123 }),
    } as never);
    await consume(events);
    expect(seen).not.toBeNull();
    expect((seen as unknown as { temperature?: number })?.temperature).toBe(0.123);
  });

  it('tells the host the engine responded, so a watchdog can disarm', async () => {
    const statuses: number[] = [];
    const fetchImpl = (async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    const events = createMlxStream({ fetchImpl })(makeModel(), emptyContext(), {
      onResponse: async (r: { status: number }) => {
        statuses.push(r.status);
      },
    } as never);
    await consume(events);
    expect(statuses).toEqual([200]);
  });
});

describe('shapeForOpenAiServer — the body an OpenAI-shaped engine will take', () => {
  /** What every request carries unless the caller said otherwise. */
  const THINKING = {
    chat_template_kwargs: {
      enable_thinking: true,
      preserve_thinking: true,
      preserved_thinking: true,
      preserve_reasoning: true,
    },
  };

  it("drops llama.cpp's array-form logit_bias (string keys the server would have to tokenize)", async () => {
    const { shapeForOpenAiServer } = await import('./stream.js');
    const out = shapeForOpenAiServer({
      model: 'm',
      messages: [],
      logit_bias: [['_click', 4.5]],
      return_progress: true,
    });
    expect(out).toEqual({ model: 'm', messages: [], ...THINKING });
  });

  it('keeps an object keyed by numeric token ids and strips the rest', async () => {
    const { shapeForOpenAiServer } = await import('./stream.js');
    expect(shapeForOpenAiServer({ logit_bias: { '18070': 4.5, _click: 2 } })).toEqual({
      logit_bias: { '18070': 4.5 },
      ...THINKING,
    });
    expect(shapeForOpenAiServer({ logit_bias: { _click: 2 } })).toEqual(THINKING);
  });

  it('leaves everything else alone', async () => {
    const { shapeForOpenAiServer } = await import('./stream.js');
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      temperature: 0.7,
    };
    expect(shapeForOpenAiServer(body)).toEqual({ ...body, ...THINKING });
  });

  it("gives an engine that caps a reply by default the model's own ceiling, never rapid-mlx", async () => {
    // mlx_lm.server / dflash-mlx stop at 512 tokens and oMLX / mlx-dspark at
    // 2048 when no max_tokens is named — a thought cut mid-sentence and a turn
    // that ends with nothing said. rapid-mlx checks prompt + max_tokens against
    // the model's context per request, so it keeps its own default.
    const { shapeForOpenAiServer } = await import('./stream.js');
    expect(shapeForOpenAiServer({}, { engine: 'mlx', maxTokens: 258_048 }).max_tokens).toBe(
      258_048,
    );
    expect(shapeForOpenAiServer({}, { engine: 'omlx', maxTokens: 258_048 }).max_tokens).toBe(
      258_048,
    );
    expect(shapeForOpenAiServer({}, { engine: 'rapid-mlx', maxTokens: 258_048 }).max_tokens).toBe(
      undefined,
    );
    // A caller's own cap (the bench's 24, the titler's 40) is kept.
    expect(
      shapeForOpenAiServer({ max_tokens: 40 }, { engine: 'mlx', maxTokens: 258_048 }).max_tokens,
    ).toBe(40);
    expect(shapeForOpenAiServer({}, { maxTokens: 258_048 }).max_tokens).toBe(undefined);
  });

  it("thinks by default, like llama.cpp — and keeps a caller's own switch", async () => {
    // MEASURED 2026-09-13: rapid-mlx answers without thinking unless asked;
    // the bench and the titler ask for none and must stay that way.
    const { shapeForOpenAiServer } = await import('./stream.js');
    const off = shapeForOpenAiServer({ chat_template_kwargs: { enable_thinking: false } });
    expect(off.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: true,
      preserved_thinking: true,
      preserve_reasoning: true,
    });
    const custom = shapeForOpenAiServer({ chat_template_kwargs: { preserve_thinking: false } });
    expect((custom.chat_template_kwargs as { preserve_thinking: boolean }).preserve_thinking).toBe(
      false,
    );
  });
});

describe("settleReply — the reply as llama.cpp's parser would hand it over", () => {
  it('drops the newlines the template puts between </think> and the answer, and a whitespace-only text', async () => {
    const { settleReply } = await import('./stream.js');
    const thought = { type: 'thinking' as const, thinking: 'Let me look.' };
    expect(settleReply([thought, { type: 'text', text: '\n\nHere it is.' }])).toEqual([
      thought,
      { type: 'text', text: 'Here it is.' },
    ]);
    const call = {
      type: 'toolCall' as const,
      id: 'c1',
      name: 'bash',
      arguments: { command: 'ls' },
    };
    // MEASURED 2026-09-13 rapid-mlx: thinking | text "\n\n" | toolCall.
    expect(settleReply([thought, { type: 'text', text: '\n\n' }, call])).toEqual([thought, call]);
  });

  it('keeps a plain answer as it is', async () => {
    const { settleReply } = await import('./stream.js');
    const text = { type: 'text' as const, text: '\n\nLeading newlines with no thought stay.' };
    expect(settleReply([text])).toEqual([text]);
  });

  it('cuts an unfinished written tool call the engine flushed as content, keeping the prose before it', async () => {
    // rapid-mlx, stopping a looping call with finish_reason=length, hands the
    // buffered `<tool_call>` fragment over as content — the user saw it in the bubble.
    const { settleReply } = await import('./stream.js');
    const leaked =
      'Let me check.\n\n<tool_call>\n{"name": "bash", "arguments": {"command"' + ' '.repeat(40);
    expect(settleReply([{ type: 'text', text: leaked }])).toEqual([
      { type: 'text', text: 'Let me check.' },
    ]);
    expect(settleReply([{ type: 'text', text: '<tool_call>\n{"name": "bash"' }])).toEqual([]);
    // A complete written call is rung 0's business, not a leak: left alone here.
    const whole = {
      type: 'text' as const,
      text: '<tool_call>{"name":"bash","arguments":{}}</tool_call>',
    };
    expect(settleReply([whole])).toEqual([whole]);
  });
});
