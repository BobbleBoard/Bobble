/**
 * ONE PROMPT, A REAL MODEL, EVERY TOOL RESULT PRINTED.
 *
 * The smallest live probe: boot the model, root a project, send one message,
 * wait for the turn, print what the model called and what each call returned.
 * For checking a single harness behaviour against a real run without writing
 * a scenario file.
 *
 *   PROMPT="…" MODEL=qwen3.5-4b-mtp MODE=bash-cli PROJECT=/path node tests/e2e/chat-once-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MODE = process.env.MODE ?? 'bash-cli';
const PROMPT = process.env.PROMPT ?? 'Reply with one word.';
const PROJECT = process.env.PROJECT ?? path.join(tmpdir(), 'chat-once', 'project');
const TURN_MS = Number(process.env.TURN_MS ?? 240_000);
mkdirSync(PROJECT, { recursive: true });
const home = probeHome('chat-once');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ toolInterface: MODE, powerMode: 'auto' }),
);

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'chat-once-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'),
    PI_DESKTOP_MODELS_DIR:
      process.env.PI_DESKTOP_MODELS_DIR ?? path.join(homedir(), 'Bobble', 'Models'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const t0 = Date.now();
const say = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);
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
  await win.waitForTimeout(3000);
  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return (
        !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming
      );
    });
  const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type(PROMPT, { delay: 3 });
  await win.keyboard.press('Enter');
  say('sent');
  await win.waitForTimeout(3000);
  const until = Date.now() + TURN_MS;
  while (Date.now() < until) {
    const dlg = await win
      .evaluate(() => {
        const d = document.querySelector('[role="dialog"], [role="alertdialog"]');
        if (!d) return null;
        const c = [...d.querySelectorAll('button')].find((b) =>
          /don.?t|cancel|not now|dismiss|deny|^no\b/i.test(b.textContent ?? ''),
        );
        if (c) {
          c.click();
          return 'cancelled';
        }
        return 'open';
      })
      .catch(() => null);
    if (dlg) say(`[dialog] ${dlg}`);
    if (await ready()) break;
    await win.waitForTimeout(1000);
  }
  const turn = await win.evaluate((b) => {
    const msgs = window.__pi_store().getState().messages.slice(b);
    const out = [];
    for (const m of msgs) {
      if (m.kind === 'assistant')
        for (const blk of m.blocks ?? []) {
          if (blk.type === 'toolCall')
            out.push({ call: blk.name, args: JSON.stringify(blk.arguments).slice(0, 300) });
          if (blk.type === 'text' && blk.text?.trim())
            out.push({ text: blk.text.trim().slice(0, 500) });
        }
      if (m.kind === 'toolResult')
        out.push({
          result: m.toolName,
          isError: m.isError === true,
          text: String(m.text ?? '').slice(0, 1200),
        });
    }
    return out;
  }, before);
  for (const e of turn) {
    if (e.call) say(`CALL ${e.call} ${e.args}`);
    else if (e.result)
      say(`RESULT[${e.result}${e.isError ? ' ERROR' : ''}]: ${e.text.replace(/\n/g, ' ⏎ ')}`);
    else say(`TEXT: ${e.text.replace(/\n/g, ' ')}`);
  }
} finally {
  await app.close().catch(() => {});
}
