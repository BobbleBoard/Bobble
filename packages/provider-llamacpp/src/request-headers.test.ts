/**
 * DEV-2: a models.json `headers` / `apiKey` / `authHeader` reaches the wire,
 * and nothing changes when there is none.
 *
 * The end-to-end case drives pi's REAL ModelRegistry over a real models.json
 * file and hands our stream exactly what pi-coding-agent's streamFn hands it
 * (`{ apiKey, headers }` from `getApiKeyAndHeaders`) — the path on which the
 * headers used to vanish.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRequestHeaders, isRealApiKey, NO_API_KEY } from './request-headers.js';
import { createLlamaCppStream } from './stream.js';

function makeModel(headers?: Record<string, string>): Model<Api> {
  return {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    api: 'llamacpp-stream',
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
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

/** A fetch that records each request's init and answers one SSE reply. */
function recordingFetch(): { fetchImpl: typeof fetch; inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    inits.push(init);
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      yield enc.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      );
      yield enc.encode('data: [DONE]\n\n');
    }
    return { ok: true, status: 200, body: body(), headers: new Headers() } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, inits };
}

async function send(
  model: Model<Api>,
  options?: SimpleStreamOptions,
): Promise<Record<string, string>> {
  const { fetchImpl, inits } = recordingFetch();
  const stream = createLlamaCppStream({ fetchImpl, serverReturnWaitMs: 0 })(model, ctx, options);
  for await (const e of stream as AsyncIterable<AssistantMessageEvent>) {
    if (e.type === 'error') throw new Error(e.error.errorMessage ?? 'stream error');
  }
  expect(inits).toHaveLength(1);
  return inits[0]?.headers as Record<string, string>;
}

describe('buildRequestHeaders', () => {
  it('is exactly the old object when there is nothing to add', () => {
    expect(buildRequestHeaders(makeModel())).toEqual({ 'content-type': 'application/json' });
    expect(buildRequestHeaders(makeModel({ 'X-A': '1' }), { apiKey: NO_API_KEY })).toEqual({
      'content-type': 'application/json',
      'X-A': '1',
    });
    expect(buildRequestHeaders(makeModel(), { headers: {}, apiKey: '  ' })).toEqual({
      'content-type': 'application/json',
    });
  });

  it('lets option headers replace model headers, whatever the case, never sending both', () => {
    const h = buildRequestHeaders(makeModel({ 'X-Device': 'model', 'x-keep': 'k' }), {
      headers: { 'x-device': 'options' },
    });
    expect(h).toEqual({ 'content-type': 'application/json', 'x-keep': 'k', 'x-device': 'options' });
    expect(new Headers(h).get('x-device')).toBe('options');
  });

  it('sends a real key as a bearer token, unless a header already authorizes', () => {
    expect(buildRequestHeaders(makeModel(), { apiKey: ' sk-live ' })).toEqual({
      'content-type': 'application/json',
      Authorization: 'Bearer sk-live',
    });
    expect(
      buildRequestHeaders(makeModel(), {
        apiKey: 'sk-live',
        headers: { authorization: 'Bearer from-headers' },
      }),
    ).toEqual({ 'content-type': 'application/json', authorization: 'Bearer from-headers' });
  });

  it('treats the app’s "none" placeholder, in any case, as no key', () => {
    expect(isRealApiKey('none')).toBe(false);
    expect(isRealApiKey('NONE')).toBe(false);
    expect(isRealApiKey(undefined)).toBe(false);
    expect(isRealApiKey('sk-1')).toBe(true);
  });
});

describe('the llama.cpp stream puts them on the wire', () => {
  it('sends only content-type for the app’s own models.json block (unchanged)', async () => {
    expect(await send(makeModel(), { apiKey: 'none' })).toEqual({
      'content-type': 'application/json',
    });
    expect(await send(makeModel())).toEqual({ 'content-type': 'application/json' });
  });

  it('sends option headers and a bearer key', async () => {
    const h = await send(makeModel(), {
      apiKey: 'sk-remote',
      headers: { 'X-Bobble-Device': 'linux-MS-7E59' },
    });
    expect(h).toEqual({
      'content-type': 'application/json',
      'X-Bobble-Device': 'linux-MS-7E59',
      Authorization: 'Bearer sk-remote',
    });
  });

  it('still sends model headers', async () => {
    expect(await send(makeModel({ 'X-Model': 'm' }))).toEqual({
      'content-type': 'application/json',
      'X-Model': 'm',
    });
  });
});

describe('end to end through pi’s own registry and models.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dev2-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** What pi-coding-agent 0.68.1's streamFn does before calling streamSimple (sdk.js). */
  async function piOptions(file: string, provider: string, id: string) {
    const registry = ModelRegistry.create(AuthStorage.inMemory(), file);
    const model = registry.find(provider, id);
    if (model === undefined)
      throw new Error(`models.json did not load: ${registry.getError?.() ?? ''}`);
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    return {
      model,
      options: {
        apiKey: auth.apiKey,
        ...(auth.headers !== undefined ? { headers: { ...auth.headers } } : {}),
      } as SimpleStreamOptions,
    };
  }

  it('headers + authHeader + apiKey written to models.json reach the request', async () => {
    const file = path.join(dir, 'models.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          llamacpp: {
            baseUrl: 'http://127.0.0.1:18765/v1',
            api: 'llamacpp-stream',
            apiKey: 'sk-remote-123',
            authHeader: true,
            headers: { 'X-Bobble-Device': 'linux-MS-7E59' },
            models: [{ id: 'qwen3.6-27b', headers: { 'X-Model-Hint': 'max' } }],
          },
        },
      }),
    );
    const { model, options } = await piOptions(file, 'llamacpp', 'qwen3.6-27b');
    // pi keeps them off the model: this is why the old `model.headers` spread sent nothing.
    expect(model.headers).toBeUndefined();
    const h = await send(model, options);
    expect(new Headers(h).get('authorization')).toBe('Bearer sk-remote-123');
    expect(new Headers(h).get('x-bobble-device')).toBe('linux-MS-7E59');
    expect(new Headers(h).get('x-model-hint')).toBe('max');
    expect(new Headers(h).get('content-type')).toBe('application/json');
  });

  it('a key without authHeader is still sent, as pi’s own OpenAI path would', async () => {
    const file = path.join(dir, 'models.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          llamacpp: {
            baseUrl: 'http://127.0.0.1:18765/v1',
            api: 'llamacpp-stream',
            apiKey: 'sk-plain',
            models: [{ id: 'm' }],
          },
        },
      }),
    );
    const { model, options } = await piOptions(file, 'llamacpp', 'm');
    expect(options.headers).toBeUndefined();
    expect(new Headers(await send(model, options)).get('authorization')).toBe('Bearer sk-plain');
  });

  it('the block the app writes today sends exactly what it sent before', async () => {
    const file = path.join(dir, 'models.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          llamacpp: {
            baseUrl: 'http://127.0.0.1:8080/v1',
            api: 'llamacpp-stream',
            apiKey: 'none',
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: false,
            },
            models: [
              {
                id: 'qwen3.5-4b',
                name: 'Qwen3.5 4B',
                input: ['text'],
                contextWindow: 32768,
                maxTokens: 28672,
              },
            ],
          },
        },
      }),
    );
    const { model, options } = await piOptions(file, 'llamacpp', 'qwen3.5-4b');
    expect(options.apiKey).toBe('none');
    expect(await send(model, options)).toEqual({ 'content-type': 'application/json' });
  });
});
