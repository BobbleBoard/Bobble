/**
 * A SCRIPTED MODEL SERVER — OpenAI-compatible, and shaped like llama-server.
 *
 * The real pi, the real harness, the real provider, the real bridge and the
 * real renderer all run; only the model is scripted. That is what makes a
 * model-free probe honest: everything the app does with a reply is the real
 * code, and the reply is whatever the test says it is — a tool call, a
 * reasoning block, an error, a stream that stalls, a socket that drops.
 *
 * One file for every lane (PLAN.md §1.3 item 3): help's `_mock-openai`,
 * workflows' `_mock-model-server`, training's mock lanes and devices' fake
 * llama-server are all this.
 *
 * ## What it serves
 *
 *   POST /v1/chat/completions   (and /chat/completions) — SSE or JSON; content,
 *                               `reasoning_content`, `tool_calls` streamed the
 *                               way llama-server streams them, `timings` +
 *                               `usage` on the last frame, `prompt_progress`
 *                               when the request asks for `return_progress`
 *   POST /completion            llama-server's raw completion: `prompt`,
 *                               `n_predict`, `stream`, `n_probs`
 *                               (`completion_probabilities`), `multimodal_data`
 *   POST /v1/completions        the OpenAI raw completion, minimal
 *   POST /apply-template        the rendered prompt the cache simulation uses
 *   POST /tokenize, /detokenize
 *   GET  /props /slots /health /v1/models /models
 *   GET  /__mock/log            the request log;  POST /__mock/reset, /__mock/rules
 *
 * ## Scripted replies
 *
 * A reply is chosen by the FIRST rule whose `match` fits the request:
 *
 *   {
 *     name: 'call-the-tool',
 *     match: {
 *       lastUser: 'find the file' | /regex/,   // the last user message
 *       marker: 'STEP:outline',                // anywhere: system prompt or any message
 *       system: 'You are…' | /regex/,
 *       afterTool: true | 'text in the result', // the last message is a tool result
 *       prompt: '…' | /regex/,                 // /completion's prompt
 *       path, stream, hasTools, model,
 *       when: (ctx) => boolean,                // in-process only
 *     },
 *     reply: Reply | Reply[] | ((ctx) => Reply),  // an array plays in order, the last repeats
 *     times: 2,                                   // then the rule is spent
 *   }
 *
 *   Reply = { content, reasoning, toolCalls: [{ name, arguments, id? }],
 *             finishReason, latencyMs, chunkDelayMs, chunkSize, status, error,
 *             hang, dropAfterChunks, usage, timings, probs }
 *
 * Nothing matched: `defaultReply` (default `{ content: 'OK.' }`), or HTTP 500
 * when `strict: true`, so an unscripted call is loud rather than quietly
 * answered. From the CLI, a regex is written `{ "regex": "…", "flags": "i" }`.
 *
 * ## The llama-server behaviours tests lean on
 *
 * - **Cancel-on-disconnect.** When the client goes away mid-stream the
 *   generation stops, the slot is idle at once (`/slots` → `is_processing:
 *   false`), and the log entry says `cancelled: true` with how far it got.
 * - **One slot, with a prompt cache.** Each request's prompt is rendered
 *   (ChatML, tools first — the way the Qwen templates lay it out) and compared
 *   with what the slot last held, so `timings.cache_n` / `prompt_n` say how
 *   much was reused and how much re-prefilled: a change that rewrites earlier
 *   history shows up here as a big `prompt_n`, with no model loaded. Tokens are
 *   counted as characters / 4.
 * - **Latency.** `latencyMs` before the first byte (time to first token),
 *   `chunkDelayMs` between frames; per server or per reply.
 *
 * ## Use
 *
 *   import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
 *   const mock = await startMockOpenAI({ model: 'mock-4b', rules: [...] });
 *   writeModelsJson(home, { baseUrl: mock.baseUrl, model: 'mock-4b' });
 *   … launchApp(…, { env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' } })
 *   await mock.waitFor((r) => r.rule === 'call-the-tool');
 *   await mock.close();
 *
 *   node tests/e2e/_mock-openai.mjs --port 8089 --model mock-4b --rules rules.json
 *   → prints `MOCK_OPENAI_READY {"url":…,"baseUrl":…}` and serves until killed.
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ── request reading ─────────────────────────────────────────────────────────

/** The text of one OpenAI message `content` (a string, or text parts). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? (p.text ?? '') : ''))
      .join('');
  }
  return '';
}

/** The last user message's text, or ''. */
export function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return contentText(messages[i].content);
  }
  return '';
}

function systemText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((m) => m?.role === 'system' || m?.role === 'developer')
    .map((m) => contentText(m.content))
    .join('\n');
}

function allText(body) {
  if (typeof body?.prompt === 'string') return body.prompt;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .map((m) => `${contentText(m?.content)}${m?.tool_calls ? JSON.stringify(m.tool_calls) : ''}`)
    .join('\n');
}

/**
 * The prompt a llama-server would build — ChatML, the tools first inside the
 * system block, then every turn. Deterministic, which is all the cache
 * simulation needs: an unchanged history renders to an unchanged prefix.
 */
export function renderPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  let out = `<|im_start|>system\n${systemText(body)}`;
  if (tools.length > 0) {
    out += `\n\n# Tools\n<tools>\n${tools.map((t) => JSON.stringify(t)).join('\n')}\n</tools>`;
  }
  out += '<|im_end|>\n';
  for (const m of messages) {
    if (m?.role === 'system' || m?.role === 'developer') continue;
    const calls = Array.isArray(m?.tool_calls)
      ? m.tool_calls
          .map(
            (c) =>
              `\n<tool_call>\n${JSON.stringify({ name: c?.function?.name, arguments: c?.function?.arguments })}\n</tool_call>`,
          )
          .join('')
      : '';
    const role = m?.role === 'tool' ? 'user' : m?.role;
    const text =
      m?.role === 'tool'
        ? `<tool_response>\n${contentText(m.content)}\n</tool_response>`
        : contentText(m?.content);
    out += `<|im_start|>${role}\n${text}${calls}<|im_end|>\n`;
  }
  return `${out}<|im_start|>assistant\n`;
}

/** Characters → "tokens", the mock's one unit of account. */
export const tokensOf = (chars) => Math.ceil(chars / 4);

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// ── rules ───────────────────────────────────────────────────────────────────

/** A string, a RegExp, or `{ regex, flags }` from JSON → a predicate on text. */
function textMatcher(spec) {
  if (spec === undefined || spec === null) return null;
  if (spec instanceof RegExp) return (t) => spec.test(t);
  if (typeof spec === 'object' && typeof spec.regex === 'string') {
    const re = new RegExp(spec.regex, spec.flags ?? '');
    return (t) => re.test(t);
  }
  if (typeof spec === 'string' && /^\/.+\/[a-z]*$/.test(spec)) {
    const [, src, flags] = /^\/(.+)\/([a-z]*)$/.exec(spec);
    const re = new RegExp(src, flags);
    return (t) => re.test(t);
  }
  const s = String(spec);
  return (t) => t.includes(s);
}

function ruleMatches(rule, ctx) {
  const m = rule.match ?? {};
  const test = (spec, text) => {
    const f = textMatcher(spec);
    return f === null || f(text);
  };
  if (m.path !== undefined && m.path !== ctx.path) return false;
  if (m.stream !== undefined && Boolean(m.stream) !== ctx.stream) return false;
  if (m.model !== undefined && m.model !== ctx.body?.model) return false;
  if (m.hasTools !== undefined && Boolean(m.hasTools) !== ctx.tools.length > 0) return false;
  if (!test(m.lastUser, ctx.lastUser)) return false;
  if (!test(m.system, ctx.system)) return false;
  if (!test(m.marker, `${ctx.system}\n${ctx.all}`)) return false;
  if (m.prompt !== undefined && !test(m.prompt, ctx.prompt)) return false;
  if (m.afterTool !== undefined) {
    const last = ctx.messages.at(-1);
    const isTool = last?.role === 'tool';
    if (m.afterTool === false) {
      if (isTool) return false;
    } else if (!isTool || (m.afterTool !== true && !test(m.afterTool, contentText(last.content)))) {
      return false;
    }
  }
  if (typeof m.when === 'function' && !m.when(ctx)) return false;
  return true;
}

function pickReply(rule, state, ctx) {
  const used = state.uses.get(rule) ?? 0;
  state.uses.set(rule, used + 1);
  const r = rule.reply;
  if (typeof r === 'function') return r(ctx) ?? {};
  if (Array.isArray(r)) return r[Math.min(used, r.length - 1)] ?? {};
  return r ?? {};
}

// ── the server ──────────────────────────────────────────────────────────────

/**
 * Start the mock. Options: `port` (0 = any), `host`, `model`, `rules`,
 * `defaultReply`, `strict`, `latencyMs`, `chunkDelayMs`, `chunkSize`, `nCtx`,
 * `slots` (1), `vision` (false), `loading` (health answers 503 until set
 * false), `logFile` (JSONL, one line per request).
 */
export async function startMockOpenAI(opts = {}) {
  const config = {
    host: opts.host ?? '127.0.0.1',
    model: opts.model ?? 'mock-model',
    defaultReply: opts.defaultReply ?? { content: 'OK.' },
    strict: opts.strict ?? false,
    latencyMs: opts.latencyMs ?? 0,
    chunkDelayMs: opts.chunkDelayMs ?? 0,
    chunkSize: opts.chunkSize ?? 12,
    nCtx: opts.nCtx ?? 32768,
    vision: opts.vision ?? false,
  };
  const state = {
    rules: [...(opts.rules ?? [])],
    uses: new Map(),
    log: [],
    seq: 0,
    loading: opts.loading ?? false,
    slots: Array.from({ length: opts.slots ?? 1 }, (_, id) => ({
      id,
      processing: false,
      cached: '',
      taskId: 0,
    })),
    waiters: [],
  };
  if (opts.logFile) mkdirSync(path.dirname(opts.logFile), { recursive: true });

  const record = (entry) => {
    state.log.push(entry);
    if (opts.logFile) appendFileSync(opts.logFile, `${JSON.stringify(entry)}\n`);
    for (const w of [...state.waiters]) {
      if (w.pred(entry)) {
        state.waiters.splice(state.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(entry);
      }
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: { code: 500, message: String(err), type: 'server_error' } });
      else res.destroy();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const body = req.method === 'POST' ? await readJson(req) : undefined;

    if (p === '/__mock/log') return sendJson(res, 200, state.log);
    if (p === '/__mock/reset' && req.method === 'POST') {
      reset();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/__mock/rules' && req.method === 'POST') {
      state.rules = Array.isArray(body) ? body : (body?.rules ?? []);
      state.uses.clear();
      return sendJson(res, 200, { ok: true, rules: state.rules.length });
    }
    if (p === '/health') {
      if (state.loading) {
        return sendJson(res, 503, {
          error: { code: 503, message: 'Loading model', type: 'unavailable_error' },
        });
      }
      return sendJson(res, 200, { status: 'ok' });
    }
    if (p === '/v1/models' || p === '/models') return sendJson(res, 200, modelsBody());
    if (p === '/props') return sendJson(res, 200, propsBody());
    if (p === '/slots') return sendJson(res, 200, slotsBody());
    if (p === '/tokenize' && req.method === 'POST') {
      const n = tokensOf(String(body?.content ?? '').length);
      return sendJson(res, 200, { tokens: Array.from({ length: n }, (_, i) => 1000 + i) });
    }
    if (p === '/detokenize' && req.method === 'POST') {
      return sendJson(res, 200, { content: '' });
    }
    if (p === '/apply-template' && req.method === 'POST') {
      return sendJson(res, 200, { prompt: renderPrompt(body ?? {}) });
    }
    if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
      return chat(res, p, body ?? {});
    }
    if (
      (p === '/completion' || p === '/completions' || p === '/v1/completions') &&
      req.method === 'POST'
    ) {
      return completion(res, p, body ?? {});
    }
    return sendJson(res, 404, {
      error: { code: 404, message: `mock: no route ${req.method} ${p}`, type: 'not_found_error' },
    });
  }

  function context(p, body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return {
      path: p,
      body,
      messages,
      tools: Array.isArray(body?.tools) ? body.tools : [],
      stream: body?.stream === true,
      lastUser: lastUserText(body),
      system: systemText(body),
      all: allText(body),
      prompt: typeof body?.prompt === 'string' ? body.prompt : '',
      seq: state.seq + 1,
    };
  }

  function choose(ctx) {
    for (const rule of state.rules) {
      if (rule.times !== undefined && (state.uses.get(rule) ?? 0) >= rule.times) continue;
      if (ruleMatches(rule, ctx)) return { rule, reply: pickReply(rule, state, ctx) };
    }
    return { rule: null, reply: config.strict ? null : config.defaultReply };
  }

  /** Take a free slot (or the least busy one) and account the prompt against its cache. */
  function takeSlot(prompt) {
    const slot = state.slots.find((s) => !s.processing) ?? state.slots[0];
    const reused = commonPrefix(slot.cached, prompt);
    slot.processing = true;
    slot.taskId += 1;
    return {
      slot,
      cacheN: tokensOf(reused),
      promptN: Math.max(1, tokensOf(prompt.length - reused)),
    };
  }

  function timings(acct, predictedN, over) {
    const promptMs = acct.promptN * 0.5;
    const predictedMs = Math.max(1, predictedN * 20);
    return {
      cache_n: acct.cacheN,
      prompt_n: acct.promptN,
      prompt_ms: promptMs,
      prompt_per_token_ms: 0.5,
      prompt_per_second: 2000,
      predicted_n: predictedN,
      predicted_ms: predictedMs,
      predicted_per_token_ms: 20,
      predicted_per_second: 50,
      ...(over ?? {}),
    };
  }

  async function chat(res, p, body) {
    const ctx = context(p, body);
    const seq = ++state.seq;
    const startedAt = Date.now();
    const { rule, reply } = choose(ctx);
    const entry = {
      seq,
      at: startedAt,
      path: p,
      stream: ctx.stream,
      model: body.model,
      lastUser: ctx.lastUser,
      afterTool: ctx.messages.at(-1)?.role === 'tool',
      tools: ctx.tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean),
      rule: rule?.name ?? null,
      body,
    };
    if (reply === null) {
      entry.status = 500;
      record(entry);
      return sendJson(res, 500, {
        error: {
          code: 500,
          message: `mock (strict): no scripted reply for "${ctx.lastUser.slice(0, 80)}"`,
          type: 'server_error',
        },
      });
    }
    await sleep(reply.latencyMs ?? config.latencyMs);
    if (reply.status !== undefined && reply.status >= 400) {
      entry.status = reply.status;
      record(entry);
      const error =
        typeof reply.error === 'object'
          ? reply.error
          : { code: reply.status, message: reply.error ?? 'mock error', type: 'server_error' };
      return sendJson(res, reply.status, { error });
    }

    const prompt = renderPrompt(body);
    const acct = takeSlot(prompt);
    const toolCalls = (reply.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_mock_${seq}_${i}`,
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
    }));
    const content = reply.content ?? '';
    const reasoning = reply.reasoning ?? '';
    const finishReason = reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    const outputText = `${reasoning}${content}${toolCalls.map((c) => c.name + c.arguments).join('')}`;
    const predictedN = tokensOf(outputText.length);
    const usage = {
      prompt_tokens: acct.cacheN + acct.promptN,
      completion_tokens: predictedN,
      total_tokens: acct.cacheN + acct.promptN + predictedN,
      ...(reply.usage ?? {}),
    };
    const t = timings(acct, predictedN, reply.timings);
    Object.assign(entry, {
      cacheN: acct.cacheN,
      promptN: acct.promptN,
      reply: { content, reasoning, toolCalls, finishReason },
    });
    const finishSlot = (completed) => {
      acct.slot.processing = false;
      // llama-server keeps what it processed; a cancelled turn keeps the prompt.
      acct.slot.cached = completed ? prompt + outputText : prompt;
    };

    if (!ctx.stream) {
      const message = {
        role: 'assistant',
        content: content.length > 0 || toolCalls.length === 0 ? content : null,
      };
      if (reasoning.length > 0) message.reasoning_content = reasoning;
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      finishSlot(true);
      entry.status = 200;
      entry.durationMs = Date.now() - startedAt;
      record(entry);
      return sendJson(res, 200, {
        id: `chatcmpl-mock-${seq}`,
        object: 'chat.completion',
        created: Math.floor(startedAt / 1000),
        model: body.model ?? config.model,
        system_fingerprint: 'b10603-mock',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
        timings: t,
      });
    }

    // ── stream ──
    const frames = [];
    const base = {
      id: `chatcmpl-mock-${seq}`,
      object: 'chat.completion.chunk',
      created: Math.floor(startedAt / 1000),
      model: body.model ?? config.model,
      system_fingerprint: 'b10603-mock',
    };
    const delta = (d, finish = null) => ({
      ...base,
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    });
    if (body.return_progress === true) {
      frames.push({
        ...base,
        choices: [],
        prompt_progress: {
          total: acct.cacheN + acct.promptN,
          cache: acct.cacheN,
          processed: acct.cacheN + acct.promptN,
          time_ms: acct.promptN * 0.5,
        },
      });
    }
    frames.push(delta({ role: 'assistant', content: null }));
    const size = reply.chunkSize ?? config.chunkSize;
    for (const piece of chunks(reasoning, size)) frames.push(delta({ reasoning_content: piece }));
    for (const piece of chunks(content, size)) frames.push(delta({ content: piece }));
    toolCalls.forEach((c, index) => {
      frames.push(
        delta({
          tool_calls: [
            { index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } },
          ],
        }),
      );
      for (const piece of chunks(c.arguments, 16)) {
        frames.push(delta({ tool_calls: [{ index, function: { arguments: piece } }] }));
      }
    });
    frames.push({ ...delta({}, finishReason), usage, timings: t });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.flushHeaders?.();
    const outcome = await streamFrames(res, frames, {
      delayMs: reply.chunkDelayMs ?? config.chunkDelayMs,
      hang: reply.hang === true,
      dropAfter: reply.dropAfterChunks,
    });
    finishSlot(outcome.completed);
    entry.status = 200;
    entry.cancelled = outcome.cancelled;
    entry.dropped = outcome.dropped;
    entry.framesSent = outcome.sent;
    entry.framesTotal = frames.length;
    entry.durationMs = Date.now() - startedAt;
    record(entry);
  }

  async function completion(res, p, body) {
    const promptText =
      typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body.prompt ?? '');
    const ctx = { ...context(p, body), prompt: promptText, all: promptText };
    const seq = ++state.seq;
    const startedAt = Date.now();
    const { rule, reply } = choose(ctx);
    const entry = {
      seq,
      at: startedAt,
      path: p,
      stream: ctx.stream,
      prompt: promptText.slice(0, 2000),
      images: Array.isArray(body.multimodal_data) ? body.multimodal_data.length : 0,
      nProbs: body.n_probs ?? 0,
      rule: rule?.name ?? null,
      body,
    };
    if (reply === null || (reply.status ?? 200) >= 400) {
      const status = reply === null ? 500 : reply.status;
      entry.status = status;
      record(entry);
      return sendJson(res, status, {
        error: {
          code: status,
          message: reply?.error ?? 'mock (strict): no scripted reply',
          type: 'server_error',
        },
      });
    }
    await sleep(reply.latencyMs ?? config.latencyMs);
    const acct = takeSlot(promptText);
    let content = reply.content ?? '';
    if (typeof body.n_predict === 'number' && body.n_predict >= 0)
      content = content.slice(0, body.n_predict * 4);
    const predictedN = tokensOf(content.length);
    const t = timings(acct, predictedN, reply.timings);
    const nProbs = Number(body.n_probs ?? 0);
    const probs = nProbs > 0 ? probabilities(content, nProbs, reply.probs) : undefined;
    Object.assign(entry, { cacheN: acct.cacheN, promptN: acct.promptN, reply: { content } });
    const finishSlot = (completed) => {
      acct.slot.processing = false;
      acct.slot.cached = completed ? promptText + content : promptText;
    };
    const final = {
      content: '',
      id_slot: acct.slot.id,
      stop: true,
      model: config.model,
      tokens_predicted: predictedN,
      tokens_evaluated: acct.cacheN + acct.promptN,
      tokens_cached: acct.cacheN,
      stop_type: body.n_predict !== undefined && predictedN >= body.n_predict ? 'limit' : 'eos',
      truncated: false,
      timings: t,
    };
    if (p === '/v1/completions') {
      finishSlot(true);
      entry.status = 200;
      record(entry);
      return sendJson(res, 200, {
        id: `cmpl-mock-${seq}`,
        object: 'text_completion',
        created: Math.floor(startedAt / 1000),
        model: config.model,
        choices: [{ index: 0, text: content, finish_reason: 'stop', logprobs: null }],
        usage: {
          prompt_tokens: final.tokens_evaluated,
          completion_tokens: predictedN,
          total_tokens: final.tokens_evaluated + predictedN,
        },
      });
    }
    if (!ctx.stream) {
      finishSlot(true);
      entry.status = 200;
      entry.durationMs = Date.now() - startedAt;
      record(entry);
      return sendJson(res, 200, {
        ...final,
        content,
        ...(probs ? { completion_probabilities: probs } : {}),
      });
    }
    const frames = [];
    const pieces = chunks(content, reply.chunkSize ?? config.chunkSize);
    pieces.forEach((piece, i) => {
      frames.push({
        content: piece,
        stop: false,
        id_slot: acct.slot.id,
        ...(probs ? { completion_probabilities: probs.slice(i, i + 1) } : {}),
      });
    });
    frames.push(final);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders?.();
    const outcome = await streamFrames(res, frames, {
      delayMs: reply.chunkDelayMs ?? config.chunkDelayMs,
      hang: reply.hang === true,
      dropAfter: reply.dropAfterChunks,
      done: false,
    });
    finishSlot(outcome.completed);
    Object.assign(entry, {
      status: 200,
      cancelled: outcome.cancelled,
      dropped: outcome.dropped,
      framesSent: outcome.sent,
      durationMs: Date.now() - startedAt,
    });
    record(entry);
  }

  function modelsBody() {
    const meta = {
      vocab_type: 2,
      n_vocab: 151936,
      n_ctx_train: 262144,
      n_embd: 2560,
      n_params: 4_020_000_000,
      size: 4_600_000_000,
    };
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: [{ id: config.model, object: 'model', created, owned_by: 'llamacpp', meta }],
      models: [
        { name: config.model, model: config.model, type: 'model', capabilities: ['completion'] },
      ],
    };
  }

  function propsBody() {
    return {
      default_generation_settings: {
        id: 0,
        n_ctx: config.nCtx,
        speculative: false,
        is_processing: false,
        params: { temperature: 0.7, top_k: 20, top_p: 0.8, min_p: 0, n_predict: -1 },
      },
      total_slots: state.slots.length,
      n_ctx: config.nCtx,
      model_path: `/mock/${config.model}.gguf`,
      model_alias: config.model,
      chat_template: '{# mock ChatML #}',
      modalities: { vision: config.vision, audio: false },
      build_info: 'b10603-mock',
      is_sleeping: false,
    };
  }

  function slotsBody() {
    return state.slots.map((s) => ({
      id: s.id,
      id_task: s.taskId,
      n_ctx: config.nCtx,
      speculative: false,
      is_processing: s.processing,
      prompt: s.cached.slice(-2000),
      n_past: tokensOf(s.cached.length),
      params: { n_predict: -1 },
    }));
  }

  function reset() {
    state.log.length = 0;
    state.uses.clear();
    state.seq = 0;
    for (const s of state.slots) {
      s.cached = '';
      s.processing = false;
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, config.host, resolve);
  });
  const { port } = server.address();
  const url = `http://${config.host}:${port}`;

  return {
    url,
    baseUrl: `${url}/v1`,
    port,
    model: config.model,
    /** Every request, in order (see the entry fields in chat()/completion()). */
    log: state.log,
    /** Replace the rules (and forget how often each was used). */
    setRules(rules) {
      state.rules = [...rules];
      state.uses.clear();
    },
    addRule(rule) {
      state.rules.push(rule);
    },
    /** Clear the log, rule counters and the slot cache. */
    reset,
    /** `loading: true` makes /health answer 503 "Loading model" until set back. */
    setLoading(v) {
      state.loading = v;
    },
    /** Is any slot generating right now (what `/slots` reports)? */
    busy: () => state.slots.some((s) => s.processing),
    /** Resolve with the first log entry (past or future) the predicate accepts. */
    waitFor(pred, { timeoutMs = 30_000 } = {}) {
      const seen = state.log.find(pred);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: null };
        w.timer = setTimeout(() => {
          state.waiters.splice(state.waiters.indexOf(w), 1);
          reject(
            new Error(
              `mock-openai: no matching request within ${timeoutMs} ms (${state.log.length} seen)`,
            ),
          );
        }, timeoutMs);
        state.waiters.push(w);
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Split text into frames of `size` characters (never splitting a surrogate pair). */
function chunks(text, size) {
  const out = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += Math.max(1, size))
    out.push(chars.slice(i, i + size).join(''));
  return out;
}

/** llama-server's `completion_probabilities` shape (post-2024-12 builds). */
function probabilities(content, n, given) {
  if (Array.isArray(given)) return given;
  return chunks(content, 4).map((token, i) => ({
    id: 1000 + i,
    token,
    bytes: [...Buffer.from(token)],
    logprob: -0.05,
    top_logprobs: Array.from({ length: n }, (_, k) => ({
      id: 1000 + i + k,
      token: k === 0 ? token : `${token}~${k}`,
      bytes: [...Buffer.from(k === 0 ? token : `${token}~${k}`)],
      logprob: k === 0 ? -0.05 : -3 - k,
    })),
  }));
}

/**
 * Write SSE frames, honouring cancel-on-disconnect: the moment the client goes
 * away, stop — which is what frees a real llama-server's slot.
 */
async function streamFrames(res, frames, { delayMs = 0, hang = false, dropAfter, done = true }) {
  let cancelled = false;
  const onClose = () => {
    if (!res.writableEnded) cancelled = true;
  };
  res.on('close', onClose);
  let sent = 0;
  try {
    // A hang is headers and the first frame, then nothing: only the client can end it.
    const toSend = hang ? frames.slice(0, 1) : frames;
    for (const frame of toSend) {
      if (cancelled || res.destroyed) {
        cancelled = true;
        break;
      }
      if (dropAfter !== undefined && sent >= dropAfter) {
        res.destroy(); // a dirty hang-up: no [DONE], no end
        return { completed: false, cancelled: false, dropped: true, sent };
      }
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      sent += 1;
      await sleep(delayMs);
    }
    if (hang && !cancelled) {
      await new Promise((resolve) => {
        if (cancelled || res.destroyed) resolve();
        else res.once('close', resolve);
      });
      return { completed: false, cancelled: true, dropped: false, sent };
    }
    if (cancelled) return { completed: false, cancelled: true, dropped: false, sent };
    if (done) res.write('data: [DONE]\n\n');
    res.end();
    return { completed: true, cancelled: false, dropped: false, sent };
  } finally {
    res.off('close', onClose);
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __unparsed: raw });
      }
    });
    req.on('error', () => resolve({}));
  });
}

// ── pi's models.json ────────────────────────────────────────────────────────

/**
 * The pi `models.json` provider block that points at a mock, in the shape the
 * app's supervisor writes (packages/inference models-json.ts): `api:
 * 'llamacpp-stream'` binds it to @pi-desktop/provider-llamacpp — the real
 * provider, repair ladder and all.
 */
export function providerBlock({
  baseUrl,
  model = 'mock-model',
  api = 'llamacpp-stream',
  contextWindow = 32768,
  maxTokens = 8192,
  input = ['text'],
  name = 'Mock model',
}) {
  return {
    baseUrl,
    api,
    apiKey: 'none',
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: api === 'mlx-stream',
    },
    models: [{ id: model, name, input, contextWindow, maxTokens }],
  };
}

/**
 * Write `<home>/.pi/agent/models.json` with a `provider` block for the mock,
 * keeping any other providers already there. Returns the file path.
 */
export function writeModelsJson(home, { provider = 'mock', ...block }) {
  const file = path.join(home, '.pi', 'agent', 'models.json');
  mkdirSync(path.dirname(file), { recursive: true });
  let existing = { providers: {} };
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  existing.providers = { ...(existing.providers ?? {}), [provider]: providerBlock(block) };
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  return file;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const rulesFile = argValue(argv, '--rules');
  const mock = await startMockOpenAI({
    port: Number(argValue(argv, '--port') ?? 0),
    model: argValue(argv, '--model') ?? 'mock-model',
    latencyMs: Number(argValue(argv, '--latency') ?? 0),
    chunkDelayMs: Number(argValue(argv, '--chunk-delay') ?? 0),
    strict: argv.includes('--strict'),
    logFile: argValue(argv, '--log'),
    rules: rulesFile ? JSON.parse(readFileSync(rulesFile, 'utf8')) : [],
  });
  console.log(
    `MOCK_OPENAI_READY ${JSON.stringify({ url: mock.url, baseUrl: mock.baseUrl, model: mock.model })}`,
  );
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
