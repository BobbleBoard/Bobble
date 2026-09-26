/**
 * A STREAM THAT STOPS — in the app, with the real pi, harness and provider.
 *
 * MEASURED 2026-09-26 (visual suite, qwen3.5-4b-mtp on rapid-mlx): a turn
 * streamed a short thought and the "\n\n" after `</think>`, then nothing but
 * rapid-mlx's `: keepalive` comments for 300 s; the chat showed "Thought" and
 * nothing else until the probe's cap. Only the model is scripted here — shaped
 * like rapid-mlx: an `@rapid-mlx` served id on the MLX provider, keepalive
 * comments while silent, and `/v1/status` whose step counter is frozen when the
 * engine is stuck and moving when it is only holding a tool call back.
 *
 * Three chats, windows shrunk through the provider's env knobs (4 s, not 90):
 *
 *   A  STALL-ONCE    thought, "\n\n", keepalives, counter frozen → the request is
 *                    cancelled (the mock sees the socket close), sent again, the
 *                    footer says "Retrying (1/1)…" while it waits, and the thread
 *                    ends with the retry's reply ALONE — not glued to the stall.
 *   B  STALL-ALWAYS  both attempts stall → the turn ends with the plain error.
 *   C  HOLD-BACK     thought, "\n\n", then 12 s of silence while the counter
 *                    moves (a held-back tool call) → left alone; the call lands.
 *
 *   SHOT_DIR=/tmp/stream-stall node tests/e2e/stream-stall-probe.mjs
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = 'mock-4b@rapid-mlx';
const STALL_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THOUGHT_1 = 'The user wants projectile motion explained, with an animation of a kicked ball.';
const THOUGHT_2 = 'Keep it concrete: a kicked ball, gravity pulling it down, a parabola.';
const ANSWER =
  'A kicked ball moves sideways at a steady speed while gravity slows its climb and then ' +
  'speeds its fall, so its path is a parabola: height rises and falls, distance grows evenly.';
// One frame each: role, the thought, the "\n\n" after </think> — then the silence.
const stalled = { reasoning: THOUGHT_1, content: '\n\n', chunkSize: 400, stallAfterChunks: 3 };
const rules = [
  {
    name: 'stall-once',
    match: { lastUser: 'STALL-ONCE', stream: true, hasTools: true },
    reply: [
      stalled,
      // The retry: 2.5 s before its first byte (a prefill), then the answer.
      { reasoning: THOUGHT_2, content: ANSWER, chunkSize: 24, chunkDelayMs: 30, latencyMs: 2500 },
    ],
  },
  {
    name: 'stall-always',
    match: { lastUser: 'STALL-ALWAYS', stream: true, hasTools: true },
    reply: stalled,
  },
  {
    name: 'hold-back',
    match: { lastUser: 'HOLD-BACK', stream: true, hasTools: true, afterTool: false },
    reply: {
      reasoning: 'I will run it in one go.',
      content: '\n\n',
      toolCalls: [{ name: 'bash', arguments: { command: 'echo held-back-call-arrived' } }],
      chunkSize: 400,
      stallAfterChunks: 3,
      silentWorkMs: 12_000, // three windows of silence, the engine stepping throughout
    },
  },
  {
    name: 'after-tool',
    match: { afterTool: 'held-back-call-arrived' },
    reply: { content: 'The command ran and printed held-back-call-arrived.' },
  },
];
const mock = await startMockOpenAI({
  model: MODEL,
  rules,
  keepaliveMs: 1000,
  defaultReply: { content: 'OK.' },
});

const home = probeHome('stream-stall');
writeModelsJson(home, {
  provider: 'mlx',
  api: 'mlx-stream',
  baseUrl: mock.baseUrl,
  model: MODEL,
  name: 'Mock 4B (rapid-mlx)',
});

const { app, page, check, shot, finish, shotDir } = await launchApp('stream-stall', {
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_E2E_NO_SERVER: '1',
    PI_STREAM_STALL_MS: String(STALL_MS),
    PI_STREAM_STALL_PROBE_AFTER_MS: '1000',
    PI_STREAM_STALL_PROBE_EVERY_MS: '1000',
  },
  timeout: 60_000,
});
const mainLog = path.join(shotDir, 'main.log');
writeFileSync(mainLog, '');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const log = (m) => console.log(`[stream-stall] ${m}`);

/** The thread since message `k`: the assistant rows, the footer's retry, busy-ness. */
const thread = (k) =>
  page.evaluate((from) => {
    const st = window.__pi_store().getState();
    const rows = st.messages.slice(from).filter((m) => m.kind === 'assistant');
    return {
      rows: rows.map((m) => ({
        blocks: (m.blocks ?? []).map((b) =>
          b.type === 'toolCall' ? { type: 'toolCall', name: b.name } : b,
        ),
        stopReason: m.stopReason ?? null,
        errorMessage: m.errorMessage ?? null,
        streaming: m.isStreaming === true,
      })),
      retry: st.agent.retry ?? null,
      busy: st.messages.some((m) => m.isStreaming) || st.promptInFlight === true,
    };
  }, k);

async function send(text) {
  for (let d = 0; d < 3; d += 1) {
    if ((await page.$('.pd-dialog-overlay[data-state="open"]')) === null) break;
    await page.keyboard.press('Escape');
    await sleep(400);
  }
  await page.click('[data-testid="new-chat"]').catch(() => {});
  await sleep(1200);
  const k = await page.evaluate(() => window.__pi_store().getState().messages.length);
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
  return k;
}

async function until(pred, timeoutMs, k) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await thread(k);
    if (pred(t)) return t;
    await sleep(150);
  }
  return null;
}
const settled = (t) => t.rows.length > 0 && !t.busy && t.rows.every((r) => !r.streaming);
const chatRequests = (marker) =>
  mock.log.filter((e) => e.stream === true && (e.lastUser ?? '').includes(marker));

const summary = {};
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  check(started.pid > 0, `pi did not start: ${JSON.stringify(started)}`);
  const set = await page.evaluate(
    (m) => window.piDesktop.invoke('pi:set-model', { provider: 'mlx', modelId: m }),
    MODEL,
  );
  check(set.success === true, `pi:set-model failed: ${JSON.stringify(set)}`);
  await page.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 20_000,
  });

  // ── A: stalls once, recovers ───────────────────────────────────────────────
  {
    const t0 = Date.now();
    const k = await send(
      'STALL-ONCE: explain projectile motion to me with an animation — a ball kicked at an angle.',
    );
    const thinking = await until(
      (t) => t.rows.some((r) => r.blocks.some((b) => (b.thinking ?? '').includes('kicked ball'))),
      15_000,
      k,
    );
    check(thinking !== null, 'A: the first attempt never showed its thought');
    await sleep(1500); // the silence, as the person sees it
    await shot('A1-silent-after-thought');
    const retrying = await until((t) => t.retry !== null, STALL_MS + 8000, k);
    summary.aRetryAfterMs = Date.now() - t0;
    check(retrying !== null, 'A: the footer never said it was retrying');
    if (retrying !== null) {
      check(
        retrying.retry.attempt === 1 && retrying.retry.maxAttempts === 1,
        `A: retry status ${JSON.stringify(retrying.retry)}`,
      );
      await shot('A2-retrying');
    }
    const done = await until(settled, 30_000, k);
    summary.aDoneAfterMs = Date.now() - t0;
    await sleep(800);
    await shot('A3-recovered');
    const row = done?.rows.at(-1);
    summary.aBlocks = row?.blocks;
    check(
      row?.stopReason === 'stop',
      `A: turn ended ${row?.stopReason} ${row?.errorMessage ?? ''}`,
    );
    check(
      JSON.stringify(row?.blocks) ===
        JSON.stringify([
          { type: 'thinking', thinking: THOUGHT_2 },
          { type: 'text', text: ANSWER },
        ]),
      `A: the thread should show the retry alone, got ${JSON.stringify(row?.blocks)}`,
    );
    const reqs = chatRequests('STALL-ONCE');
    summary.aRequests = reqs.map((e) => ({ cancelled: e.cancelled, frames: e.framesSent }));
    check(reqs.length === 2, `A: expected 2 chat requests, saw ${reqs.length}`);
    check(reqs[0]?.cancelled === true, 'A: the stalled request was not cancelled by the client');
    check(reqs[1]?.cancelled === false, 'A: the retry did not complete');
  }

  // ── B: stalls twice, gives up plainly ──────────────────────────────────────
  {
    const t0 = Date.now();
    const k = await send('STALL-ALWAYS: explain projectile motion to me.');
    const done = await until(settled, 2 * STALL_MS + 20_000, k);
    summary.bDoneAfterMs = Date.now() - t0;
    await sleep(800);
    await shot('B-gave-up');
    const row = done?.rows.at(-1);
    summary.bError = row?.errorMessage;
    check(row?.stopReason === 'error', `B: expected an error, got ${row?.stopReason}`);
    check(
      /^The model stopped responding: no output for \d+ s, and the engine reported no work in progress\. It was cancelled and sent again, and the new attempt stalled the same way\./.test(
        row?.errorMessage ?? '',
      ),
      `B: error text: ${row?.errorMessage}`,
    );
    const reqs = chatRequests('STALL-ALWAYS');
    check(
      reqs.length === 2 && reqs.every((e) => e.cancelled === true),
      `B: expected 2 cancelled requests, saw ${JSON.stringify(reqs.map((e) => e.cancelled))}`,
    );
    const onScreen = await page.evaluate(() => document.body.innerText);
    check(
      onScreen.includes('The model stopped responding'),
      'B: the error is not visible in the thread',
    );
  }

  // ── C: a long silence while the engine works is left alone ─────────────────
  {
    const t0 = Date.now();
    const k = await send('HOLD-BACK: run the command in one go.');
    await sleep(STALL_MS + 3000); // past one window, still silent
    await shot('C1-silent-while-working');
    const midway = await thread(k);
    check(midway.retry === null, 'C: the footer said "Retrying" while the engine was working');
    const done = await until(settled, 40_000, k);
    summary.cDoneAfterMs = Date.now() - t0;
    await sleep(800);
    await shot('C2-held-back-call-landed');
    const reqs = chatRequests('HOLD-BACK');
    summary.cRequests = reqs.map((e) => ({ cancelled: e.cancelled, afterTool: e.afterTool }));
    const first = reqs.find((e) => e.afterTool === false);
    check(first !== undefined && first.cancelled === false, 'C: the held-back call was cancelled');
    check(
      reqs.filter((e) => e.afterTool === false).length === 1,
      `C: the request was sent ${reqs.filter((e) => e.afterTool === false).length} times`,
    );
    const calls = (done?.rows ?? []).flatMap((r) => r.blocks.filter((b) => b.type === 'toolCall'));
    check(
      calls.some((c) => c.name === 'bash'),
      'C: the held-back tool call never ran',
    );
  }
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  writeFileSync(path.join(shotDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    path.join(shotDir, 'mock-log.json'),
    `${JSON.stringify(
      mock.log.map(({ body: _b, ...rest }) => rest),
      null,
      2,
    )}\n`,
  );
  log(JSON.stringify(summary, null, 2));
  await finish();
  await mock.close();
}
