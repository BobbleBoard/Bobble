/**
 * WHY DIDN'T MY MESSAGE SEND? — the state, right after pressing Enter.
 *
 * ttft-probe reports TIMEOUT when no assistant row appears, which is the same
 * observation for "the model is slow", "the send queued behind something", and
 * "pi is not running at all". Those need different fixes, so this dumps the
 * three flags that tell them apart instead of inferring from silence.
 *
 *   node tests/e2e/send-diag.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot],
  env: { ...process.env, PI_E2E: '1' },
});

const snap = (win, tag) =>
  win
    .evaluate(() => {
      const pi = window.__pi_store?.().getState?.() ?? {};
      const llm = window.__llm_store?.().getState?.() ?? {};
      return {
        promptInFlight: pi.promptInFlight,
        isStreaming: pi.agent?.isStreaming,
        queued: (pi.queuedSends ?? []).length,
        messages: (pi.messages ?? []).length,
        piRunning: pi.running ?? pi.session !== undefined,
        serverRunning: llm.status?.serverRunning,
        phase: llm.status?.phase,
        warm: pi.extensionStatus?.['harness-prefix-warm'],
      };
    })
    .then((s) => console.log(`${tag}: ${JSON.stringify(s)}`));

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  await snap(win, 'boot     ');

  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  await snap(win, 'server up');

  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  await win.waitForTimeout(8000);
  await snap(win, 'warm     ');

  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type('hi');
  await win.keyboard.press('Enter');
  for (const t of [1000, 4000, 10000, 20000]) {
    await win.waitForTimeout(t === 1000 ? 1000 : t - (t === 4000 ? 1000 : t / 2));
    await snap(win, `+${t}ms   `);
  }
  const errs = await win.evaluate(() => (window.__errors ?? []).slice(0, 5));
  console.log('page errors:', JSON.stringify(errs));
  const msgs = await win.evaluate(() =>
    (window.__pi_store().getState().messages ?? []).map((m) => ({
      kind: m.kind,
      text: (m.text ?? (m.blocks ?? []).map((b) => b.text ?? b.thinking ?? `[${b.type}]`).join(''))
        .slice(0, 90),
    })),
  );
  for (const [i, m] of msgs.entries()) console.log(`  msg${i} ${m.kind}: ${JSON.stringify(m.text)}`);
} finally {
  await app.close();
}
