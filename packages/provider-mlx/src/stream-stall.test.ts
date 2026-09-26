/**
 * The stall watchdog on the MLX provider — rapid-mlx in particular, whose
 * hermes parser holds a tool call back until it closes. The measured failure
 * (2026-09-26): a thought, the "\n\n" after `</think>`, then 300 s of
 * `: keepalive` comments and nothing else.
 */
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createMlxStream } from './stream.js';

const S = 1000;

type Step =
  | { readonly data: unknown }
  | { readonly comment: string }
  | { readonly wait: number }
  | { readonly hang: true };

/** One script per chat request; `/v1/status` answers `status()`. */
function scriptedServer(scripts: readonly (readonly Step[])[], status: () => unknown = () => 404) {
  const state = { chats: 0, probes: 0, aborted: [] as boolean[] };
  const enc = new TextEncoder();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/status')) {
      state.probes++;
      const answer = status();
      return typeof answer === 'number'
        ? new Response('', { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 });
    }
    const n = state.chats++;
    const script = scripts[n] ?? [];
    const signal = init?.signal ?? undefined;
    state.aborted[n] = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        signal?.addEventListener(
          'abort',
          () => {
            state.aborted[n] = true;
            if (open) controller.error(signal.reason);
            open = false;
          },
          { once: true },
        );
        for (const step of script) {
          if (!open) return;
          if ('data' in step) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(step.data)}\n\n`));
          } else if ('comment' in step) {
            controller.enqueue(enc.encode(`: ${step.comment}\n\n`));
          } else if ('wait' in step) {
            await new Promise((r) => setTimeout(r, step.wait));
          } else return; // hang
        }
        if (!open) return;
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        open = false;
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

const data = (chunk: unknown): Step => ({ data: chunk });
const role: Step = data({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
const reasoning = (t: string): Step => data({ choices: [{ delta: { reasoning_content: t } }] });
const content = (t: string): Step => data({ choices: [{ delta: { content: t } }] });
const toolCall = (name: string, args: unknown): Step[] => [
  data({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  }),
  data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
];
/** rapid-mlx's disconnect guard: a comment every 20 s while nothing else is sent. */
const keepalives = (n: number): Step[] =>
  Array.from({ length: n }, () => [{ wait: 20 * S }, { comment: 'keepalive' }] as Step[]).flat();

function model(id = 'qwen3.5-4b-mtp@rapid-mlx'): Model<'openai-completions'> {
  return {
    id,
    name: 'Qwen3.5 4B',
    api: 'openai-completions',
    provider: 'mlx',
    baseUrl: 'http://127.0.0.1:54228/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  };
}
const ctx: Context = {
  systemPrompt: 'sys',
  messages: [
    { role: 'user', content: 'Explain projectile motion with an animation', timestamp: 0 },
  ],
  tools: [
    {
      name: 'math',
      description: 'render a math page',
      parameters: { type: 'object', properties: { spec: { type: 'string' } } } as never,
    },
  ],
};

async function drain(
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

describe('mlx stream — a stream that stops', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    // Only the clocks; undici moves a Response body along on setImmediate.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as MockInstance<
      typeof process.stderr.write
    >;
  });
  afterEach(() => {
    stderr.mockRestore();
    vi.useRealTimers();
  });
  const stallLines = () =>
    stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[pi-stall]'));

  it('THE MEASURED CASE, ENGINE WEDGED: thought, "\\n\\n", keepalives, steps frozen → retried at 90 s', async () => {
    const { fetchImpl, state } = scriptedServer(
      [
        [role, reasoning('The user wants an animation.'), content('\n\n'), ...keepalives(30)],
        [role, reasoning('A math page.'), content('\n\n'), ...toolCall('math', { spec: 'x' })],
      ],
      () => ({ status: 'generating', steps_executed: 5231, num_running: 1 }),
    );
    const run = drain(createMlxStream({ fetchImpl })(model(), ctx));
    await vi.advanceTimersByTimeAsync(89 * S);
    expect(state.chats).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * S);
    expect(state.chats).toBe(2);
    const { events, final } = await run;
    expect(state.aborted).toEqual([true, false]);
    expect(final.stopReason).toBe('toolUse');
    // Only the retry's reply is kept (the whitespace text is settled away).
    expect(final.content).toEqual([
      { type: 'thinking', thinking: 'A math page.' },
      { type: 'toolCall', id: 'call_1', name: 'math', arguments: { spec: 'x' } },
    ]);
    expect(events.filter((e) => e.type === 'thinking_start').map((e) => e.contentIndex)).toEqual([
      0, 0,
    ]);
    expect(stallLines()).toHaveLength(1);
    expect(stallLines()[0]).toContain('no output for 90 s, and the engine reported no work');
  });

  it('THE MEASURED CASE, ENGINE WORKING: twelve silent minutes of a held-back call are left alone', async () => {
    let steps = 1000;
    const { fetchImpl, state } = scriptedServer(
      [
        [
          role,
          reasoning('I will write the page.'),
          content('\n\n'),
          ...keepalives(36), // 720 s
          ...toolCall('math', { spec: 'a very long spec' }),
        ],
      ],
      () => {
        steps += 370; // ~37 tok/s, none of it streamed
        return { status: 'generating', steps_executed: steps, num_running: 1 };
      },
    );
    const run = drain(createMlxStream({ fetchImpl })(model(), ctx));
    await vi.advanceTimersByTimeAsync(725 * S);
    const { final } = await run;
    expect(state.chats).toBe(1);
    expect(state.aborted).toEqual([false]);
    expect(state.probes).toBeGreaterThan(60);
    expect(final.stopReason).toBe('toolUse');
    expect(stallLines()).toEqual([]);
  });

  it('an engine with no status endpoint: mid-thought → 90 s; after text started → the blind 10 min', async () => {
    const midThought = scriptedServer([
      [role, reasoning('hmm'), ...keepalives(30)],
      [role, content('ok'), data({ choices: [{ delta: {}, finish_reason: 'stop' }] })],
    ]);
    const a = drain(
      createMlxStream({ fetchImpl: midThought.fetchImpl })(model('/models/qwen'), ctx),
    );
    await vi.advanceTimersByTimeAsync(91 * S);
    expect(midThought.state.chats).toBe(2);
    expect((await a).final.content).toEqual([{ type: 'text', text: 'ok' }]);

    const afterText = scriptedServer([
      [role, reasoning('hmm'), content('Let me write it.'), ...keepalives(40)],
      [role, content('ok'), data({ choices: [{ delta: {}, finish_reason: 'stop' }] })],
    ]);
    const b = drain(
      createMlxStream({ fetchImpl: afterText.fetchImpl })(model('/models/qwen'), ctx),
    );
    await vi.advanceTimersByTimeAsync(599 * S);
    expect(afterText.state.chats).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * S);
    expect(afterText.state.chats).toBe(2);
    await b;
    expect(stallLines()[1]).toContain('cannot report whether it is still generating');
  });

  it('a retry that stalls too: a plain error, and no half-built tool call left behind', async () => {
    const { fetchImpl, state } = scriptedServer(
      [
        [role, reasoning('a'), content('\n\n'), ...keepalives(30)],
        [
          role,
          reasoning('b'),
          data({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'math' } }] } },
            ],
          }),
          ...keepalives(30),
        ],
      ],
      () => ({ steps_executed: 9 }),
    );
    const run = drain(createMlxStream({ fetchImpl })(model(), ctx));
    await vi.advanceTimersByTimeAsync(400 * S);
    const { events, final } = await run;
    expect(state.chats).toBe(2);
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toMatch(
      /^The model stopped responding: no output for 90 s, and the engine reported no work in progress\. It was cancelled and sent again/,
    );
    expect(final.content).toEqual([{ type: 'thinking', thinking: 'b' }]);
    expect(events.filter((e) => e.type === 'thinking_end')).toHaveLength(2);
  });
});
