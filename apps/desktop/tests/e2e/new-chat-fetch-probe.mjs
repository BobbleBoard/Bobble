/**
 * NEW CHAT → "fetch failed" → five minutes of "Getting this ready" (m04).
 *
 * SEEN once in the canvas assessment, on the fourth scenario's fresh chat: the
 * turn answered "fetch failed" in red, the prefill pill sat on "Getting this
 * ready" for the whole 300 s budget, and then everything recovered by itself.
 * The main log around it said only that the power policy had eased off.
 *
 * This does what the assessment did — a booted model, then new chat after new
 * chat, each re-rooted with `pi:restart({cwd})` and sent one short message —
 * and writes down, per chat: how long the first token took, whether the thread
 * showed "fetch failed", how long the pill stayed up, and every main-log line
 * that could explain a dead endpoint (a server relaunch, a status flip, a
 * respawn). ROUNDS=8 by default.
 *
 *   MODEL=qwen3.5-4b-mtp ROUNDS=8 node tests/e2e/new-chat-fetch-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ROUNDS = Number(process.env.ROUNDS ?? 8);
const OUT = process.env.OUT ?? path.join(tmpdir(), 'new-chat-fetch');
const PROJECT = process.env.PROJECT ?? path.join(tmpdir(), 'new-chat-fetch', 'project');
mkdirSync(OUT, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
const home = probeHome('new-chat-fetch');

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'new-chat-fetch-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'bobble'),
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const mainLog = [];
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const t0 = Date.now();
app.process().stdout?.on('data', (d) =>
  mainLog.push(
    ...String(d)
      .split('\n')
      .filter(Boolean)
      .map((l) => `${stamp()} ${l}`),
  ),
);
app.process().stderr?.on('data', (d) =>
  mainLog.push(
    ...String(d)
      .split('\n')
      .filter(Boolean)
      .map((l) => `${stamp()} ${l}`),
  ),
);
const say = (s) => console.log(`${stamp()} ${s}`);
const rounds = [];

try {
  const win = await app.firstWindow();
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(`${stamp()} ${String(e.message ?? e).slice(0, 300)}`));
  win.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${stamp()} [console] ${m.text().slice(0, 300)}`);
  });
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
  say(`model up: ${MODEL}`);

  // The status the RENDERER sees, and the pill text — sampled on every wait.
  const sample = () =>
    win.evaluate(() => {
      const llm = window.__llm_store?.().getState?.().status ?? null;
      const pill =
        document
          .querySelector('[data-testid="composer-pill"], .pd-composer-pill, .pd-pill')
          ?.textContent?.trim() ?? '';
      const s = window.__pi_store().getState();
      const failed = document.body.innerText.includes('fetch failed');
      return {
        phase: llm?.phase ?? '?',
        serverRunning: llm?.serverRunning ?? null,
        baseUrl: llm?.baseUrl ?? null,
        pill,
        failed,
        streaming: s.agent.isStreaming,
        inFlight: s.promptInFlight,
        session: s.session?.sessionFile?.split('/').pop() ?? null,
      };
    });
  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return (
        !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming
      );
    });

  const MIDTURN = process.env.MIDTURN === '1';
  for (let i = 1; i <= ROUNDS; i += 1) {
    const logStart = mainLog.length;
    if (MIDTURN) {
      /*
       * What the assessment ACTUALLY did before m04: scenario 3 was still
       * running (339 s against a 300 s budget) when the probe clicked New chat
       * and re-rooted pi. A person does the same thing — new chat while a
       * reply is streaming. So: start a long reply, then leave it mid-stream.
       */
      const ed = win.locator('[contenteditable="true"]').first();
      await ed.click();
      await win.keyboard.type('Write a 1200-word short story about a lighthouse keeper, in full.', {
        delay: 2,
      });
      await win.keyboard.press('Enter');
      await win.waitForTimeout(6000);
      const mid = await sample();
      say(`round ${i}: leaving a reply mid-stream (streaming=${mid.streaming})`);
    }
    // What the assessment did for a fresh chat.
    await win.click('[data-testid="new-chat"]').catch(() => {});
    await win.waitForTimeout(1200);
    await win.evaluate((p) => window.piDesktop.invoke('pi:restart', { cwd: p }), PROJECT);
    await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
      timeout: 60000,
    });
    await win.waitForTimeout(2000);
    await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
    await win.waitForTimeout(600);
    const before = await sample();
    const msgsBefore = await win.evaluate(() => window.__pi_store().getState().messages.length);
    const editor = win.locator('[contenteditable="true"]').first();
    await editor.click();
    await win.keyboard.type(`Round ${i}: reply with exactly one word.`, { delay: 3 });
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    let ttft = null;
    let failedAt = null;
    let pillSeen = '';
    let pillMs = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = await sample();
      if (s.pill.length > 0) {
        pillSeen = s.pill;
        pillMs = Date.now() - sentAt;
      }
      if (s.failed && failedAt === null) failedAt = Date.now() - sentAt;
      const chars = await win.evaluate((b) => {
        const msgs = window.__pi_store().getState().messages.slice(b);
        let c = 0;
        for (const m of msgs)
          if (m.kind === 'assistant')
            for (const blk of m.blocks ?? [])
              c += blk.type === 'toolCall' ? 1 : (blk.text ?? blk.thinking ?? '').length;
        return c;
      }, msgsBefore);
      if (chars > 0 && ttft === null) ttft = Date.now() - sentAt;
      if (ttft !== null && (await ready())) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (process.env.DIAG === '1') {
      for (let k = 0; k < 12; k += 1) {
        const st = await win.evaluate(() => {
          const s = window.__pi_store().getState();
          return {
            streaming: s.agent.isStreaming,
            inFlight: s.promptInFlight,
            bg:
              s.bgRun === null
                ? null
                : { streaming: s.bgRun.streaming, file: s.bgRun.sessionFile?.split('/').pop() },
            resuming: s.resuming,
            queued: s.queuedSends?.length ?? 0,
            msgs: s.messages.map(
              (m) =>
                `${m.kind}${m.kind === 'assistant' ? `(${m.isStreaming ? 'live' : 'done'},${(m.blocks ?? []).length})` : ''}`,
            ),
            session: s.session?.sessionFile?.split('/').pop(),
          };
        });
        say(`   diag ${k}: ${JSON.stringify(st)}`);
        await win.waitForTimeout(1000);
      }
      await win.screenshot({ path: path.join(OUT, `round-${i}-settled.png`) });
    }
    const after = await sample();
    const seconds = Math.round((Date.now() - sentAt) / 1000);
    const logs = mainLog
      .slice(logStart)
      .filter((l) =>
        /launch|status|relaunch|respawn|fetch|exit|spawn|pi-power|server|slot|prefill/i.test(l),
      )
      .slice(0, 30);
    const round = { i, ttft, failedAt, pillSeen, pillMs, seconds, before, after, logs };
    rounds.push(round);
    say(
      `round ${i}: ttft=${ttft ?? 'NONE'}ms failed=${failedAt ?? '-'} pill="${pillSeen}"@${pillMs}ms done=${seconds}s phase=${before.phase}->${after.phase} session=${after.session}`,
    );
    if (failedAt !== null || ttft === null) {
      await win.screenshot({ path: path.join(OUT, `round-${i}.png`) });
      for (const l of logs) say(`   ${l}`);
    }
  }
  writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify({ model: MODEL, rounds, pageErrors, mainLog: mainLog.slice(-200) }, null, 2),
  );
} catch (err) {
  say(`FAILED: ${err.message}`);
  writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify(
      { model: MODEL, rounds, failed: String(err.message), mainLog: mainLog.slice(-200) },
      null,
      2,
    ),
  );
} finally {
  await app.close().catch(() => {});
}
console.log(`report: ${path.join(OUT, 'report.json')}`);
