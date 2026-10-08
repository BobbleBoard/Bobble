/**
 * THE ADDRESS BAR SEARCHES. the user (2026-10-08): "searching in the search bar
 * should google something not show https://<typed thing>".
 *
 * Opens a canvas browser tab, types words, presses Enter, and reads where the
 * tab went (the bar's own value once the page loaded): a Google search for the
 * words, not https://<words>. Then an address ("example.com") still opens as a
 * page. Needs the network.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/browser-search-probe.mjs
 */
import { launchApp } from './harness.mjs';

const { page, check, shot, finish } = await launchApp('browser-search', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const barValue = () =>
  page.evaluate(
    () => document.querySelector('[data-testid="canvas-tabs-panel"] .pd-browser-url')?.value ?? '',
  );
async function go(text) {
  const bar = page.locator('[data-testid="canvas-tabs-panel"] .pd-browser-url');
  await bar.fill(text);
  await bar.press('Enter');
  const end = Date.now() + 20_000;
  let v = '';
  while (Date.now() < end) {
    await sleep(500);
    v = await barValue();
    if (v.startsWith('http') && v !== text) break;
  }
  return v;
}
try {
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'browser', title: 'New tab' }));
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-browser-url', { timeout: 8000 });
  await sleep(800);

  const searched = await go('best pizza near me');
  console.log('words →', searched);
  check(
    /^https:\/\/www\.google\.[a-z.]+\/search\?.*q=best(\+|%20)pizza(\+|%20)near(\+|%20)me/.test(searched),
    `words search Google (${searched})`,
  );
  check(!searched.startsWith('https://best'), 'never https://<words>');
  await sleep(1500);
  await shot('1-search');

  const opened = await go('example.com');
  console.log('address →', opened);
  check(/^https:\/\/example\.com\/?$/.test(opened), `an address opens as a page (${opened})`);
  await shot('2-address');
} finally {
  await finish();
}
