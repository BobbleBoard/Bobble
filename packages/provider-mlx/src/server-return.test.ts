/**
 * A REFUSED CONNECTION WAITS FOR THE SERVER — on MLX as on llama.cpp. A parked
 * or respawning MLX engine used to end the turn at once in a raw "fetch
 * failed" (the user, 2026-10-08: "our dreaded 'fetch failed'").
 */
import type { Api, AssistantMessageEvent, Context, Model } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import { createMlxStream } from './stream.js';

const model: Model<Api> = {
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
};
const ctx: Context = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
};

const refused = (): Error => {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
  });
  return err;
};

function server(downFor: number) {
  const seen: string[] = [];
  let refusals = 0;
  const fetchImpl = (async (url: string) => {
    seen.push(String(url));
    if (refusals < downFor) {
      refusals += 1;
      throw refused();
    }
    if (String(url).endsWith('/models')) return { ok: true, status: 200 } as Response;
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      yield enc.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'back' }, finish_reason: 'stop' }] })}\n\n`,
      );
      yield enc.encode('data: [DONE]\n\n');
    }
    return { ok: true, status: 200, body: body(), headers: new Headers() } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

async function run(deps: Parameters<typeof createMlxStream>[0]) {
  let text = '';
  let error: string | undefined;
  for await (const e of createMlxStream(deps)(
    model,
    ctx,
    {},
  ) as AsyncIterable<AssistantMessageEvent>) {
    if (e.type === 'text_delta') text += e.delta;
    if (e.type === 'error') error = e.error.errorMessage;
  }
  return { text, error };
}

describe('the MLX stream waits for a server on its way back', () => {
  it('a refused request polls /models and is sent again once the server answers', async () => {
    const { fetchImpl, seen } = server(2);
    const out = await run({ fetchImpl, serverReturnWaitMs: 2000, serverReturnPollMs: 5 });
    expect(out.error).toBeUndefined();
    expect(out.text).toBe('back');
    expect(seen.some((u) => u.endsWith('/v1/models'))).toBe(true);
  });

  it('a server that never comes back still ends the turn (after the wait)', async () => {
    const { fetchImpl } = server(1_000_000);
    const out = await run({ fetchImpl, serverReturnWaitMs: 40, serverReturnPollMs: 5 });
    expect(out.error).toMatch(/fetch failed/);
  });
});
