/**
 * THE CARDS FOLLOW THE CHAT. the user (2026-09-17): "I just went back to a chat I
 * earlier made some visuals in and it didn't have them there, nor in the
 * canvas when I went to files."
 *
 * With the real model: a chart is made in a fresh chat (its first turn —
 * the chat has no session file when the card lands); then New chat; then back
 * to the first chat; then the window is RELOADED (the store is memory; the
 * transcript is what survives). The card must be there after each.
 *
 *   SHOT_DIR=/tmp/chart-persist node apps/desktop/tests/e2e/chart-persist-probe.mjs
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ENGINE = process.env.ENGINE ?? 'rapid-mlx/mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/chart-persist';
mkdirSync(SHOT_DIR, { recursive: true });

const home = probeHome('chart-persist');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }, null, 2)}\n`,
);
const { app, page, check, finish } = await launchApp('chart-persist', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_E2E_HEADED: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = async (label) => page.screenshot({ path: path.join(SHOT_DIR, `${label}.png`) });
const cards = () =>
  page.evaluate(() => ({
    charts: document.querySelectorAll('[data-testid="presented-chart"]').length,
    titles: [...document.querySelectorAll('[data-testid="presented-chart"] .pd-chart-title')].map(
      (t) => t.textContent,
    ),
    session: window.__pi_store().getState().session?.sessionFile ?? null,
    messages: window.__pi_store().getState().messages.length,
  }));
const settled = () =>
  page
    .waitForFunction(
      () => {
        const s = window.__pi_store().getState();
        return (
          s.messages.some(
            (x) =>
              x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          ) &&
          !s.messages.some((x) => x.isStreaming) &&
          s.promptInFlight !== true
        );
      },
      undefined,
      { timeout: 240_000, polling: 1000 },
    )
    .then(() => true)
    .catch(() => false);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await sleep(3000);
  log(`starting ${MODEL} on ${ENGINE}…`);
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  const [engine, spec] = ENGINE.split('/');
  const already = await page.evaluate(
    ({ engine, spec }) => {
      const s = window.__llm_store().getState().status;
      return s.profile?.engine === engine && s.profile?.spec === spec;
    },
    { engine, spec },
  );
  if (ENGINE !== 'llamacpp/none' && !already) {
    await page.evaluate(
      ({ engine, spec }) => window.__llm_store().getState().switchProfile(engine, spec),
      { engine, spec },
    );
    await page.waitForFunction(
      ({ engine, spec }) => {
        const s = window.__llm_store().getState().status;
        return s.phase === 'ready' && s.profile?.engine === engine && s.profile?.spec === spec;
      },
      { engine, spec },
      { timeout: 300_000 },
    );
  }
  const want = ENGINE.startsWith('llamacpp') ? MODEL : `${MODEL}@${engine}`;
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    want,
    { timeout: 120_000 },
  );
  await sleep(3000);
  log(`model ${want} up`);

  // 1. A chart in the FIRST turn of a fresh chat.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(
    'Units sold by year: 2021: 12, 2022: 19, 2023: 15, 2024: 22. Make a bar chart of it.',
  );
  await page.mouse.move(180, 700);
  await page.keyboard.press('Enter');
  const ended = await settled();
  await sleep(2000);
  let s = await cards();
  await shot('1-made');
  check(ended, 'the turn ended');
  check(s.charts >= 1, `a chart card in the first turn (${s.charts}); session ${s.session}`);
  const firstSession = s.session;
  check(
    firstSession !== null && firstSession !== '',
    `the chat has a session file now: ${firstSession}`,
  );
  const firstTitle = s.titles[0];

  // 2. New chat, then back.
  await page.click('[data-testid="new-chat"]');
  await sleep(2000);
  s = await cards();
  check(s.charts === 0, `a new chat shows no cards (${s.charts})`);
  await page.evaluate((file) => window.__pi_switch_session?.(file), firstSession);
  await sleep(1500);
  // Fall back to the sidebar row if the E2E handle is absent.
  s = await cards();
  if (s.session !== firstSession) {
    const rows = page.locator('[data-testid^="chat-row-"]');
    const n = await rows.count();
    for (let i = 0; i < n; i += 1) {
      const t = await rows.nth(i).getAttribute('data-testid');
      if ((t ?? '').toLowerCase().includes('units')) {
        await rows.nth(i).click();
        break;
      }
    }
    await sleep(3000);
    s = await cards();
  }
  await shot('2-back');
  check(s.session === firstSession, `back on the first chat (${s.session})`);
  check(
    s.charts >= 1 && s.titles[0] === firstTitle,
    `its card is still there: ${JSON.stringify(s.titles)}`,
  );

  // 3. Reload the window: the store is gone; the transcript brings the card back.
  await page.reload();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__pi_switch_session === 'function', {
    timeout: 60_000,
  });
  await sleep(4000);
  // A fresh window opens on a new chat; the old one is a click away (the
  // sidebar row) — the same thing the user did.
  await page.evaluate((file) => window.__pi_switch_session?.(file), firstSession);
  await page
    .waitForFunction(
      (file) =>
        window.__pi_store().getState().session?.sessionFile === file &&
        window.__pi_store().getState().messages.length > 0,
      firstSession,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await sleep(4000);
  s = await cards();
  await shot('3-reloaded');
  check(s.messages > 0, `the transcript reloaded (${s.messages} messages)`);
  check(
    s.charts >= 1 && s.titles[0] === firstTitle,
    `after a reload the card is rebuilt from the transcript: ${JSON.stringify(s)}`,
  );
  log(JSON.stringify(s));
} finally {
  await finish();
  if (process.env.PI_E2E_KEEP_HOME !== '1') rmSync(home, { recursive: true, force: true });
}
