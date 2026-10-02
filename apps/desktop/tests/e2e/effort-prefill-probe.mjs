/**
 * QWEN3.8 27B AT MEDIUM EFFORT — THE LIVE SERVER, ITS PROMPT, AND ITS PREFILL.
 *
 * the user (2026-10-02): "qwen3.8-27b comes with a built in settable thinking
 * effort, it's xhigh by default, set it to medium". The catalog pins
 * `reasoning_effort: 'medium'` as a chat-template kwarg (`61ede173`). This
 * checks, on the real model in the real app (headless):
 *
 *   1. the llama-server it launched carries the kwarg (its command line);
 *   2. the template on that server renders medium — no "Reasoning effort is
 *      set to xhigh" line — and still renders xhigh when a request names it;
 *   3. two short turns: TTFT (Enter → first character on screen), the
 *      server's own prefill account from /slots (prompt tokens vs processed),
 *      how long the thought was, and how the turn ended.
 *
 * Turn 2 is the prefill check (the user's rule: chat work is not done until
 * prefill/TTFT is logged): after the warm-up prime has had time to run, the
 * second turn should read only its own new tokens.
 *
 *   node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/effort-prefill-probe.mjs
 *   (OUT=<dir> for the JSON and screenshots)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.8-27b-mtp';
const OUT = process.env.OUT ?? '/tmp/effort-prefill';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const home = probeHome('effort-prefill');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    {
      userMode: 'power',
      effort: 'medium',
      enginePreference: 'llamacpp',
      toolInterface: 'bash-cli',
      modelSelection: { mode: 'model', modelId: MODEL },
    },
    null,
    2,
  )}\n`,
);

const { page, check, finish } = await launchApp('effort-prefill', {
  realCache: true,
  env: { HOME: home, PI_BIN: undefined, HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 120_000,
});
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
await page.waitForFunction(
  (m) =>
    window.__llm_store?.().getState().status.model?.id === m &&
    window.__llm_store().getState().status.phase === 'ready',
  MODEL,
  { timeout: 900_000 },
);
const status = await page.evaluate(() => window.__llm_store().getState().status);
const port = Number(/:(\d+)\/v1/.exec(status.baseUrl ?? '')?.[1] ?? 0);
log(`model up on ${status.baseUrl}`);
const report = { model: MODEL, baseUrl: status.baseUrl };

// 1. The launch's own flags.
const cmd = execSync('ps -ax -o command', { encoding: 'utf8' })
  .split('\n')
  .find((l) => l.includes('llama-server') && l.includes(`--port ${port}`));
const kw = /--chat-template-kwargs (\{[^}]*\})/.exec(cmd ?? '')?.[1] ?? null;
report.launchKwargs = kw;
check(kw !== null && JSON.parse(kw).reasoning_effort === 'medium', `launched with ${kw}`);

// 2. The template, rendered by that server.
const render = async (extra) => {
  const r = await fetch(`http://127.0.0.1:${port}/apply-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are Bobble.' },
        { role: 'user', content: 'hi' },
      ],
      ...extra,
    }),
  });
  const j = await r.json();
  return /Reasoning effort is set to (\w+)/.exec(j.prompt ?? '')?.[1] ?? 'medium';
};
report.renders = {
  default: await render({}),
  requestXhigh: await render({ chat_template_kwargs: { reasoning_effort: 'xhigh' } }),
};
check(
  report.renders.default === 'medium',
  `the template renders ${report.renders.default} by default`,
);
check(report.renders.requestXhigh === 'xhigh', 'a request that names xhigh still gets it');

// 3. Two turns: TTFT, prefill, the thought.
const shape = () =>
  page.evaluate(() => {
    let chars = 0;
    let thought = 0;
    let stop = '';
    for (const row of window.__pi_store().getState().messages) {
      if (row.kind !== 'assistant') continue;
      for (const b of row.blocks ?? []) {
        chars += (b.text ?? b.thinking ?? '').length;
        if (b.type === 'thinking') thought += (b.thinking ?? '').length;
      }
      stop = row.stopReason ?? stop;
    }
    return { chars, thought, stop };
  });
const slots = async () => {
  try {
    const s = await (await fetch(`http://127.0.0.1:${port}/slots`)).json();
    return s.map((x) => ({ total: x.n_prompt_tokens, processed: x.n_prompt_tokens_processed }));
  } catch {
    return [];
  }
};
const turn = async (label, text) => {
  const before = await shape();
  let peak = null;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      for (const s of await slots()) {
        if (s.total > 0 && (peak === null || s.processed >= peak.processed)) peak = s;
      }
      await sleep(50);
    }
  })();
  await page.click('.pd-composer-editor');
  await page.keyboard.type(text, { delay: 5 });
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  let ttft = null;
  while (Date.now() - t0 < 900_000) {
    if (ttft === null && (await shape()).chars > before.chars) ttft = Date.now() - t0;
    const busy = await page
      .locator('[data-testid="composer-stop"], [data-testid="composer-paused"]')
      .count();
    if (ttft !== null && busy === 0) break;
    await sleep(100);
  }
  polling = false;
  await poller;
  const after = await shape();
  const r = {
    label,
    ttftMs: ttft,
    turnMs: Date.now() - t0,
    prompt: peak?.total ?? null,
    processed: peak?.processed ?? null,
    reusedPct:
      peak !== null && peak.total > 0
        ? Math.round(((peak.total - peak.processed) / peak.total) * 100)
        : null,
    thoughtChars: after.thought - before.thought,
    stop: after.stop,
  };
  await page.screenshot({ path: path.join(OUT, `${label}.png`) });
  log(label, JSON.stringify(r));
  return r;
};
report.turn1 = await turn(
  'turn1',
  'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much is the ball? One line.',
);
// The warm-up prime runs on the turn's history after it ends; give it the time a person takes to type.
await sleep(30_000);
report.turn2 = await turn('turn2', 'And if the bat cost $2.00 more than the ball?');
check(report.turn1.stop !== 'length', 'turn 1 answered (not cut off at the output limit)');
check(report.turn2.stop !== 'length', 'turn 2 answered (not cut off at the output limit)');
check(
  report.turn2.reusedPct !== null && report.turn2.reusedPct >= 80,
  `turn 2 reused ${report.turn2.reusedPct}% of its prompt (prefill)`,
);
writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
log('report', JSON.stringify(report));

// The model server first, then the app.
await page.evaluate(() => window.piDesktop.invoke('llm:stop-server')).catch(() => undefined);
await sleep(3000);
await finish();
