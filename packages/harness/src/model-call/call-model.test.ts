import { describe, expect, it } from 'vitest';
import {
  callModelFromEnv,
  createOpenAiCompatCallModel,
  UTILITY_BASE_URL_ENV,
  UTILITY_MODEL_ENV,
} from './call-model.js';

function jsonFetch(content: string): {
  fetchImpl: typeof fetch;
  calls: RequestInit[];
  urls: string[];
} {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    calls.push(init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, urls };
}

describe('createOpenAiCompatCallModel', () => {
  it('POSTs to <base>/chat/completions and returns the message content', async () => {
    const { fetchImpl, calls, urls } = jsonFetch('hello world');
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://127.0.0.1:8080/v1/',
      model: 'gemma',
      apiKey: 'secret',
      fetchImpl,
    });
    const out = await callModel({ system: 'sys', prompt: 'hi', maxTokens: 32 });
    expect(out).toBe('hello world');
    // Trailing slash trimmed exactly once.
    expect(urls[0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
    const body = JSON.parse(calls[0]?.body as string);
    expect(body.model).toBe('gemma');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(32);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
  });

  it('forwards response_format and extraBody, but never lets extraBody override core fields', async () => {
    const { fetchImpl, calls } = jsonFetch('{}');
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://x/v1',
      model: 'gemma',
      fetchImpl,
    });
    await callModel({
      prompt: 'hi',
      responseFormat: { type: 'json_object' },
      // extraBody tries (and must fail) to clobber model/messages/stream.
      extraBody: {
        chat_template_kwargs: { enable_thinking: false },
        model: 'HIJACK',
        stream: true,
      },
    });
    const body = JSON.parse(calls[0]?.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    // The caller's switch stays; the preserved-thinking switches ride along so
    // the history renders as the chat's own requests render it.
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: true,
      preserved_thinking: true,
      preserve_reasoning: true,
    });
    // Core fields set by the seam win over extraBody.
    expect(body.model).toBe('gemma');
    expect(body.stream).toBe(false);
  });

  it('sends a prior turn the way the chat provider does — thoughts, calls, results', async () => {
    // MEASURED 2026-09-13: a reply carried as bare text rendered with an EMPTY
    // think block where the turn had its thoughts, and the server's one slot
    // was rewritten from there — the next turn prefilled the reply again.
    const { fetchImpl, calls } = jsonFetch('{"title":"x"}');
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://h/v1',
      model: 'm',
      fetchImpl,
    });
    await callModel({
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'I should run it.',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.txt' },
        { role: 'assistant', content: 'Done: a.txt' },
      ],
      prompt: 'name this',
    });
    const body = JSON.parse(calls[0]?.body as string);
    expect(body.messages).toEqual([
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should run it.',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', content: 'a.txt', tool_call_id: 'c1', name: 'bash' },
      { role: 'assistant', content: 'Done: a.txt' },
      { role: 'user', content: 'name this' },
    ]);
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl,
    });
    await expect(callModel({ prompt: 'hi' })).rejects.toThrow(/503/);
  });
});

describe('createOpenAiCompatCallModel — default timeout (SB-4)', () => {
  // A fetch that never resolves on its own but honours the abort signal — models
  // a hung utility endpoint. The default timeout must abort it so review /
  // escalation / fixer calls can never hang the agent turn.
  const hangingFetch = (): typeof fetch =>
    ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;

  it('aborts a hung request after the default timeout (fails open, never hangs)', async () => {
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: hangingFetch(),
      timeoutMs: 20,
    });
    await expect(callModel({ prompt: 'hi' })).rejects.toThrow();
  });

  it('composes the caller signal with the timeout (a caller abort still wins)', async () => {
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: hangingFetch(),
      timeoutMs: 60_000, // long, so the caller's abort is what ends the call
    });
    const ac = new AbortController();
    const p = callModel({ prompt: 'hi', signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('callModelFromEnv', () => {
  it('returns undefined when no base URL is configured', () => {
    expect(callModelFromEnv({})).toBeUndefined();
    expect(callModelFromEnv({ [UTILITY_BASE_URL_ENV]: '' })).toBeUndefined();
  });

  it('builds a working callModel from env vars', async () => {
    const { fetchImpl, urls } = jsonFetch('ok');
    const callModel = callModelFromEnv(
      { [UTILITY_BASE_URL_ENV]: 'http://127.0.0.1:9000/v1', [UTILITY_MODEL_ENV]: 'utility-x' },
      fetchImpl,
    );
    expect(callModel).toBeDefined();
    const out = await callModel?.({ prompt: 'ping' });
    expect(out).toBe('ok');
    expect(urls[0]).toBe('http://127.0.0.1:9000/v1/chat/completions');
  });
});
