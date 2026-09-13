/**
 * THE GAP BETWEEN THE STREAM AND THE INPUT BAR — measured while a long list
 * streams, and after it ends.
 *
 * the user (2026-09-12, with a screenshot of ~250pt of nothing between the last
 * streamed line and the composer): "reduce buffer space between stream and
 * input bar."
 *
 * Drives the real app against mock-pi (a 40-line list, one line every 120ms),
 * and reports, at the bottom of the thread: the distance from the last painted
 * content to the composer's top edge, and what is filling it.
 *
 *   FIXTURE=/tmp/stream-fixture.json OUT=/tmp/stream-gap node apps/desktop/tests/e2e/stream-gap-probe.mjs
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
const OUT = process.env.OUT ?? path.join(tmpdir(), 'stream-gap');
mkdirSync(OUT, { recursive: true });
const MAX_GAP = Number(process.env.MAX_GAP ?? 96);
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'stream-gap-udd-'))}`],
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_E2E_NO_SERVER: '1',
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: FIXTURE,
  },
});
/** The gap at the bottom: composer top − the lowest painted content edge. */
const measure = () => ({
  ...(() => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]');
    const composer = document.querySelector('.pd-composer');
    const thread = scroll?.querySelector('.pd-thread');
    if (!scroll || !thread) return { error: 'no thread' };
    const kids = [...thread.children].filter((k) => k.getAttribute('aria-hidden') !== 'true');
    let lowest = -Infinity;
    let lowestTag = '';
    const walk = (el) => {
      for (const n of el.querySelectorAll('*')) {
        const r = n.getBoundingClientRect();
        if (
          r.height > 0 &&
          r.width > 0 &&
          getComputedStyle(n).visibility !== 'hidden' &&
          n.textContent?.trim()
        ) {
          if (r.bottom > lowest) {
            lowest = r.bottom;
            lowestTag = `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]}`;
          }
        }
      }
    };
    for (const k of kids) walk(k);
    const sr = scroll.getBoundingClientRect();
    const cr = composer?.getBoundingClientRect();
    const spacer = thread.querySelector('[data-testid="thread-tail-space"]');
    const spacerH = spacer ? spacer.getBoundingClientRect().height : 0;
    const chain = [];
    let el = document.querySelector('.pd-composer');
    for (let i = 0; el && i < 6; i++) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      chain.push(
        `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} top=${Math.round(r.top)} h=${Math.round(r.height)} mt=${cs.marginTop} pt=${cs.paddingTop} pb=${cs.paddingBottom}`,
      );
      el = el.parentElement;
    }
    const tail = [...thread.children]
      .slice(-3)
      .map(
        (k) =>
          `${k.tagName.toLowerCase()}.${String(k.className).split(' ').slice(0, 2).join('.')} h=${Math.round(k.getBoundingClientRect().height)}`,
      );
    return {
      chain,
      tail,
      lowestContent: Math.round(lowest),
      lowestTag,
      scrollBottom: Math.round(sr.bottom),
      composerTop: cr ? Math.round(cr.top) : null,
      gapToScrollBottom: Math.round(sr.bottom - lowest),
      gapToComposer: cr ? Math.round(cr.top - lowest) : null,
      spacerH,
      atBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 4,
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
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
  const samples = [];
  const t0 = Date.now();
  let streaming = true;
  let midShot = false;
  while (streaming && Date.now() - t0 < 30000) {
    await win.waitForTimeout(400);
    const m = await win.evaluate(measure);
    const st = await win.evaluate(() => window.__pi_store().getState().agent.isStreaming);
    samples.push({ t: Date.now() - t0, ...m, streaming: st });
    if (!midShot && Date.now() - t0 > 2500) {
      midShot = true;
      writeFileSync(path.join(OUT, '01-mid-stream.png'), await win.screenshot());
      console.log('mid-stream:', JSON.stringify(m));
    }
    streaming = st;
  }
  await win.waitForTimeout(600);
  const end = await win.evaluate(measure);
  writeFileSync(path.join(OUT, '02-after-stream.png'), await win.screenshot());
  console.log('after stream:', JSON.stringify(end));
  // Only once the thread overflows the viewport is the space under the last
  // line padding rather than an unfilled viewport.
  const atBottom = samples.filter(
    (s) => s.atBottom && s.streaming && s.scrollHeight > s.clientHeight + 4,
  );
  const worst = atBottom.reduce((a, s) => Math.max(a, s.gapToComposer ?? s.gapToScrollBottom), 0);
  console.log(
    `samples=${samples.length} at-bottom-while-streaming=${atBottom.length} worst gap while streaming=${worst}px end gap=${end.gapToComposer ?? end.gapToScrollBottom}px (spacer ${end.spacerH}px)`,
  );
  check(atBottom.length > 0, 'the thread stayed at the bottom while streaming');
  check(worst <= MAX_GAP, `gap while streaming ≤ ${MAX_GAP}px (worst ${worst}px)`);
  check(
    (end.gapToComposer ?? end.gapToScrollBottom) <= MAX_GAP,
    `gap after the stream ≤ ${MAX_GAP}px (${end.gapToComposer ?? end.gapToScrollBottom}px)`,
  );
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'stream-gap-probe OK' : `FAILED: ${failures.length}`);
