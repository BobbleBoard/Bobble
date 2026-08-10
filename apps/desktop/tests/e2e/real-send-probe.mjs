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
const app = await electron.launch(
  packaged !== undefined
    ? { executablePath: `${packaged}/Contents/MacOS/Bobble` }
    : { executablePath: require('electron'), args: [appRoot] },
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

  // The server does not auto-wire under Playwright, so start it — but nothing
  // else. No pi:restart, no pi:set-model: that sequence is what send-diag did.
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForTimeout(20_000);
  await win.screenshot({ path: `${OUT}-01-loaded.png` }).catch(() => {});
  console.log('server started, model settling');

  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type('In one short sentence, what is a climbing hold?');
  const sentAt = Date.now();
  await win.keyboard.press('Enter');

  let firstAt = null;
  let text = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    text = await assistantText(win);
    if (text.length > 0) {
      firstAt = Date.now() - sentAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
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
