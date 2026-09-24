/**
 * IS THE MOCK SHAPED LIKE THE REAL SERVER? — a fidelity check for _mock-openai.mjs.
 *
 * `_mock-openai` is checked against the app's real CLIENT code (the provider's
 * stream parser, a real pi turn). This checks it against the real SERVER: the
 * same requests go to a running llama-server and to the mock, every response
 * is reduced to its SHAPE — each key path with its JSON type, e.g.
 * `frame.choices[].delta.tool_calls[].function.arguments: string` — and the two
 * are compared.
 *
 *   - A path the real server has and the mock lacks, among the paths the app
 *     READS (provider-llamacpp's chunk, timings and progress fields), fails the
 *     check: a probe would pass on something production never sends, or miss
 *     what it does.
 *   - Every other difference is reported, not failed (the real /props carries
 *     dozens of settings no consumer reads).
 *   - Cancel-on-disconnect is timed on both: abort after the first frame, then
 *     poll /slots until the slot is idle.
 *
 * It NEVER starts a server. It needs one already running — a heavy job, so
 * BENCH runs it (deliverables/bench/queue.md, row MOCK-FID):
 *
 *   REAL_BASE_URL=http://127.0.0.1:18089 SHOT_DIR=… node tests/e2e/mock-openai-fidelity.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockOpenAI } from './_mock-openai.mjs';

const REAL = process.env.REAL_BASE_URL?.replace(/\/+$/, '');
if (!REAL) {
  console.error(
    'mock-openai-fidelity: set REAL_BASE_URL to a running llama-server (a BENCH job; see deliverables/bench/queue.md, MOCK-FID)',
  );
  process.exit(64);
}
const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'mock-openai-fidelity');
mkdirSync(OUT, { recursive: true });

/** The response paths provider-llamacpp (stream.ts: OAIChunk, LlamaCppTimings, LlamaPromptProgress) reads. */
const CONSUMED = [
  'frame.choices[].delta.content',
  'frame.choices[].delta.reasoning_content',
  'frame.choices[].delta.tool_calls[].index',
  'frame.choices[].delta.tool_calls[].id',
  'frame.choices[].delta.tool_calls[].function.name',
  'frame.choices[].delta.tool_calls[].function.arguments',
  'frame.choices[].finish_reason',
  'frame.usage.prompt_tokens',
  'frame.usage.completion_tokens',
  'frame.timings.prompt_n',
  'frame.timings.cache_n',
  'frame.timings.prompt_ms',
  'frame.timings.predicted_n',
  'frame.timings.predicted_ms',
  'frame.timings.predicted_per_second',
  'frame.prompt_progress.total',
  'frame.prompt_progress.cache',
  'frame.prompt_progress.processed',
  'body.content',
  'body.timings.prompt_n',
  'body.completion_probabilities[].top_logprobs[].logprob',
  'body.prompt',
  'body.status',
  'body.default_generation_settings.n_ctx',
  'body.modalities.vision',
  'body[].is_processing',
  'body.data[].id',
];

/** Every key path in `value`, with the JSON types seen there. */
function shapeOf(value, prefix, out = new Map()) {
  const add = (p, t) => {
    if (!out.has(p)) out.set(p, new Set());
    out.get(p).add(t);
  };
  if (Array.isArray(value)) {
    add(prefix, 'array');
    for (const v of value) shapeOf(v, `${prefix}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    add(prefix, 'object');
    for (const [k, v] of Object.entries(value)) shapeOf(v, `${prefix}.${k}`, out);
  } else {
    add(prefix, value === null ? 'null' : typeof value);
  }
  return out;
}

async function request(base, method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const frames = text
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)));
    const shape = new Map();
    for (const f of frames) shapeOf(f, 'frame', shape);
    return {
      status: res.status,
      shape,
      frames: frames.length,
      done: text.includes('data: [DONE]'),
    };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, shape: shapeOf(json, 'body') };
}

/** Abort after the first frame; how long until /slots says nobody is processing? */
async function cancelLatency(base, body) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  await reader.read();
  const t0 = Date.now();
  ctrl.abort();
  for (;;) {
    const slots = await (await fetch(`${base}/slots`)).json();
    if (Array.isArray(slots) && !slots.some((s) => s.is_processing)) return Date.now() - t0;
    if (Date.now() - t0 > 10_000) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const BASH = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};
const SYSTEM = { role: 'system', content: 'You are a test assistant. Use tools when asked.' };
const CASES = [
  ['GET /health', 'GET', '/health'],
  ['GET /props', 'GET', '/props'],
  ['GET /slots', 'GET', '/slots'],
  ['GET /v1/models', 'GET', '/v1/models'],
  [
    'stream: tool call',
    'POST',
    '/v1/chat/completions',
    {
      stream: true,
      stream_options: { include_usage: true },
      return_progress: true,
      messages: [SYSTEM, { role: 'user', content: 'FID-TOOL: run `echo hi` with the bash tool.' }],
      tools: [BASH],
      tool_choice: 'required',
      max_tokens: 200,
      chat_template_kwargs: { enable_thinking: false },
    },
  ],
  [
    'stream: reasoning + text',
    'POST',
    '/v1/chat/completions',
    {
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'FID-THINK: what is 2+2? Think briefly, then answer.' }],
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: true },
    },
  ],
  [
    'whole: reasoning + text',
    'POST',
    '/v1/chat/completions',
    {
      stream: false,
      messages: [{ role: 'user', content: 'FID-THINK: what is 3+3? Think briefly, then answer.' }],
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: true },
    },
  ],
  [
    'completion + n_probs',
    'POST',
    '/completion',
    { prompt: 'FID-COMP The capital of France is', n_predict: 6, n_probs: 3 },
  ],
  [
    'completion streamed',
    'POST',
    '/completion',
    { prompt: 'FID-COMP One, two,', n_predict: 6, stream: true },
  ],
  [
    'apply-template',
    'POST',
    '/apply-template',
    { messages: [SYSTEM, { role: 'user', content: 'hi' }] },
  ],
];

const mock = await startMockOpenAI({
  model: 'fidelity',
  rules: [
    {
      match: { lastUser: 'FID-TOOL' },
      reply: { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] },
    },
    {
      match: { lastUser: 'FID-THINK' },
      reply: { reasoning: 'Two and two make four.', content: '4' },
    },
    { match: { prompt: 'FID-COMP' }, reply: { content: ' Paris.' } },
    { match: { lastUser: 'FID-CANCEL' }, reply: { content: 'counting…', hang: true } },
  ],
});

const report = { real: REAL, cases: [], failures: [] };
try {
  for (const [name, method, p, body] of CASES) {
    const [real, fake] = [
      await request(REAL, method, p, body),
      await request(mock.url, method, p, body),
    ];
    const realPaths = new Set(real.shape.keys());
    const fakePaths = new Set(fake.shape.keys());
    const missing = [...realPaths].filter((x) => !fakePaths.has(x));
    const extra = [...fakePaths].filter((x) => !realPaths.has(x));
    const typeDiffs = [...realPaths]
      .filter((x) => fakePaths.has(x))
      .filter((x) => [...real.shape.get(x)].sort().join() !== [...fake.shape.get(x)].sort().join())
      .map(
        (x) =>
          `${x}: real ${[...real.shape.get(x)].join('|')}, mock ${[...fake.shape.get(x)].join('|')}`,
      );
    const consumedMissing = missing.filter((x) => CONSUMED.includes(x));
    const consumedTypeDiffs = typeDiffs.filter((d) => CONSUMED.includes(d.split(':')[0]));
    report.cases.push({
      name,
      status: { real: real.status, mock: fake.status },
      frames:
        real.frames !== undefined
          ? { real: real.frames, mock: fake.frames, realDone: real.done, mockDone: fake.done }
          : undefined,
      missingInMock: missing,
      onlyInMock: extra,
      typeDiffs,
    });
    for (const x of consumedMissing)
      report.failures.push(
        `${name}: the mock never sends ${x}, which the real server does and the app reads`,
      );
    for (const d of consumedTypeDiffs) report.failures.push(`${name}: ${d}`);
    if (real.status !== fake.status)
      report.failures.push(`${name}: status real ${real.status}, mock ${fake.status}`);
  }
  const cancelBody = {
    stream: true,
    messages: [{ role: 'user', content: 'FID-CANCEL: count from 1 to 500, one number per line.' }],
    max_tokens: 2000,
    chat_template_kwargs: { enable_thinking: false },
  };
  report.cancelToIdleMs = {
    real: await cancelLatency(REAL, cancelBody),
    mock: await cancelLatency(mock.url, cancelBody),
  };
  if (report.cancelToIdleMs.real === null)
    report.failures.push('the real server never went idle after a disconnect');
} finally {
  await mock.close();
  writeFileSync(path.join(OUT, 'fidelity.json'), `${JSON.stringify(report, null, 2)}\n`);
}

for (const c of report.cases) {
  console.log(
    `${c.name}: status ${c.status.real}/${c.status.mock}; missing in mock ${c.missingInMock.length}, only in mock ${c.onlyInMock.length}, type diffs ${c.typeDiffs.length}`,
  );
}
console.log(
  `cancel → idle: real ${report.cancelToIdleMs?.real} ms, mock ${report.cancelToIdleMs?.mock} ms`,
);
console.log(`full report: ${path.join(OUT, 'fidelity.json')}`);
if (report.failures.length > 0) {
  for (const f of report.failures) console.error(`mock-openai-fidelity FAILED: ${f}`);
  process.exitCode = 1;
} else {
  console.log('mock-openai-fidelity OK');
}
