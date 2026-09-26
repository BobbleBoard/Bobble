/**
 * HOW LONG IS NORMAL SILENCE — measured, for the stall watchdog's window
 * (packages/provider-llamacpp/src/stall-watchdog.ts).
 *
 * The watchdog calls a stream stalled after 90 s with no delta AND no sign from
 * the engine that it is working. This measures the numbers that window has to
 * sit well above, on the real engines the app launches, with the app's model:
 *
 *   - a COLD prefill (a nonce at the head of the prompt defeats every prefix
 *     cache) of ~12k and ~28k tokens: time to headers, to the first SSE byte,
 *     to the first token;
 *   - the engine's own work counter while that happens, sampled every 250 ms —
 *     rapid-mlx `/v1/status` `steps_executed`, llama-server `/slots` — and the
 *     longest stretch it did NOT move (what the watchdog would see as idle);
 *   - llama.cpp's `prompt_progress` frame cadence, and the raw `/slots` shape
 *     during prefill and decode (the watchdog's reader handles both shapes);
 *   - one WARM repeat, for contrast.
 *
 * Engines are started directly with the app's own arguments and stopped by
 * signalling the SERVER process (never a parent), then waited on; new crash
 * reports in ~/Library/Logs/DiagnosticReports are listed at the end.
 *
 *   node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/stall-window-measure.mjs
 *   ENGINES=rapid-mlx OUT=/tmp/stall-window node …
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const OUT = process.env.OUT ?? path.join(REPO, '.corp-runs', 'stall-window');
const ENGINES = (process.env.ENGINES ?? 'rapid-mlx,llamacpp').split(',').map((s) => s.trim());
/** `prefill` (cold/warm prefill timings) and/or `toolcall` (a long write's delta timeline). */
const PARTS = new Set((process.env.PARTS ?? 'prefill,toolcall').split(',').map((s) => s.trim()));
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const LIBRARY = process.env.PI_DESKTOP_MODELS_DIR ?? path.join(homedir(), 'Bobble', 'Models');
const MLX_MODEL = path.join(LIBRARY, 'LLM', 'MLX', 'mlx-community__qwen3.5-4b-mlx-8bit');
const GGUF_MODEL = path.join(LIBRARY, 'LLM', 'qwen3.5-4b-mtp', 'Qwen3.5-4B-Q8_0.gguf');
const LLAMA_SERVER = path.join(CACHE, 'llamacpp', 'b10603', 'llama-b10603', 'llama-server');
const RAPID_MLX = path.join(CACHE, 'engines', 'rapid-mlx-vision', 'bin', 'rapid-mlx');
const TEMPLATE = path.join(CACHE, 'chat-templates', 'Qwen--Qwen3.5-4B.jinja');
const REPORTS = path.join(homedir(), 'Library', 'Logs', 'DiagnosticReports');

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[stall-window] ${m}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Real repo text — varied, nothing a model or an n-gram cache could shortcut. */
function corpus(chars) {
  const roots = [
    'packages/harness/src',
    'packages/provider-llamacpp/src',
    'packages/inference/src',
  ];
  let text = '';
  for (const root of roots) {
    for (const name of readdirSync(path.join(REPO, root)).sort()) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      try {
        text += `\n\n// ${root}/${name}\n${readFileSync(path.join(REPO, root, name), 'utf8')}`;
      } catch {
        /* a directory */
      }
      if (text.length >= chars) return text.slice(0, chars);
    }
  }
  return text.slice(0, chars);
}

function body(model, tokens, nonce, extra = {}) {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: `Session ${nonce}. You are a careful reader of source code.` },
      {
        role: 'user',
        content: `${corpus(tokens * 4)}\n\nIn one word: which language is the code above?`,
      },
    ],
    ...extra,
  };
}

async function waitUp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  return false;
}

/** Stop the SERVER itself — SIGTERM, wait; SIGKILL only if it will not go. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}

/** Sample a work counter every 250 ms until stopped. */
function sampler(read) {
  const samples = [];
  let on = true;
  const t0 = Date.now();
  const loop = (async () => {
    while (on) {
      const at = Date.now() - t0;
      try {
        samples.push({ at, value: await read() });
      } catch {
        samples.push({ at, value: null });
      }
      await sleep(250);
    }
  })();
  return {
    t0,
    async stop() {
      on = false;
      await loop;
      return samples;
    },
  };
}

/** The longest stretch, inside [from, to), over which the counter did not move. */
function longestStill(samples, from, to) {
  const inside = samples.filter((s) => s.at >= from && s.at <= to && typeof s.value === 'number');
  let longest = 0;
  let since = inside[0]?.at ?? from;
  let last = inside[0]?.value;
  for (const s of inside) {
    if (s.value !== last) {
      longest = Math.max(longest, s.at - since);
      since = s.at;
      last = s.value;
    }
  }
  if (inside.length > 0) longest = Math.max(longest, (inside.at(-1)?.at ?? since) - since);
  return longest;
}

async function measure({ label, base, model, tokens, nonce, counter, extra }) {
  const s = sampler(counter);
  const t0 = s.t0;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body(model, tokens, nonce, extra)),
  });
  const tHeaders = Date.now() - t0;
  const dec = new TextDecoder();
  let buf = '';
  let tFirstByte = null;
  let tFirstDelta = null;
  let usage = null;
  let timings = null;
  const progress = [];
  let slotsDuringPrefill = null;
  for await (const chunk of res.body) {
    if (tFirstByte === null) tFirstByte = Date.now() - t0;
    buf += dec.decode(chunk, { stream: true });
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.prompt_progress !== undefined) {
        progress.push({ at: Date.now() - t0, ...j.prompt_progress });
        if (slotsDuringPrefill === null && label.startsWith('llamacpp')) {
          slotsDuringPrefill = await fetch(`${base}/slots`)
            .then((r) => r.json())
            .catch(() => null);
        }
      }
      const d = j.choices?.[0]?.delta;
      if (
        tFirstDelta === null &&
        ((d?.content ?? '').length > 0 || (d?.reasoning_content ?? '').length > 0)
      ) {
        tFirstDelta = Date.now() - t0;
      }
      if (j.usage) usage = j.usage;
      if (j.timings) timings = j.timings;
    }
  }
  const tEnd = Date.now() - t0;
  await sleep(600);
  const samples = await s.stop();
  const prefillEnd = tFirstDelta ?? tEnd;
  const result = {
    label,
    promptTokens: usage?.prompt_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n ?? null,
    prefillTokens: timings?.prompt_n ?? null,
    tHeadersMs: tHeaders,
    tFirstByteMs: tFirstByte,
    tFirstTokenMs: tFirstDelta,
    tEndMs: tEnd,
    counterMovedDuringPrefill:
      new Set(samples.filter((x) => x.at <= prefillEnd).map((x) => x.value)).size > 1,
    longestStillDuringPrefillMs: longestStill(samples, 0, prefillEnd),
    progressFrames: progress.length,
    longestGapBetweenProgressFramesMs: progress.reduce(
      (m, p, i) => (i === 0 ? m : Math.max(m, p.at - progress[i - 1].at)),
      0,
    ),
    counterFirst: samples[0]?.value ?? null,
    counterLast: samples.at(-1)?.value ?? null,
  };
  if (slotsDuringPrefill !== null) result.slotsDuringPrefill = slotsDuringPrefill;
  log(JSON.stringify(result));
  return result;
}

/**
 * A LONG TOOL CALL, streamed — the silence that must NOT be called a stall.
 * The model writes a whole page through a `write` tool; every SSE delta is
 * timed, and the work counter sampled, so the longest silence on the wire can
 * be set against whether the engine was stepping through it.
 */
async function toolCallTimeline({ label, base, model, counter }) {
  const s = sampler(counter);
  const t0 = s.t0;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 3000,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
      tools: [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'Write a file to disk.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        },
      ],
      messages: [
        {
          role: 'system',
          content: 'You write files with the write tool. Never paste file contents into the reply.',
        },
        {
          role: 'user',
          content:
            'Use the write tool to create bouncing-ball.html: one complete HTML page with a canvas ' +
            'animation of a ball kicked at an angle (projectile motion) — gravity, a fading trail, ' +
            'labelled axes, and sliders for launch speed and angle. Full CSS and JavaScript, at ' +
            'least 150 lines.',
        },
      ],
    }),
  });
  const dec = new TextDecoder();
  let buf = '';
  const deltas = [];
  let usage = null;
  let keepalives = 0;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith(':')) keepalives++;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      const at = Date.now() - t0;
      if ((d?.tool_calls?.length ?? 0) > 0) {
        const args = d.tool_calls.map((c) => c.function?.arguments ?? '').join('');
        deltas.push({ at, kind: 'tool', chars: args.length });
      } else if ((d?.content ?? '').length > 0)
        deltas.push({ at, kind: 'content', chars: d.content.length });
      else if ((d?.reasoning_content ?? '').length > 0) {
        deltas.push({ at, kind: 'reasoning', chars: d.reasoning_content.length });
      }
    }
  }
  const tEnd = Date.now() - t0;
  await sleep(600);
  const samples = await s.stop();
  // The longest silence between deltas (or from the last delta to the end).
  let gap = { from: 0, to: deltas[0]?.at ?? tEnd };
  const edges = [...deltas.map((d) => d.at), tEnd];
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] - edges[i - 1] > gap.to - gap.from) gap = { from: edges[i - 1], to: edges[i] };
  }
  const inGap = samples.filter(
    (x) => x.at >= gap.from && x.at <= gap.to && typeof x.value === 'number',
  );
  const tools = deltas.filter((d) => d.kind === 'tool');
  const result = {
    label,
    completionTokens: usage?.completion_tokens ?? null,
    tEndMs: tEnd,
    deltas: deltas.length,
    toolDeltas: tools.length,
    toolArgChars: tools.reduce((n, d) => n + d.chars, 0),
    firstToolDeltaMs: tools[0]?.at ?? null,
    keepaliveComments: keepalives,
    longestSilenceMs: gap.to - gap.from,
    longestSilenceAtMs: gap.from,
    counterAtSilenceStart: inGap[0]?.value ?? null,
    counterAtSilenceEnd: inGap.at(-1)?.value ?? null,
    counterLongestStillInSilenceMs: longestStill(samples, gap.from, gap.to),
    // The counter across the whole reply: does the engine's own count move
    // while it decodes (the probe's evidence), and how long did it sit still?
    counterFirst: samples.find((x) => typeof x.value === 'number')?.value ?? null,
    counterLast: samples.filter((x) => typeof x.value === 'number').at(-1)?.value ?? null,
    counterLongestStillWhileDecodingMs: longestStill(samples, deltas[0]?.at ?? 0, tEnd),
    counterUnanswered: samples.filter((x) => x.value === null).length,
  };
  log(JSON.stringify(result));
  return result;
}

const reportsBefore = new Set(
  (() => {
    try {
      return readdirSync(REPORTS);
    } catch {
      return [];
    }
  })(),
);
const results = [];

for (const engine of ENGINES) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let model;
  let counter;
  let decodeSlots = null;
  if (engine === 'rapid-mlx') {
    model = 'qwen3.5-4b@rapid-mlx';
    child = spawn(
      RAPID_MLX,
      [
        'serve',
        MLX_MODEL,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--served-model-name',
        model,
        '--mllm',
      ],
      {
        env: {
          ...process.env,
          HF_HOME: path.join(CACHE, 'hf'),
          HF_HUB_OFFLINE: '1',
          RAPID_MLX_REASONING_CUTOFF_NOTICE: 'disabled',
          RAPID_MLX_CONSTRAIN_TOOLS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    counter = () =>
      fetch(`${base}/v1/status`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .then((j) => j.steps_executed);
  } else {
    model = 'qwen3.5-4b';
    child = spawn(
      LLAMA_SERVER,
      [
        '-m',
        GGUF_MODEL,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '-c',
        '32768',
        '-ngl',
        '99',
        '--jinja',
        '--chat-template-file',
        TEMPLATE,
        '--parallel',
        '1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    counter = () =>
      fetch(`${base}/slots`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .then((slots) =>
          slots.reduce(
            (n, s) =>
              n +
              ((Array.isArray(s.next_token) ? s.next_token[0] : s.next_token)?.n_decoded ?? 0) +
              (s.n_prompt_tokens_processed ?? 0),
            0,
          ),
        );
  }
  const serverLog = path.join(OUT, `${engine}-server.log`);
  writeFileSync(serverLog, '');
  for (const st of [child.stdout, child.stderr]) {
    st.on('data', (d) => writeFileSync(serverLog, d, { flag: 'a' }));
  }
  try {
    const t = Date.now();
    const up = await waitUp(
      engine === 'rapid-mlx' ? `${base}/v1/models` : `${base}/health`,
      300_000,
    );
    if (!up) throw new Error(`${engine} did not come up`);
    log(`${engine} up in ${Math.round((Date.now() - t) / 1000)} s`);
    // One small request so shaders/graphs are built before anything is timed.
    await measure({
      label: `${engine}-warmup`,
      base,
      model,
      tokens: 200,
      nonce: 'warmup',
      counter,
    });
    for (const [tokens, runs] of PARTS.has('prefill')
      ? [
          [12_000, 3],
          [28_000, 1],
        ]
      : []) {
      for (let i = 1; i <= runs; i++) {
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        results.push(
          await measure({
            label: `${engine}-cold-${tokens}-${i}`,
            base,
            model,
            tokens,
            nonce,
            counter,
            extra: engine === 'llamacpp' ? { return_progress: true } : {},
          }),
        );
        if (tokens === 12_000 && i === runs) {
          // The same prompt again: the prefix cache's answer.
          results.push(
            await measure({
              label: `${engine}-warm-${tokens}`,
              base,
              model,
              tokens,
              nonce,
              counter,
              extra: engine === 'llamacpp' ? { return_progress: true } : {},
            }),
          );
        }
      }
    }
    if (PARTS.has('toolcall')) {
      results.push(await toolCallTimeline({ label: `${engine}-toolcall`, base, model, counter }));
    }
    if (engine === 'llamacpp' && PARTS.has('prefill')) {
      // /slots while decoding: a longer reply, sampled mid-stream.
      const r = fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body(model, 300, 'decode'),
          max_tokens: 400,
          stream: false,
        }),
      });
      await sleep(3000);
      decodeSlots = await fetch(`${base}/slots`)
        .then((x) => x.json())
        .catch(() => null);
      await r.catch(() => undefined);
      results.push({ label: 'llamacpp-slots-while-decoding', slots: decodeSlots });
    }
  } catch (e) {
    log(`${engine} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    results.push({ label: `${engine}-failed`, error: String(e) });
  } finally {
    await stop(child);
    log(`${engine} stopped (exit ${child.exitCode ?? child.signalCode})`);
  }
}

const reportsAfter = (() => {
  try {
    return readdirSync(REPORTS);
  } catch {
    return [];
  }
})();
const newReports = reportsAfter.filter((f) => !reportsBefore.has(f));
writeFileSync(
  path.join(OUT, 'results.json'),
  `${JSON.stringify({ results, newReports }, null, 2)}\n`,
);
log(`new crash reports: ${newReports.length === 0 ? 'none' : newReports.join(', ')}`);
log(`results → ${path.join(OUT, 'results.json')}`);
