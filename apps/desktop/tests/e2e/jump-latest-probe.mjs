/**
 * b3: the way back down.
 *
 * Releasing the autoscroll stick is deliberately easy — one upward wheel tick —
 * and there was no way to re-arm it except scrolling to the bottom by hand, so
 * anyone who glanced up during a long generation had to chase the stream down.
 *
 * Drives the real app: fills the thread, scrolls up, asserts the control
 * appears, clicks it, and asserts it lands at the bottom and goes away.
 */
import { mkdtempSync } from 'node:fs';
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`jump-latest-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-jump-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

// Enough turns that the thread overflows.
for (let i = 0; i < 6; i++) {
  await page.click('.pd-composer-editor');
  await page.keyboard.type(`message ${i} — something long enough to fill the thread out`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
}
await page.waitForTimeout(1200);

const metrics = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el === null) return null;
    return {
      distanceFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      scrollable: el.scrollHeight > el.clientHeight + 200,
    };
  });

const scrollTo = (top) =>
  page.evaluate((y) => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el === null) return;
    el.scrollTop = y === 'bottom' ? el.scrollHeight : y;
    el.dispatchEvent(new Event('scroll'));
  }, top);

const before = await metrics();
console.log('[jump] at rest:', JSON.stringify(before));
if (before === null || !before.scrollable) {
  fail('the thread never overflowed — nothing to test');
} else {
  /* Park at the bottom explicitly. Sending does NOT reliably leave you there —
     measured 635 px above it after six turns, because the last content grows
     after the render that would have re-pinned. That gap is the reason this
     control exists; it is not what this probe is asserting. */
  await scrollTo('bottom');
  await page.waitForTimeout(300);
  if ((await page.$('[data-testid="chat-jump-latest"]')) !== null) {
    fail('the control is showing while parked at the bottom');
  } else {
    console.log('[jump] OK: hidden at the bottom');
  }

  await scrollTo(0);
  await page.waitForTimeout(400);

  try {
    await page.waitForSelector('[data-testid="chat-jump-latest"]', { timeout: 3000 });
    console.log('[jump] OK: appears when scrolled up');
  } catch {
    fail('the control did not appear after scrolling up');
  }

  await page.click('[data-testid="chat-jump-latest"]');
  /*
   * WAIT FOR THE SCROLL TO ARRIVE, not for 900ms.
   *
   * The jump is a SMOOTH scroll, and a probe's window is never shown, so its
   * renderer runs off a timer at roughly 12fps instead of the display's vsync
   * (MEASURED — see background-mode.ts). A smooth scroll animated at 12fps takes
   * longer than a fixed 900ms, so this read the thread mid-flight and reported
   * "clicking it left 171px of content below" — a real number describing a
   * scroll that had not finished rather than one that had stopped short.
   */
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chat-scroll"]');
        if (el === null) return false;
        return el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
      },
      null,
      { timeout: 8000 },
    )
    .catch(() => undefined);
  // Then let the control's own exit transition run before asking if it is gone.
  await page.waitForTimeout(400);
  const after = await metrics();
  if (after === null || after.distanceFromBottom > 24) {
    fail(`clicking it left ${after?.distanceFromBottom}px of content below`);
  } else {
    console.log('[jump] OK: lands at the bottom');
  }
  if ((await page.$('[data-testid="chat-jump-latest"]')) !== null) {
    fail('the control is still showing after arriving at the bottom');
  } else {
    console.log('[jump] OK: hides again once there');
  }
}

await app.close();
if (process.exitCode !== 1) console.log('jump-latest-probe OK');
