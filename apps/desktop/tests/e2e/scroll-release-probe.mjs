/**
 * A HAIR OF SCROLL-UP FREES YOU FROM AUTO-SCROLL; TOUCHING THE BOTTOM RE-ARMS IT.
 *
 * the user (2026-09-12): "when attempting to scroll up, if the model is writing a
 * bulleted list quickly … the auto scroll constantly snaps you back down … the
 * slightest bit of user scrolling up manually, I need to be freed from the
 * auto scroll … if they tap the bottom at all, then activate the auto scroll,
 * but if they ever go up, even the tiniest bit (manually) the auto scroll
 * doesn't snap you down."
 *
 * mock-pi streams a 40-line list, one line every 120ms. Mid-stream: one small
 * wheel tick up (−12px), then 1.5s of streaming — the view must stay where it
 * was (its distance from the bottom GROWS as lines arrive). Then a wheel down
 * to the bottom — the view must follow the next lines again.
 *
 *   LINES=80 node apps/desktop/tests/e2e/fixtures/make-stream-fixture.mjs > /tmp/stream-fixture.json
 *   FIXTURE=/tmp/stream-fixture.json node apps/desktop/tests/e2e/scroll-release-probe.mjs
 *
 * (80 lines, not 40: the checks assert they ran MID-stream, and a 40-line
 * stream at 120ms is over before the last of them on a fast machine.)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const FIXTURE = process.env.FIXTURE ?? '/tmp/stream-fixture.json';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'scroll-release');
mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'scroll-release-udd-'))}`],
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_E2E_NO_SERVER: '1',
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: FIXTURE,
  },
});
const pos = () => ({
  ...(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    return {
      gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      top: Math.round(el.scrollTop),
      height: el.scrollHeight,
      streaming: window.__pi_store().getState().agent.isStreaming,
    };
  })(),
});
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForTimeout(1500);
  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type('list the towns', { delay: 2 });
  await win.keyboard.press('Enter');
  // Wait until the thread overflows and is following.
  await win.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="chat-scroll"]');
      return (
        el.scrollHeight > el.clientHeight + 200 &&
        el.scrollHeight - el.scrollTop - el.clientHeight < 4
      );
    },
    undefined,
    { timeout: 30000 },
  );
  const before = await win.evaluate(pos);
  log('following:', JSON.stringify(before));
  check(before.streaming, 'still streaming when the test starts');

  // ONE small wheel tick up, over the thread.
  const box = await win.locator('[data-testid="chat-scroll"]').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.wheel(0, -12);
  for (const ms of [50, 150, 300, 600]) {
    await win.waitForTimeout(ms === 50 ? 50 : ms - (ms === 150 ? 50 : ms === 300 ? 150 : 300));
    log(`  +${ms}ms:`, JSON.stringify(await win.evaluate(pos)));
  }
  const released = await win.evaluate(pos);
  log('after a 12px scroll-up:', JSON.stringify(released));
  check(released.gap >= 8, `the view moved up (gap ${released.gap}px)`);
  await win.waitForTimeout(1500);
  const later = await win.evaluate(pos);
  log('1.5s of streaming later:', JSON.stringify(later));
  check(later.streaming, 'still streaming (the check is mid-stream)');
  check(
    later.top === released.top,
    `the view stayed put (scrollTop ${released.top} → ${later.top})`,
  );
  check(
    later.gap > released.gap + 40,
    `the gap grew with the stream (${released.gap} → ${later.gap}px) — no snap-back`,
  );
  writeFileSync(path.join(OUT, '01-released-mid-stream.png'), await win.screenshot());

  // Back down to the bottom by wheel → follows again.
  await win.mouse.wheel(0, 4000);
  await win.waitForTimeout(250);
  const back = await win.evaluate(pos);
  log('after wheeling to the bottom:', JSON.stringify(back));
  check(back.gap <= 2, `at the bottom (gap ${back.gap})`);
  await win.waitForTimeout(1000);
  const following = await win.evaluate(pos);
  log('1s later:', JSON.stringify(following));
  check(following.height > back.height, 'more lines arrived meanwhile');
  check(following.gap <= 2, `…and the view followed them (gap ${following.gap})`);

  // And the keyboard: ArrowUp releases too.
  await win.locator('[data-testid="chat-scroll"]').focus();
  await win.keyboard.press('ArrowUp');
  await win.waitForTimeout(600);
  const keyed = await win.evaluate(pos);
  log('after ArrowUp:', JSON.stringify(keyed));
  if (keyed.streaming) check(keyed.gap > 2, `ArrowUp released the follow (gap ${keyed.gap})`);
  else log('stream ended before the ArrowUp check — skipped');
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'scroll-release-probe OK' : `FAILED: ${failures.length}`);
