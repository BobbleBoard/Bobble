/**
 * The scripted model server (_mock-openai.mjs), read by the REAL provider.
 *
 * The point of the double is that everything downstream of the model is the
 * app's own code, so the most important test here is not "the JSON has the
 * right keys" but "@pi-desktop/provider-llamacpp's own stream parser turns
 * these frames into the text, thinking and tool call that were scripted".
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLlamaCppStream } from '@pi-desktop/provider-llamacpp';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error - the mock is plain ESM for probes, not typed app code.
import { renderPrompt, startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';

type Mock = Awaited<ReturnType<typeof startMockOpenAI>>;
type Entry = Record<string, unknown>;
type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

let mock: Mock | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

const post = (url: string, body: unknown, init: RequestInit = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });

/** Drive the real provider stream once and return the finished message. */
async function providerTurn(
  baseUrl: string,
  user: string,
  extra: { tools?: unknown[]; history?: unknown[] } = {},
) {
  const stream = createLlamaCppStream({ serverReturnWaitMs: 0 });
  const model = {
    id: 'mock-4b',
    name: 'Mock 4B',
    api: 'llamacpp-stream',
    provider: 'mock',
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
  const context = {
    systemPrompt: 'You are a test.',
    messages: [...(extra.history ?? []), { role: 'user', content: user, timestamp: 0 }],
    tools: extra.tools,
  };
  // biome-ignore lint/suspicious/noExplicitAny: the provider's pi-ai types are not a dependency of this package.
  const events = stream(model as any, context as any, {} as any);
  let final: { content: Block[]; stopReason: string } | undefined;
  for await (const e of events as AsyncIterable<{
    type: string;
    message?: unknown;
    error?: unknown;
  }>) {
    if (e.type === 'done') final = e.message as typeof final;
    if (e.type === 'error') throw new Error(JSON.stringify(e.error));
  }
  if (final === undefined) throw new Error('stream never finished');
  return final;
}

const BASH = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
};

describe('the real provider reads the mock', () => {
  it('streams text', async () => {
    mock = await startMockOpenAI({
      rules: [{ match: { lastUser: 'hello' }, reply: { content: 'Hi there, friend.' } }],
    });
    const msg = await providerTurn(mock.baseUrl, 'hello');
    expect(
      msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ).toBe('Hi there, friend.');
    expect(msg.stopReason).toBe('stop');
  });

  it('streams reasoning_content as a thinking block', async () => {
    mock = await startMockOpenAI({
      rules: [{ reply: { reasoning: 'Let me think this through.', content: 'Four.' } }],
    });
    const msg = await providerTurn(mock.baseUrl, 'two plus two?');
    expect(msg.content.find((b) => b.type === 'thinking')?.thinking).toBe(
      'Let me think this through.',
    );
    expect(msg.content.find((b) => b.type === 'text')?.text).toBe('Four.');
  });

  it('streams one scripted tool call, arguments intact, as toolUse', async () => {
    mock = await startMockOpenAI({
      rules: [
        {
          name: 'call',
          match: { lastUser: 'run it' },
          reply: {
            toolCalls: [
              { name: 'bash', arguments: { command: 'echo "a long enough argument to split"' } },
            ],
          },
        },
      ],
    });
    const msg = await providerTurn(mock.baseUrl, 'run it', { tools: [BASH] });
    const call = msg.content.find((b) => b.type === 'toolCall');
    expect(call?.name).toBe('bash');
    expect(call?.arguments).toEqual({ command: 'echo "a long enough argument to split"' });
    expect(msg.stopReason).toBe('toolUse');
    const entry = mock.log.at(-1) as Entry;
    expect(entry.rule).toBe('call');
    expect(entry.tools).toEqual(['bash']);
    expect(entry.stream).toBe(true);
  });
});

describe('scripting', () => {
  it('matches by step marker, after a tool result, in sequence, and falls back to the default', async () => {
    mock = await startMockOpenAI({
      defaultReply: { content: 'default' },
      rules: [
        {
          name: 'outline',
          match: { marker: 'STEP:outline' },
          reply: [{ content: 'first' }, { content: 'second' }],
        },
        { name: 'after', match: { afterTool: 'exit 0' }, reply: { content: 'saw the result' } },
        { name: 'once', match: { lastUser: /^once$/ }, times: 1, reply: { content: 'only once' } },
      ],
    });
    const say = async (messages: unknown[]) => {
      const r = await post(`${mock?.baseUrl}/chat/completions`, { messages });
      return ((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]
        ?.message.content;
    };
    const sys = { role: 'system', content: 'Do STEP:outline now.' };
    expect(await say([sys, { role: 'user', content: 'go' }])).toBe('first');
    expect(await say([sys, { role: 'user', content: 'go' }])).toBe('second');
    expect(await say([sys, { role: 'user', content: 'go' }])).toBe('second');
    expect(
      await say([
        { role: 'user', content: 'x' },
        { role: 'tool', content: 'ran: exit 0' },
      ]),
    ).toBe('saw the result');
    expect(await say([{ role: 'user', content: 'once' }])).toBe('only once');
    expect(await say([{ role: 'user', content: 'once' }])).toBe('default');
    expect(mock.log.map((e: Entry) => e.rule)).toEqual([
      'outline',
      'outline',
      'outline',
      'after',
      'once',
      null,
    ]);
  });

  it('is loud when strict and nothing matches', async () => {
    mock = await startMockOpenAI({ strict: true });
    const r = await post(`${mock.baseUrl}/chat/completions`, {
      messages: [{ role: 'user', content: 'unscripted' }],
    });
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('unscripted');
  });

  it('serves a scripted HTTP error the way llama-server shapes it', async () => {
    mock = await startMockOpenAI({
      rules: [
        {
          reply: {
            status: 400,
            error: {
              code: 400,
              message: 'the request exceeds the available context size',
              type: 'exceed_context_size_error',
              n_prompt_tokens: 40000,
              n_ctx: 32768,
            },
          },
        },
      ],
    });
    const r = await post(`${mock.baseUrl}/chat/completions`, { messages: [] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe(
      'exceed_context_size_error',
    );
  });
});

describe('llama-server behaviours', () => {
  it('answers /health, /v1/models, /props and /slots', async () => {
    mock = await startMockOpenAI({ model: 'mock-4b', nCtx: 16384 });
    expect(await (await fetch(`${mock.url}/health`)).json()).toEqual({ status: 'ok' });
    mock.setLoading(true);
    expect((await fetch(`${mock.url}/health`)).status).toBe(503);
    mock.setLoading(false);
    const models = (await (await fetch(`${mock.url}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(models.data[0]?.id).toBe('mock-4b');
    const props = (await (await fetch(`${mock.url}/props`)).json()) as {
      default_generation_settings: { n_ctx: number };
      total_slots: number;
    };
    expect(props.default_generation_settings.n_ctx).toBe(16384);
    expect(props.total_slots).toBe(1);
    const slots = (await (await fetch(`${mock.url}/slots`)).json()) as Array<{
      is_processing: boolean;
    }>;
    expect(slots[0]?.is_processing).toBe(false);
  });

  it('stops generating and frees the slot when the client disconnects', async () => {
    mock = await startMockOpenAI({
      rules: [{ name: 'stall', reply: { content: 'never finishes', hang: true } }],
    });
    const ctrl = new AbortController();
    const res = await post(
      `${mock.baseUrl}/chat/completions`,
      { stream: true, messages: [{ role: 'user', content: 'x' }] },
      { signal: ctrl.signal },
    );
    const reader = res.body?.getReader();
    await reader?.read(); // the first frame arrived: the slot is generating
    const busy = (await (await fetch(`${mock.url}/slots`)).json()) as Array<{
      is_processing: boolean;
    }>;
    expect(busy[0]?.is_processing).toBe(true);
    const abortedAt = Date.now();
    ctrl.abort();
    const entry = (await mock.waitFor((e: Entry) => e.rule === 'stall', {
      timeoutMs: 3000,
    })) as Entry;
    expect(entry.cancelled).toBe(true);
    expect(Date.now() - abortedAt).toBeLessThan(500);
    const idle = (await (await fetch(`${mock.url}/slots`)).json()) as Array<{
      is_processing: boolean;
    }>;
    expect(idle[0]?.is_processing).toBe(false);
  });

  it('reports the prompt cache: a follow-up reuses the prefix, a rewritten history does not', async () => {
    mock = await startMockOpenAI({ rules: [{ reply: { content: 'fine' } }] });
    const sys = { role: 'system', content: 'S'.repeat(4000) };
    const turn1 = [sys, { role: 'user', content: 'first question' }];
    await post(`${mock.baseUrl}/chat/completions`, { messages: turn1 });
    const turn2 = [
      ...turn1,
      { role: 'assistant', content: 'fine' },
      { role: 'user', content: 'second' },
    ];
    await post(`${mock.baseUrl}/chat/completions`, { messages: turn2 });
    const rewritten = [{ role: 'system', content: `X${'S'.repeat(3999)}` }, ...turn2.slice(1)];
    await post(`${mock.baseUrl}/chat/completions`, { messages: rewritten });
    const [a, b, c] = mock.log as Entry[];
    expect(a?.cacheN).toBe(0);
    expect(b?.cacheN as number).toBeGreaterThan(1000);
    expect(b?.promptN as number).toBeLessThan(20);
    expect(c?.promptN as number).toBeGreaterThan(1000);
  });

  it('holds the first byte back by latencyMs', async () => {
    mock = await startMockOpenAI({ latencyMs: 150 });
    const t0 = Date.now();
    const r = await post(`${mock.baseUrl}/chat/completions`, { stream: true, messages: [] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    await r.text();
  });

  it('serves /completion with n_probs, streamed and whole', async () => {
    mock = await startMockOpenAI({
      rules: [{ match: { prompt: 'Rate' }, reply: { content: 'yes' } }],
    });
    const whole = (await (
      await post(`${mock.url}/completion`, { prompt: 'Rate this: ', n_probs: 3 })
    ).json()) as {
      content: string;
      completion_probabilities: Array<{ top_logprobs: unknown[] }>;
      timings: { prompt_n: number };
    };
    expect(whole.content).toBe('yes');
    expect(whole.completion_probabilities[0]?.top_logprobs).toHaveLength(3);
    expect(whole.timings.prompt_n).toBeGreaterThan(0);
    const streamed = await (
      await post(`${mock.url}/completion`, { prompt: 'Rate that: ', stream: true })
    ).text();
    const frames = streamed
      .split('\n\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(frames.at(-1)?.stop).toBe(true);
    expect(frames.map((f) => f.content).join('')).toBe('yes');
  });

  it('renders the same template /apply-template returns', async () => {
    mock = await startMockOpenAI();
    const body = {
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    };
    const r = (await (await post(`${mock.url}/apply-template`, body)).json()) as { prompt: string };
    expect(r.prompt).toBe(renderPrompt(body));
    expect(r.prompt.endsWith('<|im_start|>assistant\n')).toBe(true);
  });
});

describe('models.json and the command line', () => {
  it('writes a llamacpp-stream provider block beside the providers already there', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mock-openai-home-'));
    try {
      const file = path.join(home, '.pi', 'agent', 'models.json');
      writeModelsJson(home, { provider: 'other', baseUrl: 'http://x/v1', model: 'm1' });
      writeModelsJson(home, {
        provider: 'mock',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'mock-4b',
      });
      const json = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.keys(json.providers)).toEqual(['other', 'mock']);
      expect(json.providers.mock).toMatchObject({
        api: 'llamacpp-stream',
        apiKey: 'none',
        baseUrl: 'http://127.0.0.1:9/v1',
      });
      expect(json.providers.mock.models[0].id).toBe('mock-4b');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs as a process and reads a JSON rules file (regexes as {regex, flags})', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mock-openai-cli-'));
    const rules = path.join(dir, 'rules.json');
    writeFileSync(
      rules,
      JSON.stringify([
        { match: { lastUser: { regex: '^PING$', flags: 'i' } }, reply: { content: 'PONG' } },
      ]),
    );
    const child = spawn(process.execPath, [
      path.join(__dirname, '_mock-openai.mjs'),
      '--port',
      '0',
      '--rules',
      rules,
    ]);
    try {
      const ready = await new Promise<{ baseUrl: string }>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
          const m = /MOCK_OPENAI_READY (\{.*\})/.exec(out);
          if (m?.[1] !== undefined) resolve(JSON.parse(m[1]));
        });
        child.on('exit', (code) => reject(new Error(`exited ${code}`)));
      });
      const r = await post(`${ready.baseUrl}/chat/completions`, {
        messages: [{ role: 'user', content: 'ping' }],
      });
      expect(
        ((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]
          ?.message.content,
      ).toBe('PONG');
    } finally {
      child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
