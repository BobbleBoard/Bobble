/**
 * The stall watchdog, through the real provider: a scripted server, a fake
 * clock, and the request cancelled the way undici cancels one (the body errors
 * with the abort reason).
 */
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createLlamaCppStream } from './stream.js';

const S = 1000;

type Step =
  | { readonly data: unknown }
  | { readonly comment: string }
  | { readonly wait: number }
  | { readonly hang: true };

interface Server {
  readonly fetchImpl: typeof fetch;
  readonly chats: number;
  readonly probes: number;
  readonly aborted: readonly boolean[];
}

/**
 * One script per chat request; `/slots` answers `slots()` (a slot list, or a
 * status code). A `hang` step never sends anything again until the request is
 * aborted — which is the failure being guarded.
 */
function scriptedServer(
  scripts: readonly (readonly Step[])[],
  slots: () => unknown = () => 404,
): Server {
  const state = { chats: 0, probes: 0, aborted: [] as boolean[] };
  const enc = new TextEncoder();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/slots')) {
      state.probes++;
      const answer = slots();
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
          if ('data' in step)
            controller.enqueue(enc.encode(`data: ${JSON.stringify(step.data)}\n\n`));
          else if ('comment' in step) controller.enqueue(enc.encode(`: ${step.comment}\n\n`));
          else if ('wait' in step) await new Promise((r) => setTimeout(r, step.wait));
          else return; // hang
        }
        if (!open) return;
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        open = false;
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get chats() {
      return state.chats;
    },
    get probes() {
      return state.probes;
    },
    get aborted() {
      return state.aborted;
    },
  };
}

const data = (chunk: unknown): Step => ({ data: chunk });
const reasoning = (t: string): Step => data({ choices: [{ delta: { reasoning_content: t } }] });
const content = (t: string): Step => data({ choices: [{ delta: { content: t } }] });
const finish: Step = data({ choices: [{ delta: {}, finish_reason: 'stop' }] });
/** rapid-mlx / llama.cpp keepalive: a comment every 20 s, forever. */
const keepalives = (n: number): Step[] =>
  Array.from({ length: n }, () => [{ wait: 20 * S }, { comment: 'keepalive' }] as Step[]).flat();

function model(): Model<'openai-completions'> {
  return {
    id: 'qwen3.5-4b',
    name: 'Qwen',
    api: 'openai-completions',
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  };
}
const ctx: Context = {
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'explain projectile motion', timestamp: 0 }],
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

describe('llama.cpp stream — a stream that stops', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    // Only the clocks the watchdog and the scripted server use. undici moves a
    // Response body along on setImmediate; faking that stalls the body itself.
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

  it('cancels a silent stream (keepalives only), sends it again, and keeps ONLY the retry', async () => {
    const server = scriptedServer(
      [
        [reasoning('The ball has two '), reasoning('velocity components'), ...keepalives(30)],
        [reasoning('Horizontal and vertical.'), content('Here is the idea.'), finish],
      ],
      () => [{ id: 0, is_processing: true, next_token: { n_decoded: 140 } }], // frozen
    );
    const s = createLlamaCppStream({ fetchImpl: server.fetchImpl, serverReturnWaitMs: 0 });
    const run = drain(s(model(), ctx));
    await vi.advanceTimersByTimeAsync(89 * S);
    expect(server.chats).toBe(1); // keepalives every 20 s did not keep it alive…
    await vi.advanceTimersByTimeAsync(2 * S);
    expect(server.chats).toBe(2); // …and at 90 s it was cancelled and sent again
    const { events, final } = await run;

    expect(server.aborted).toEqual([true, false]);
    expect(final.stopReason).toBe('stop');
    expect(final.content).toEqual([
      { type: 'thinking', thinking: 'Horizontal and vertical.' },
      { type: 'text', text: 'Here is the idea.' },
    ]);
    // The retry's first block re-uses index 0: the thread's cue to clear what
    // the stalled attempt showed.
    const starts = events.filter((e) => e.type === 'thinking_start').map((e) => e.contentIndex);
    expect(starts).toEqual([0, 0]);
    // Every block that started also ended.
    expect(events.filter((e) => e.type === 'thinking_end')).toHaveLength(2);
    expect(stallLines()).toHaveLength(1);
    expect(stallLines()[0]).toContain('engine reported no work in progress');
    expect(stallLines()[0]).toContain('sending it again (1 of 1)');
  });

  it('a retry that stalls too ends the turn with a plain error — no third request', async () => {
    const server = scriptedServer(
      [
        [reasoning('a'), ...keepalives(30)],
        [reasoning('b'), content('\n\n'), ...keepalives(30)],
      ],
      () => [{ id: 0, next_token: { n_decoded: 5 } }],
    );
    const s = createLlamaCppStream({ fetchImpl: server.fetchImpl, serverReturnWaitMs: 0 });
    const run = drain(s(model(), ctx));
    await vi.advanceTimersByTimeAsync(400 * S);
    const { final } = await run;
    expect(server.chats).toBe(2);
    expect(server.aborted).toEqual([true, true]);
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toMatch(/^The model stopped responding: no output for 90 s/);
    expect(final.errorMessage).toContain('sent again, and the new attempt stalled the same way');
    // Nothing half-built is left in the message.
    expect(final.content.every((b) => b.type !== 'toolCall')).toBe(true);
  });

  it('A SILENCE WHILE THE SERVER IS STILL DECODING IS LEFT ALONE', async () => {
    let decoded = 0;
    const server = scriptedServer(
      [
        [
          reasoning('I will write the file.'),
          content('\n\n'),
          // Twelve minutes of nothing on the wire: longer than even the blind
          // window, so only the engine's own counter can keep this alive.
          { wait: 720 * S },
          data({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'write', arguments: '{"path":"a"}' } },
                  ],
                },
              },
            ],
          }),
          data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        ],
      ],
      () => {
        decoded += 400;
        return [{ id: 0, is_processing: true, next_token: { n_decoded: decoded } }];
      },
    );
    const s = createLlamaCppStream({ fetchImpl: server.fetchImpl, serverReturnWaitMs: 0 });
    const run = drain(s(model(), ctx));
    await vi.advanceTimersByTimeAsync(730 * S);
    const { final } = await run;
    expect(server.chats).toBe(1);
    expect(server.probes).toBeGreaterThan(60); // asked every 10 s while quiet
    expect(final.stopReason).toBe('toolUse');
    expect(final.content.find((b) => b.type === 'toolCall')).toMatchObject({ name: 'write' });
    expect(stallLines()).toEqual([]);
  });

  it('a prefill that is still moving counts, however long it is', async () => {
    const frames: Step[] = [];
    // Forty frames, 20 s apart: a 13-minute prefill, past the blind window,
    // on a server whose /slots is missing — the frames are the only evidence.
    for (let i = 1; i <= 40; i++) {
      frames.push(
        { wait: 20 * S },
        { data: { choices: [], prompt_progress: { total: 400_000, processed: i * 10_000 } } },
      );
    }
    const server = scriptedServer([[...frames, content('done'), finish]]); // /slots 404: blind
    const s = createLlamaCppStream({ fetchImpl: server.fetchImpl, serverReturnWaitMs: 0 });
    const run = drain(s(model(), ctx));
    await vi.advanceTimersByTimeAsync(820 * S);
    const { final } = await run;
    expect(server.chats).toBe(1);
    expect(final.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('the person pressing Stop during a stall is an abort, not a retry', async () => {
    const server = scriptedServer([[reasoning('a'), ...keepalives(30)]], () => [
      { id: 0, next_token: { n_decoded: 1 } },
    ]);
    const s = createLlamaCppStream({ fetchImpl: server.fetchImpl, serverReturnWaitMs: 0 });
    const stop = new AbortController();
    const run = drain(s(model(), ctx, { signal: stop.signal }));
    await vi.advanceTimersByTimeAsync(30 * S);
    stop.abort();
    await vi.advanceTimersByTimeAsync(200 * S);
    const { final } = await run;
    expect(server.chats).toBe(1);
    expect(final.stopReason).toBe('aborted');
    expect(stallLines()).toEqual([]);
  });

  it('PI_STREAM_STALL_MS=0 turns the watchdog off', async () => {
    vi.stubEnv('PI_STREAM_STALL_MS', '0');
    try {
      const server = scriptedServer([[reasoning('a'), { wait: 900 * S }, content('late'), finish]]);
      const s = createLlamaCppStream({ fetchImpl: server.fetchImpl, serverReturnWaitMs: 0 });
      const run = drain(s(model(), ctx));
      await vi.advanceTimersByTimeAsync(901 * S);
      const { final } = await run;
      expect(server.chats).toBe(1);
      expect(server.probes).toBe(0);
      expect(final.content.at(-1)).toEqual({ type: 'text', text: 'late' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
