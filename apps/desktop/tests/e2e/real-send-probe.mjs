/**
 * DOES A REAL USER GET A REAL ANSWER? — the app driven the way the user drives it.
 *
 * send-diag found every assistant message coming back EMPTY, but it drove the
 * app through `pi:restart` + `pi:set-model` right after a warm-up, which no user
 * does. This deliberately avoids that: no PI_E2E, no restart, no store hooks —
 * it types into the composer, presses Enter, and READS THE RENDERED DOM, because
 * what the user sees is the only thing that settles the question.
 *
 *   node tests/e2e/real-send-probe.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? '/tmp/real-send';

/*
 * NOTE: no PI_E2E. The store hooks are gone with it, which is the point — this
 * reads what is on screen.
 *
 * APP=/Applications/Bobble.app drives the SHIPPED bundle instead of the dev
 * tree, which is the only way to check that what was installed actually answers
 * — the packaged smoke's model leg runs in an isolated profile whose registry
 * has no models in it.
 */
const packaged = process.env.APP;
/* OBSERVE=1 threads PI_E2E purely to expose `window.__pi_store`, so the warm
 * status can be READ. Audited: PI_E2E only affects window bounds, that store
 * opt-in, onboarding seeding and a mac debug channel — nothing that touches a
 * response — so the timing stays comparable. */
const observe = process.env.OBSERVE === '1' ? { PI_E2E: '1' } : {};
const app = await electron.launch(
  packaged !== undefined
    ? { executablePath: `${packaged}/Contents/MacOS/Bobble`, env: { ...process.env, ...observe } }
    : { executablePath: require('electron'), args: [appRoot], env: { ...process.env, ...observe } },
);

const assistantText = (win) =>
  win.evaluate(() => {
    const rows = [...document.querySelectorAll('.pd-msg--assistant')];
    return rows.map((r) => (r.textContent ?? '').trim()).filter((t) => t.length > 0);
  });

try {
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  console.log('app up');

  /*
   * THE REAL USER PATH. The server does not auto-wire under Playwright, so start
   * it and SELECT the model — selecting is what a user does in the picker, and
   * it is what fires the system-prompt warm-up. Crucially NO `pi:restart`: that
   * is the one step send-diag added, and it is the step that produces empty
   * replies (#47).
   *
   * Then WAIT FOR WARM rather than sleeping a guessed number of seconds, so the
   * measurement below starts from the moment the app claims it is ready — which
   * is exactly the promise "Loading model" makes.
   */
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  if (process.env.SELECT_MODEL === '1') {
    await win.evaluate(async (modelId) => {
      await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
    }, MODEL);
  }
  const warmStart = Date.now();
  await win
    .waitForFunction(
      () => document.querySelector('[data-testid="composer-model-loading"]') === null,
      undefined,
      { timeout: 180_000 },
    )
    .catch(() => {});
  console.log(`  "Loading model" gone after ${((Date.now() - warmStart) / 1000).toFixed(1)}s`);
  const warmState = await win
    .evaluate(() => {
      const st = window.__pi_store?.().getState?.();
      return st === undefined
        ? 'store not exposed (set OBSERVE=1)'
        : (st.extensionStatus?.['harness-prefix-warm'] ?? 'NEVER PUBLISHED');
    })
    .catch(() => 'unreadable');
  console.log(`  prefix warm: ${warmState}`);
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${OUT}-01-loaded.png` }).catch(() => {});
  console.log('server started, model settling');

  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type('In one short sentence, what is a climbing hold?');
  const sentAt = Date.now();
  await win.keyboard.press('Enter');

  /*
   * SPLIT THE NUMBER. "7 seconds to an answer" is three different bugs wearing
   * one coat: the send not dispatching, a long prompt prefill, or the model
   * thinking. Timing the ROW appearing separately from its first CHARACTER
   * separates dispatch+prefill from generation, which is the only way to know
   * what to fix.
   */
  let rowAt = null;
  let firstAt = null;
  let text = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (rowAt === null) {
      const rows = await win.evaluate(() => document.querySelectorAll('.pd-msg--assistant').length);
      if (rows > 0) rowAt = Date.now() - sentAt;
    }
    text = await assistantText(win);
    if (text.length > 0) {
      firstAt = Date.now() - sentAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`assistant row appeared: ${rowAt === null ? 'NEVER' : `${rowAt}ms`}`);
  // Let it finish so the screenshot shows a real answer, not one word.
  await win.waitForTimeout(8000);
  text = await assistantText(win);
  await win.screenshot({ path: `${OUT}-02-answer.png` }).catch(() => {});

  console.log(`\nfirst visible text: ${firstAt === null ? 'NEVER' : `${firstAt}ms`}`);
  console.log(`assistant rows with text: ${text.length}`);
  for (const t of text.slice(0, 3)) console.log(`  → ${JSON.stringify(t.slice(0, 160))}`);
  console.log(`screenshots -> ${OUT}-0{1,2}.png`);
  process.exitCode = firstAt !== null && text.length > 0 ? 0 : 1;
} finally {
  await app.close();
}
