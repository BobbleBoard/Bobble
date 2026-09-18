/**
 * FIRST TOKEN ON THE APP'S OWN MODEL PATH. "hi" with the model the settings
 * select (the path a person takes — the engine the catalog chose for it, e.g.
 * rapid-mlx for qwen3.5-4b-mtp), timing the first token. Hidden; throwaway
 * HOME (the real model cache). `ttft-probe.mjs` wires llamacpp by hand through
 * pi:set-model, which a rapid-mlx model never answers (2026-09-18: "pi lists
 * nothing; target=NONE", a turn that never reaches the server) — this one asks
 * the app the way the composer does.
 *
 *   LOG=/tmp/first-token.log node apps/desktop/tests/e2e/first-token-probe.mjs
 * MEASURED 2026-09-18 (09d75b41): 282 ms, 3320 of 3438 prompt tokens reused.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const home = probeHome('first-token');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }, null, 2)}\n`,
);
const LOG = process.env.LOG ?? '/tmp/first-token.log';
const { app, page, check, finish } = await launchApp('first-token', {
  realCache: true,
  app: process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble',
  env: { HOME: home, PI_BIN: undefined, HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 120_000,
});
for (const s of [app.process().stderr, app.process().stdout])
  s?.on('data', (c) => appendFileSync(LOG, c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  const modelId = await page.evaluate(() => window.__pi_store().getState().agent.model?.id);
  await sleep(6000);
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText('hi');
  const sentAt = Date.now();
  await page.keyboard.press('Enter');
  let ttft = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const chars = await page.evaluate(() => {
      const rows = window.__pi_store().getState().messages;
      const last = rows[rows.length - 1];
      return last?.kind === 'assistant'
        ? (last.blocks ?? []).reduce((n, b) => n + (b.text ?? b.thinking ?? '').length, 0)
        : 0;
    });
    if (chars > 0) {
      ttft = Date.now() - sentAt;
      break;
    }
    await sleep(25);
  }
  console.log(JSON.stringify({ modelId, ttft }));
  check(ttft !== null && ttft < 5000, `first token in ${ttft}ms (${modelId})`);
} finally {
  await finish();
  rmSync(home, { recursive: true, force: true });
}
