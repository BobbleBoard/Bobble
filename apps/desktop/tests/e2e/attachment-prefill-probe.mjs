/**
 * IS THE ATTACHMENT PREFILL ACTUALLY FIRING?
 *
 * The machinery is documented as measured (~3747ms → ~290ms on a ~5k-token
 * paste), but three separate features tonight turned out to exist and never run
 * — the warm-up could not start, timed out, and warmed the wrong prefix — so
 * this assumes nothing and measures an A/B the implementation cannot fake:
 * the SAME paste and the SAME question, sent once after an idle (the prefill has
 * time to prime) and once immediately (it does not).
 *
 *   IDLE_MS=12000 → 400ms
 *   IDLE_MS=0     → 4807ms
 *
 * 12x on the identical input, and the slow case matches a ~5k-token cold prefill
 * measured directly against llama-server (5416 tokens = 4.0s). That is the proof.
 *
 * The `pi:prefill` IPC spy below reports ZERO even when the feature demonstrably
 * works, because it is never installed: contextBridge hands the page a FROZEN
 * bridge, so the assignment to `window.piDesktop.invoke` is silently dropped
 * (measured 2026-09-25). It is kept only as a hint and asserted on by NOTHING; a
 * probe that must hear an IPC call listens in main, as harness.mjs `refuseIpc`
 * does (it records the call there, and refuses it).
 *
 *   node tests/e2e/attachment-prefill-probe.mjs          # dev tree
 *   APP=/Applications/Bobble.app node …                  # the shipped bundle
 *   PASTE_CHARS=20000 node …                             # size of the paste
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PASTE_CHARS = Number(process.env.PASTE_CHARS ?? 20000);
const OUT = process.env.OUT ?? '/tmp/attach-prefill';

const packaged = process.env.APP;
const app = await electron.launch(
  packaged !== undefined
    ? { executablePath: `${packaged}/Contents/MacOS/Bobble` }
    : { executablePath: require('electron'), args: [appRoot] },
);

const assistantRows = (win) =>
  win.evaluate(() => document.querySelectorAll('.pd-msg--assistant').length);

try {
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });

  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('llm:start-server', { modelId });
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);

  // Wait for the app's own readiness promise — the warm-up holds this label now.
  await win
    .waitForFunction(
      () => document.querySelector('[data-testid="composer-model-loading"]') === null,
      undefined,
      { timeout: 300_000 },
    )
    .catch(() => {});
  await win.waitForTimeout(2000);
  console.log('model warm');

  /*
   * SPY ON THE IPC — or try to. Hearing a call that is supposed to happen and
   * silently doesn't beats reading the source, which would have "proved" the
   * warm-up worked too. But this page-side wrapper never takes (the bridge is
   * frozen; see the header), so it stays a hint. Hearing a call takes main —
   * see `refuseIpc` in harness.mjs.
   */
  await win.evaluate(() => {
    window.__prefillCalls = [];
    const real = window.piDesktop.invoke.bind(window.piDesktop);
    window.piDesktop.invoke = (channel, payload) => {
      if (channel === 'pi:prefill') {
        window.__prefillCalls.push({ at: Date.now(), chars: JSON.stringify(payload ?? {}).length });
      }
      return real(channel, payload);
    };
  });

  // A big paste — the fixed start of the next user message.
  const filler =
    `Reference notes.\n${'The wall is twelve metres wide with a slight overhang. '.repeat(
      Math.ceil(PASTE_CHARS / 55),
    )}`.slice(0, PASTE_CHARS);
  await win.click('[data-testid="composer-input"]');
  await win.evaluate((text) => {
    const el = document.querySelector('[data-testid="composer-input"]');
    if (el === null) throw new Error('no composer');
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, filler);
  console.log(`pasted ${filler.length} chars`);

  /*
   * IDLE_MS=0 sends IMMEDIATELY, before the prefill can have primed anything.
   * That contrast is the real proof: the IPC spy below is blind (the page's
   * bridge is frozen, so the wrapper never takes), but the SEND LATENCY cannot
   * lie — a ~5k-token attachment costs ~4s cold, measured.
   */
  const idleMs = Number(process.env.IDLE_MS ?? 12_000);
  await win.waitForTimeout(idleMs);
  const calls = await win.evaluate(() => window.__prefillCalls ?? []);
  console.log(`pi:prefill invoked: ${calls.length} time(s)`);
  await win.screenshot({ path: `${OUT}-01-pasted.png` }).catch(() => {});

  const before = await assistantRows(win);
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(' In one sentence, how wide is the wall?');
  const sentAt = Date.now();
  await win.keyboard.press('Enter');

  let ttft = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if ((await assistantRows(win)) > before) {
      ttft = Date.now() - sentAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await win.waitForTimeout(6000);
  await win.screenshot({ path: `${OUT}-02-answer.png` }).catch(() => {});

  console.log(`\nprefill calls : ${calls.length}`);
  console.log(`send TTFT     : ${ttft === null ? 'NEVER' : `${ttft}ms`}`);
  console.log(`screenshots   -> ${OUT}-0{1,2}.png`);
  /*
   * Judged on LATENCY alone, and only in the idle case — see the header for why
   * the spy is not evidence. With IDLE_MS=0 a slow send is the expected result,
   * so it is reported rather than failed.
   */
  const primed = idleMs > 0;
  process.exitCode = !primed || (ttft !== null && ttft < 2000) ? 0 : 1;
  if (primed) console.log(ttft !== null && ttft < 2000 ? 'PASS — primed' : 'FAIL — not primed');
} finally {
  await app.close();
}
