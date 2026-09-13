import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatTemplatePath,
  chatTemplateSupported,
  ensureChatTemplate,
  extractChatTemplate,
  repoSlug,
} from './chat-template.js';

const REPO = 'google/gemma-4-E2B-it';

interface FakeInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

interface FakeResponseSpec {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly json?: unknown;
  readonly etag?: string;
}

function fakeResponse(spec: FakeResponseSpec): Response {
  const headers = new Map<string, string>();
  if (spec.etag !== undefined) headers.set('etag', spec.etag);
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    text: async () => spec.body ?? '',
    json: async () => spec.json,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  } as unknown as Response;
}

interface RecordedCall {
  readonly url: string;
  readonly method?: string;
  readonly auth?: string;
}

/** A mock fetch that records calls and drives responses from a handler. */
function mockFetch(handler: (url: string, init: FakeInit) => FakeResponseSpec) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: FakeInit) => {
    const url = String(input);
    const i = init ?? {};
    calls.push({ url, method: i.method, auth: i.headers?.authorization });
    return fakeResponse(handler(url, i));
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls, raw: fn };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-chat-tpl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('repoSlug / chatTemplatePath', () => {
  it('slugs a repo id filesystem-safely', () => {
    expect(repoSlug('google/gemma-4-E2B-it')).toBe('google--gemma-4-E2B-it');
    expect(chatTemplatePath('google/gemma-4-E2B-it', '/cache')).toBe(
      '/cache/google--gemma-4-E2B-it.jinja',
    );
  });
});

describe('extractChatTemplate', () => {
  it('reads the plain-string form', () => {
    expect(extractChatTemplate({ chat_template: 'PLAIN' })).toBe('PLAIN');
  });
  it('prefers the `default` entry in the array form', () => {
    expect(
      extractChatTemplate({
        chat_template: [
          { name: 'tool_use', template: 'TOOL' },
          { name: 'default', template: 'DEFAULT' },
        ],
      }),
    ).toBe('DEFAULT');
  });
  it('falls back to the first array entry with a string template', () => {
    expect(extractChatTemplate({ chat_template: [{ name: 'x', template: 'FIRST' }] })).toBe(
      'FIRST',
    );
  });
  it('returns undefined for missing/invalid shapes', () => {
    expect(extractChatTemplate({})).toBeUndefined();
    expect(extractChatTemplate(null)).toBeUndefined();
    expect(extractChatTemplate({ chat_template: 123 })).toBeUndefined();
  });
});

describe('ensureChatTemplate', () => {
  it('fetches chat_template.jinja, caches it, and records provenance', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: '{{ jinja tpl }}', etag: '"abc"' }));
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl });

    expect(r.source).toBe('jinja');
    expect(r.refreshed).toBe(true);
    expect(r.cached).toBe(false);
    expect(r.etag).toBe('abc'); // normalised: quotes stripped, lowercased
    expect(r.path).toBe(chatTemplatePath(REPO, dir));
    expect(await readFile(r.path, 'utf8')).toBe('{{ jinja tpl }}');
    expect(calls).toHaveLength(1);
  });

  it('sends the HF bearer token for gated base repos', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: 'x' }));
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, hfToken: 'hf_SECRET' });
    expect(calls[0]?.auth).toBe('Bearer hf_SECRET');
  });

  it('serves a fresh cache without any network on the second call', async () => {
    const now = () => 1_000_000;
    const { fetchImpl, calls } = mockFetch(() => ({ body: 'tpl', etag: '"e1"' }));
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now });
    const r2 = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now });
    expect(calls).toHaveLength(1); // second served from disk
    expect(r2.cached).toBe(true);
    expect(r2.refreshed).toBe(false);
    expect(r2.source).toBe('cache');
  });

  it('re-checks a stale cache via HEAD and keeps it when the ETag is unchanged', async () => {
    let t = 0;
    const now = () => t;
    const { fetchImpl, calls } = mockFetch((_url, init) =>
      init.method === 'HEAD' ? { etag: '"e1"' } : { body: 'tpl', etag: '"e1"' },
    );
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 100 });
    t = 10_000; // now stale
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 100 });
    expect(r.cached).toBe(true);
    expect(r.refreshed).toBe(false);
    // one GET (first) + one HEAD (second); no second body download.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.method === 'HEAD')).toBe(true);
  });

  it('re-downloads the body when the remote ETag changed', async () => {
    let t = 0;
    const now = () => t;
    let gets = 0;
    const { fetchImpl } = mockFetch((_url, init) => {
      if (init.method === 'HEAD') return { etag: '"NEW"' };
      gets += 1;
      return gets === 1 ? { body: 'old', etag: '"OLD"' } : { body: 'new', etag: '"NEW"' };
    });
    const first = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    expect(await readFile(first.path, 'utf8')).toBe('old');
    t = 1000; // stale
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    expect(r.refreshed).toBe(true);
    expect(await readFile(r.path, 'utf8')).toBe('new');
  });

  it('falls back to tokenizer_config.json when chat_template.jinja is 404', async () => {
    const { fetchImpl } = mockFetch((url) =>
      url.endsWith('chat_template.jinja')
        ? { ok: false, status: 404 }
        : { json: { chat_template: 'FROM_CONFIG' }, etag: '"c1"' },
    );
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl });
    expect(r.source).toBe('tokenizer_config');
    expect(await readFile(r.path, 'utf8')).toBe('FROM_CONFIG');
  });

  it('returns the stale cached body when a refresh fetch fails (resilient)', async () => {
    let t = 0;
    const now = () => t;
    let fail = false;
    const { fetchImpl } = mockFetch(() => {
      if (fail) throw new Error('network down');
      return { body: 'cached-body', etag: '"e1"' };
    });
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    t = 1000; // stale
    fail = true; // both HEAD and GET now throw
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    expect(r.cached).toBe(true);
    expect(r.refreshed).toBe(false);
    expect(await readFile(r.path, 'utf8')).toBe('cached-body');
  });

  it('throws when gated + no token + nothing cached', async () => {
    const { fetchImpl } = mockFetch(() => ({ ok: false, status: 401 }));
    await expect(ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl })).rejects.toThrow();
  });
});

describe('chatTemplateSupported', () => {
  /** A fake llama-server: emits `text` then closes. */
  const fakeServer = (text: string) => {
    const stream = {
      on(_e: 'data', cb: (c: Buffer | string) => void) {
        setTimeout(() => cb(text), 0);
      },
    };
    return () => ({
      stderr: stream as never,
      stdout: null,
      // The real server exits non-zero here (the model path is deliberately
      // bogus); the verdict is in what it printed, not in the code.
      on(_e: 'close', cb: (code: number | null) => void) {
        setTimeout(() => cb(1), 5);
      },
    });
  };

  it('reports a template llama.cpp cannot parse as unsupported', async () => {
    // The real message, from IFM/K2-Horizon-0.9B's transformers-flavour template.
    const ok = await chatTemplateSupported(
      '/fake/llama-server',
      '/fake/t.jinja',
      fakeServer(
        'common_chat_templates_init: error: parser: Parser Error: Expected %} (Got true)\nerror: the supplied chat template is not supported',
      ) as never,
    );
    expect(ok).toBe(false);
  });

  it('reports a template it accepts as supported, ignoring the missing-model error', async () => {
    // The check deliberately points at a model that does not exist — the template
    // verdict lands first, and this error is expected noise.
    const ok = await chatTemplateSupported(
      '/fake/llama-server',
      '/fake/t.jinja',
      fakeServer(
        'gguf_init_from_file: failed to open GGUF file\nerror: unable to load model',
      ) as never,
    );
    expect(ok).toBe(true);
  });
});

/*
 * PRESERVED THINKING — the history must render the bytes it was generated as,
 * or the prefix cache stops at the previous user message and the whole previous
 * turn is prefilled again (MEASURED 2026-09-13 on llama.cpp and rapid-mlx).
 */
describe('patchPreserveThinking', () => {
  const QWEN_GATE = `{%- if loop.index0 > ns.last_query_index %}
    {{- '<|im_start|>' + message.role + '\\n<think>\\n' + reasoning_content + '\\n</think>\\n\\n' + content }}
{%- else %}
    {{- '<|im_start|>' + message.role + '\\n' + content }}
{%- endif %}`;

  it('makes the official Qwen gate read preserve_thinking (after the reasoning_content guard)', async () => {
    const { patchChatTemplate, patchPreserveThinking } = await import('./chat-template.js');
    const out = patchChatTemplate(QWEN_GATE);
    expect(out).toContain(
      '{%- if (preserve_thinking is defined and preserve_thinking) or (loop.index0 > ns.last_query_index and reasoning_content) %}',
    );
    // Idempotent, and the second patch alone does nothing on an already-patched body.
    expect(patchChatTemplate(out)).toBe(out);
    expect(patchPreserveThinking(out)).toBe(out);
  });

  it('leaves templates that already read the variable, or do not gate on it, alone', async () => {
    const { patchPreserveThinking } = await import('./chat-template.js');
    const gemma =
      '{%- set preserve_thinking = preserve_thinking | default(false) -%}\n{%- if loop.index0 > ns.last_query_index and reasoning_content %}x{%- endif %}';
    expect(patchPreserveThinking(gemma)).toBe(gemma);
    const minicpm =
      "{%- if reasoning_content %}\n  {{- '<think>' + reasoning_content + '</think>' }}\n{%- endif %}";
    expect(patchPreserveThinking(minicpm)).toBe(minicpm);
  });
});

describe('patchModelDirTemplate / ensureGgufChatTemplate', () => {
  const GATE = `{%- if loop.index0 > ns.last_query_index and reasoning_content %}\nA\n{%- else %}\nB\n{%- endif %}`;

  it('patches chat_template.jinja and tokenizer_config.json in a model directory, once', async () => {
    const { patchModelDirTemplate } = await import('./chat-template.js');
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
    const d = await mkdtemp(join(tmpdir(), 'pi-model-dir-'));
    await writeFile(join(d, 'chat_template.jinja'), GATE);
    await writeFile(
      join(d, 'tokenizer_config.json'),
      JSON.stringify({ chat_template: GATE, eos: 'x' }),
    );
    expect(await patchModelDirTemplate(d)).toBe(true);
    expect(await readFile(join(d, 'chat_template.jinja'), 'utf8')).toContain('preserve_thinking');
    const cfg = JSON.parse(await readFile(join(d, 'tokenizer_config.json'), 'utf8')) as {
      chat_template: string;
      eos: string;
    };
    expect(cfg.chat_template).toContain('preserve_thinking');
    expect(cfg.eos).toBe('x');
    expect(await patchModelDirTemplate(d)).toBe(false);
    await rm(d, { recursive: true, force: true });
  });

  it("writes a GGUF's template, patched, to the cache — and nothing when no patch applies", async () => {
    const { ensureGgufChatTemplate, ggufTemplatePath } = await import('./chat-template.js');
    const d = await mkdtemp(join(tmpdir(), 'pi-gguf-tpl-'));
    const gguf = '/models/Qwen3.5-9B-Q8_0.gguf';
    const path = await ensureGgufChatTemplate(gguf, { cacheDir: d, template: GATE });
    expect(path).toBe(ggufTemplatePath(gguf, d));
    expect(await readFile(path as string, 'utf8')).toContain('preserve_thinking');
    expect(
      await ensureGgufChatTemplate(gguf, { cacheDir: d, template: 'no gate here' }),
    ).toBeUndefined();
    await rm(d, { recursive: true, force: true });
  });
});
