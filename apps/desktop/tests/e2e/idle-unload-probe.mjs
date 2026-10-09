/**
 * THE MODEL UNLOADS WHEN NOBODY IS USING IT, AND IS BACK BEFORE THE MESSAGE IS.
 *
 * The user (2026-10-09): unload the model "if there's more than 5 minutes
 * without interaction … the instant the user starts inputting, the load starts
 * prefill starts, to the user, it should still be instant and snappy so long
 * as they take enough time typing their message or more as it takes to load
 * the model and prefill."
 *
 * Real app (hidden window, throwaway HOME, real weights), real model, the idle
 * window shortened to IDLE_MS so the probe does not wait five minutes:
 *
 *   1. a turn with a long answer — the model must NOT unload while it runs,
 *      even though no key is pressed for longer than the idle window;
 *   2. then no input → the model unloads (status.parked, reason idle) and its
 *      process is gone;
 *   3. a click into the composer → the model loads back; the composer re-primes
 *      the conversation; "typing" takes TYPE_MS; Enter → first token, and how
 *      much of the prompt the engine had to read (prefix reuse);
 *   4. unload again, then the fast typist: click and Enter at once — it must
 *      still answer (load + prefill on the clock, no failure);
 *   5. the thinking cap rides on every chat request (thinking_budget_tokens /
 *      reasoning_max_tokens + the end message).
 *
 *   MODEL    (default qwen3.5-4b-mtp)   ENGINE=llamacpp to force llama.cpp
 *   IDLE_MS  idle window (default 15000)  TYPE_MS  typing time (default 20000)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const IDLE_MS = Number(process.env.IDLE_MS ?? 15_000);
const TYPE_MS = Number(process.env.TYPE_MS ?? 20_000);
const LONG_WORDS = Number(process.env.LONG_WORDS ?? 700);
const OUT = process.env.OUT ?? path.join(tmpdir(), 'idle-unload');
mkdirSync(OUT, { recursive: true });
const DIAG = path.join(OUT, 'prompts.log');
writeFileSync(DIAG, '');
writeFileSync(`${DIAG}.bodies.jsonl`, '');

const home = probeHome('idle-unload');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: MODEL },
    ...(process.env.ENGINE === 'llamacpp' ? { modelSpec: { [MODEL]: { method: 'mtp' } } } : {}),
  }),
);

const { app, page, check, shot, finish } = await launchApp('idle-unload', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    PI_DIAG_PROMPTS: DIAG,
    PI_DIAG_PROMPTS_FULL: '1',
    PI_IDLE_UNLOAD_MS: String(IDLE_MS),
  },
  waitFor: '[data-testid="composer-input"]',
  timeout: 120_000,
});
const APP_LOG = path.join(OUT, 'app.log');
writeFileSync(APP_LOG, '');
for (const s of [app.process().stderr, app.process().stdout]) {
  s?.on('data', (c) => appendFileSync(APP_LOG, c));
}
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = () => page.evaluate(() => window.__llm_store().getState().status);
const usage = () =>
  readFileSync(DIAG, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('[pi-diag-usage]'))
    .map((l) => ({
      prompt: Number(/prompt_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
      cached: Number(/cached_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
    }));
const bodies = () => {
  try {
    return readFileSync(`${DIAG}.bodies.jsonl`, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((b) => b !== null);
  } catch {
    return [];
  }
};
const assistants = () =>
  page.evaluate(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.filter((m) => m.kind === 'assistant').length,
  );
const turnIdle = () =>
  page.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return s.agent.isStreaming !== true && s.promptInFlight !== true;
    },
    undefined,
    { timeout: 300_000 },
  );
const firstToken = (before) =>
  page.waitForFunction(
    (n) => {
      const rows = window
        .__pi_store()
        .getState()
        .messages.filter((m) => m.kind === 'assistant');
      if (rows.length <= n) return false;
      return (rows[rows.length - 1].blocks ?? []).some(
        (b) => (b.text ?? '').length > 0 || (b.thinking ?? '').length > 0,
      );
    },
    before,
    { timeout: 300_000, polling: 25 },
  );
const portUp = async (baseUrl) => {
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
};
/** Wait for the idle unload; returns ms waited, or null. */
const waitUnload = async (limitMs) => {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    const s = await status();
    if (s.parked !== undefined) return { ms: Date.now() - start, reason: s.parkedReason };
    await sleep(250);
  }
  return null;
};
const send = async (text) => {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(text);
  const before = await assistants();
  const at = Date.now();
  await page.keyboard.press('Enter');
  await firstToken(before);
  return Date.now() - at;
};

const table = [];
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 60_000,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  log(`starting ${MODEL}…`);
  await page.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await page.waitForFunction(
    (m) => {
      const s = window.__llm_store?.().getState().status;
      return s?.model?.id === m && s.phase === 'ready' && s.serverRunning === true;
    },
    MODEL,
    { timeout: 600_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  const st = await status();
  log(`model ${st.model?.id} on ${st.baseUrl} (engine ${st.profile?.engine ?? '?'})`);
  await sleep(6000); // the harness warm-up

  // 1. A long turn: no key pressed for longer than the idle window, and it must stay loaded.
  log('1. a long answer, no input meanwhile');
  const before1 = await assistants();
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(
    `Write a detailed ${LONG_WORDS}-word history of the bicycle, with headings. Do not use any tools.`,
  );
  await page.keyboard.press('Enter');
  await firstToken(before1);
  const turnStart = Date.now();
  let parkedDuringTurn = false;
  while (true) {
    const s = await page.evaluate(() => {
      const p = window.__pi_store().getState();
      return {
        streaming: p.agent.isStreaming === true || p.promptInFlight === true,
        parked: window.__llm_store().getState().status.parked !== undefined,
      };
    });
    if (s.parked) parkedDuringTurn = true;
    if (!s.streaming) break;
    if (Date.now() - turnStart > 300_000) break;
    await sleep(500);
  }
  const turnMs = Date.now() - turnStart;
  log(`   turn ran ${(turnMs / 1000).toFixed(1)}s (idle window ${IDLE_MS / 1000}s)`);
  check(!parkedDuringTurn, 'the model stayed loaded through a turn longer than the idle window');
  table.push([
    'long turn, no input',
    `${(turnMs / 1000).toFixed(1)}s`,
    parkedDuringTurn ? 'UNLOADED (bad)' : 'stayed loaded',
  ]);
  check(turnMs > IDLE_MS, `the turn outlasted the idle window (${turnMs}ms > ${IDLE_MS}ms)`);

  // 5. The cap on the wire.
  const chat = bodies()
    .filter((b) => b.engine !== 'utility')
    .map((b) => b.body ?? b)
    .filter((b) => Array.isArray(b.messages));
  const last = chat[chat.length - 1] ?? {};
  const capped =
    typeof last.thinking_budget_tokens === 'number' ||
    typeof last.reasoning_max_tokens === 'number';
  log(
    `   cap on the wire: thinking_budget_tokens=${last.thinking_budget_tokens} reasoning_max_tokens=${last.reasoning_max_tokens} message=${JSON.stringify((last.reasoning_budget_message ?? '').slice(0, 50))}`,
  );
  check(capped, 'the chat request carries a thinking budget');

  // 2. Idle → unload.
  log('2. no input — waiting for the idle unload');
  const un = await waitUnload(IDLE_MS + 60_000);
  check(un !== null && un.reason === 'idle', `the model unloaded for idle (${JSON.stringify(un)})`);
  const gone = !(await portUp(st.baseUrl));
  check(gone, 'its server process is gone (the port does not answer)');
  table.push([
    'unload after the turn',
    un === null ? 'never' : `${(un.ms / 1000).toFixed(1)}s after the reply`,
    gone ? 'process stopped' : 'still answering',
  ]);
  await shot('01-unloaded-idle');

  // 3. Start typing → loads back, re-primes; Enter after TYPE_MS.
  log('3. click into the composer (input starts)');
  const typeStart = Date.now();
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('And ');
  let backMs = null;
  while (Date.now() - typeStart < 300_000) {
    const s = await status();
    if (s.parked === undefined && (await portUp(st.baseUrl))) {
      backMs = Date.now() - typeStart;
      break;
    }
    await sleep(200);
  }
  log(
    `   model back ${backMs === null ? 'NEVER' : `${(backMs / 1000).toFixed(1)}s`} after the first keystroke`,
  );
  check(backMs !== null, 'the model loaded back on input');
  // Keep "typing" for the rest of TYPE_MS: a key every ~700 ms, as a person
  // writing the message would (a silent wait longer than IDLE_MS is not typing,
  // and correctly unloads again — the first run of this probe did exactly that).
  const words = 'who invented the chain drive, and when did it first appear on bicycles'.split(' ');
  let w = 0;
  while (Date.now() - typeStart < TYPE_MS && w < words.length) {
    await page.keyboard.type(`${words[w]} `);
    w += 1;
    await sleep(700);
  }
  while (Date.now() - typeStart < TYPE_MS) {
    await page.keyboard.press('Shift');
    await sleep(700);
  }
  const prefillLog = await page.evaluate(() => (window.__prefill_log ?? []).slice(-6));
  const primed = prefillLog.filter((e) => e.what === 'primed');
  writeFileSync(path.join(OUT, 'prefill-log.json'), JSON.stringify(prefillLog, null, 1));
  log(
    `   prefill log tail: ${JSON.stringify(prefillLog.map((e) => ({ what: e.what, because: e.because, success: e.success, error: e.error, promptN: e.promptN, processedN: e.processedN })))}`,
  );
  const usageBefore = usage().length;
  const before3 = await assistants();
  const sendAt = Date.now();
  await page.keyboard.press('Enter');
  await firstToken(before3);
  const ttft = Date.now() - sendAt;
  // llama-server: the slot's own count of what this turn processed (its usage
  // line reports 0 cached on every turn, reused or not). rapid-mlx: the usage.
  let slotRead = null;
  try {
    const slots = await (await fetch(`${st.baseUrl.replace(/\/v1$/, '')}/slots`)).json();
    const s0 = Array.isArray(slots) ? slots[0] : null;
    if (s0 && typeof s0.n_prompt_tokens_processed === 'number')
      slotRead = { processed: s0.n_prompt_tokens_processed, total: s0.n_prompt_tokens };
  } catch {}
  await turnIdle();
  const u = usage().slice(usageBefore);
  const usageLine = u.find((x) => x.prompt > 100) ?? u[0];
  const turnUsage =
    slotRead !== null && typeof slotRead.total === 'number'
      ? { prompt: slotRead.total, cached: slotRead.total - slotRead.processed }
      : usageLine;
  log(
    `   TTFT ${ttft}ms; engine read ${turnUsage ? turnUsage.prompt - turnUsage.cached : '?'} of ${turnUsage?.prompt ?? '?'} prompt tokens`,
  );
  table.push([
    'type for ' + TYPE_MS / 1000 + 's, then Enter',
    `TTFT ${ttft}ms`,
    turnUsage
      ? `read ${turnUsage.prompt - turnUsage.cached}/${turnUsage.prompt} tokens`
      : 'no usage line',
  ]);
  check(
    primed.length > 0 || (turnUsage && turnUsage.cached > turnUsage.prompt * 0.8),
    'the conversation was primed again while typing',
  );
  await shot('02-after-reload-reply');

  // 4. The fast typist.
  log('4. unload again, then click + Enter at once');
  const un2 = await waitUnload(IDLE_MS + 60_000);
  check(un2 !== null, 'unloaded again');
  const fast = await send('one word: yes or no?');
  await turnIdle();
  log(`   fast typist: ${fast}ms to first token, from unloaded`);
  table.push(['unloaded, click + Enter at once', `TTFT ${fast}ms`, 'load + prefill on the clock']);
  check(fast < 300_000, 'the fast typist still got an answer');
  await shot('03-fast-typist');

  const appLog = readFileSync(APP_LOG, 'utf8');
  const idleLines = appLog
    .split('\n')
    .filter((l) => /idle-unload|park chat model|resume chat model/.test(l));
  writeFileSync(path.join(OUT, 'idle-lines.txt'), idleLines.join('\n'));
  log(`   app log: ${idleLines.length} idle/park/resume lines (OUT/idle-lines.txt)`);
} catch (error) {
  check(false, `probe error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  console.log(`\n──────── idle unload · ${MODEL} ────────`);
  for (const [a, b, c] of table) console.log(`  ${a.padEnd(34)} ${String(b).padEnd(28)} ${c}`);
  await finish();
}
