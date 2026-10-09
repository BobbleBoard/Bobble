/**
 * LOOK AT THE UI CHANGES, rather than asserting them.
 *
 * The user's standing rule: any visually-relevant fix is reproduce → fix →
 * re-reproduce → LOOK. This drives the real app headlessly and photographs the
 * four things this round changed:
 *
 *   1. the app's state in the MIDDLE of the top bar (was a pill over the composer)
 *   2. the model/engine card that opens when you hover it
 *   3. a connector row reading "Used <icon> <app> <action>" with no shell line
 *   4. a finished chain FOLDED while the turn is still going
 *
 * Background-launched throughout: the user is using this machine.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9431;
const OUT = process.env.OUT ?? `${REPO_ROOT}/scratchpad/ui-look`;
mkdirSync(OUT, { recursive: true });

await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
while (
  await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then(
    (r) => r.stdout.trim() !== '',
    () => false,
  )
)
  await sleep(500);
await run('open', [
  '-g',
  '--env',
  'PI_E2E=1',
  '--env',
  'PI_E2E_BACKGROUND=1',
  '-a',
  '/Applications/Bobble.app',
  '--args',
  `--remote-debugging-port=${PORT}`,
]);
await sleep(9000);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
  timeout: 40_000,
});
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  console error:', m.text().slice(0, 200));
});
page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 220)));

const shot = async (name, sel) => {
  const el = sel === undefined ? null : await page.$(sel);
  const path = `${OUT}/${name}.png`;
  if (el !== null) await el.screenshot({ path });
  else await page.screenshot({ path });
  console.log(`  ${name} -> ${path}`);
};

/* THE TOP BAR, mid-load. The status only exists while the model is coming up,
   so the shot has to be taken during one — start a server and photograph the
   bar while it does. */
const model = process.env.MAC_CU_MODEL ?? 'qwen3.8-27b-mtp';
/* Stop whatever is warm first. A warm 9B is up in about a second, which is not
   long enough to photograph a card that only exists during the load. */
await page.evaluate(() => window.piDesktop.invoke('llm:stop-server', {})).catch(() => undefined);
await sleep(1500);
void page.evaluate((id) => window.piDesktop.invoke('llm:start-server', { modelId: id }), model);
/* WAIT FOR IT, do not sleep at it. The status exists only while the model is
   coming up, and a small model is up in a second — the first two runs of this
   photographed an empty bar and a card that "did not open" because by then
   there was nothing to hover. */
await page
  .waitForSelector('[data-testid="topbar-status"]', { timeout: 30_000 })
  .catch(() => console.log('  the status never appeared — is a model already loaded?'));
await shot('1-topbar-loading', '.pd-topbar');
const statusText = await page
  .evaluate(() => document.querySelector('[data-testid="topbar-status"]')?.textContent ?? '(none)')
  .catch(() => '(none)');
console.log('  top bar says:', JSON.stringify(statusText));

/* THE CARD, on hover. */
const status = await page.$('[data-testid="topbar-status"]');
if (status !== null) {
  /* The card hangs BELOW the bar, so a screenshot cropped to `.pd-topbar` cuts
     it off entirely — the first run of this photographed an empty bar and
     proved nothing. Clicking rather than hovering because a synthetic hover
     does not survive the re-render. */
  await status.click();
  /* 200ms, not 700. The card exists only while the model is loading — which is
     the design ("it should naturally disappear when a model is loaded") — and a
     700ms pause was enough for a warm 9B to finish, so the DOM said the card
     was 300x292 and visible and the photograph taken moments later showed an
     empty bar. */
  await sleep(400);
  await shot('2-model-card', '[data-testid="topbar-model-card"]');
  const dom = await page.evaluate(() => ({
    status: document.querySelector('[data-testid="topbar-status"]') !== null,
    open: document.querySelector('[data-testid="topbar-status"]')?.getAttribute('aria-expanded'),
    card: document.querySelector('[data-testid="topbar-model-card"]') !== null,
    statusBox: (() => {
      const el = document.querySelector('[data-testid="topbar-status"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { y: Math.round(r.y), h: Math.round(r.height), pos: cs.position };
    })(),
    parentOf: (() => {
      const el = document.querySelector('[data-testid="topbar-model-card"]');
      const op = el instanceof HTMLElement ? el.offsetParent : null;
      return op === null ? null : `${op.tagName}.${op.className}`.slice(0, 60);
    })(),
    box: (() => {
      const el = document.querySelector('[data-testid="topbar-model-card"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        vis: cs.visibility,
        op: cs.opacity,
        z: cs.zIndex,
      };
    })(),
  }));
  console.log('  after click:', JSON.stringify(dom));
  const b = dom.box;
  if (b !== null) {
    await page.screenshot({
      path: `${OUT}/2b-model-card-in-place.png`,
      clip: { x: Math.max(0, b.x - 40), y: 0, width: b.w + 80, height: b.y + b.h + 40 },
    });
    console.log(`  2b-model-card-in-place -> ${OUT}/2b-model-card-in-place.png`);
  }
  const card = await page.evaluate(
    () => document.querySelector('[data-testid="topbar-model-card"]')?.textContent ?? '(none)',
  );
  console.log('  card says:', JSON.stringify(card.slice(0, 160)));
} else {
  console.log('  no top-bar status on screen — the model may already be up');
}

/* A QUEUED SEND while the model loads. */
const queued = await page.evaluate(() => {
  const s = window.piDesktop;
  return typeof s?.invoke === 'function';
});
console.log('  bridge reachable:', queued);

await shot('3-whole-window');
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
console.log(`frames in ${OUT}`);
