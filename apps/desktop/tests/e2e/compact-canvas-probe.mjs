/**
 * COMPACTION WITH THE ACTIVITY TAB OPEN — the second half of the crash hunt.
 *
 * Both renderer crashes in the canvas assessment came on the second turn of a
 * chat whose first turn had looped through a dozen tool calls — the point where
 * a 4B at 32k context compacts. This runs two real bash-using turns, then asks
 * pi to compact while the Activity terminal holds their output, then sends a
 * third turn, recording every page error with its full stack.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PROJECT = process.env.PROJECT ?? '/tmp/canvas-assess/project';
const OUT = process.env.OUT ?? '/tmp/canvas-assess/compact';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
const home = probeHome('compact-probe');
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'compact-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'),
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const errors = [];
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(`[pageerror] ${String(e.stack ?? e)}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.evaluate((p) => window.piDesktop.invoke('project:set', { path: p }), PROJECT);
  await win.reload();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(2000);
  const up = await win.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL,
  );
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await win.evaluate((p) => window.piDesktop.invoke('pi:restart', { cwd: p }), PROJECT);
  const models = await win.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  await win.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  await win.evaluate(
    (id) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({ modelSelection: { mode: 'model', modelId: id } }),
    MODEL,
  );
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
    timeout: 60000,
  });
  await win.waitForTimeout(2500);

  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight && !s.agent.isCompacting;
    });
  const waitReady = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await ready()) return true;
      await win.waitForTimeout(1000);
    }
    return false;
  };
  const send = async (text) => {
    const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
    const editor = win.locator('[contenteditable="true"]').first();
    await editor.click();
    await win.keyboard.type(text, { delay: 4 });
    await win.keyboard.press('Enter');
    await win
      .waitForFunction((b) => window.__pi_store().getState().messages.length > b, before, {
        timeout: 45000,
      })
      .catch(() => {});
    const ok = await waitReady(240000);
    say(`turn done=${ok}: ${text.slice(0, 40)}`);
  };

  await send('Run `ls -la ./data` and `wc -l ./data/*.json`, then tell me the line counts.');
  await send('Now run `head -c 400 ./data/users.json` and `python3 -c "print(sum(range(100)))"`.');
  const tabs1 = await win.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => t.kind),
  );
  say(`tabs before compaction: ${JSON.stringify(tabs1)} errors=${errors.length}`);
  const res = await win.evaluate(() => window.piDesktop.invoke('pi:compact', undefined));
  say(`compact: ${JSON.stringify(res)}`);
  await waitReady(180000);
  await win.waitForTimeout(2000);
  await win.screenshot({ path: path.join(OUT, 'after-compact.png') });
  say(
    `after compaction: errors=${errors.length} msgs=${await win.evaluate(() => window.__pi_store().getState().messages.length)}`,
  );
  await send('Run `ls ./docs` and tell me how many files there are.');
  await win.waitForTimeout(1500);
  const boundary = await win
    .evaluate(() => document.body.innerText.includes('rendering error'))
    .catch(() => true);
  await win.screenshot({ path: path.join(OUT, 'final.png') });
  say(`final: boundary=${boundary} errors=${errors.length}`);
} finally {
  writeFileSync(path.join(OUT, 'errors.txt'), errors.join('\n\n=====\n\n'));
  await app.close().catch(() => {});
}
