/**
 * DEV-2 on the MLX / generic OpenAI path — the one a Bring-Your-Own endpoint
 * (LM Studio, Ollama, vLLM) binds to: models.json `headers` and `apiKey`
 * reach the wire, and nothing changes when there are none.
 */
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import { createMlxStream } from './stream.js';

function makeModel(headers?: Record<string, string>): Model<Api> {
  return {
    id: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    name: 'Qwen3.5 4B (MLX)',
    api: 'mlx-stream',
    provider: 'mlx',
    baseUrl: 'http://127.0.0.1:8181/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
    ...(headers !== undefined ? { headers } : {}),
  };
}

const ctx: Context = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
};

async function wireHeaders(
  model: Model<Api>,
  options?: SimpleStreamOptions,
): Promise<Record<string, string>> {
  const inits: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    inits.push(init);
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      yield enc.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 } })}\n\n`,
      );
      yield enc.encode('data: [DONE]\n\n');
    }
    return { ok: true, status: 200, body: body(), headers: new Headers() } as unknown as Response;
  }) as unknown as typeof fetch;
  for await (const e of createMlxStream({ fetchImpl })(
    model,
    ctx,
    options,
  ) as AsyncIterable<AssistantMessageEvent>) {
    if (e.type === 'error') throw new Error(e.error.errorMessage ?? 'stream error');
  }
  expect(inits).toHaveLength(1);
  return inits[0]?.headers as Record<string, string>;
}

describe('the MLX stream puts models.json headers and keys on the wire', () => {
  it('sends only content-type for the app’s own block (unchanged)', async () => {
    expect(await wireHeaders(makeModel(), { apiKey: 'none' })).toEqual({
      'content-type': 'application/json',
    });
    expect(await wireHeaders(makeModel())).toEqual({ 'content-type': 'application/json' });
  });

  it('sends pi’s option headers (authHeader: true puts the bearer there)', async () => {
    const h = await wireHeaders(makeModel(), {
      apiKey: 'lm-studio-key',
      headers: { Authorization: 'Bearer lm-studio-key', 'X-Client': 'bobble' },
    });
    expect(h).toEqual({
      'content-type': 'application/json',
      Authorization: 'Bearer lm-studio-key',
      'X-Client': 'bobble',
    });
  });

  it('sends a bare key as a bearer token', async () => {
    const h = await wireHeaders(makeModel({ 'X-Model': 'm' }), { apiKey: 'ollama-key' });
    expect(h).toEqual({
      'content-type': 'application/json',
      'X-Model': 'm',
      Authorization: 'Bearer ollama-key',
    });
  });
});
