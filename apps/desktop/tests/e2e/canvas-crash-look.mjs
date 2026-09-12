/**
 * THE CANVAS FAILS; THE WINDOW STAYS — and LOOK at it.
 *
 * the user: "renderer crash is what needs fixing immediately and most, that cannot
 * happen". The assessment saw the whole window vanish behind the app-level
 * boundary twice, mid-turn, from a loop inside the canvas rail.
 *
 * This drives a REAL render failure into the built app — a model tab whose
 * `mediaType` is not a string, which the surface calls `.toUpperCase()` on;
 * the shape a corrupted snapshot or a bad route hands over — and asserts what
 * the person sees:
 *
 *   1. first failure  → the canvas resets itself, the rail comes back empty,
 *                        the chat and composer never moved;
 *   2. failure again  → a small card in the rail with a Reset button, the rest
 *                        of the window untouched;
 *   3. Reset          → the rail is back, empty, usable (a tab opens in it).
 *
 * Screenshots land in $TMPDIR/pd-shots/canvas-crash-look/.
 *
 *   node tests/e2e/canvas-crash-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('canvas-crash-look');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message ?? e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
await page.waitForTimeout(600);

const openBroken = () =>
  page.evaluate(() => {
    // A real file tab beside it, so the reset visibly drops something.
    const ctl = window.__pi_canvas();
    ctl.openTab({
      kind: 'file',
      title: 'notes.md',
      artifact: { filename: 'notes.md', content: { kind: 'text', text: '# notes\n\nkept until reset' } },
    });
    ctl.openTab({ kind: 'model', title: 'broken.glb', mediaType: 5 });
    return ctl.getState().tabs.length;
  });

const windowIntact = async (label) => {
  const state = await page.evaluate(() => ({
    appBoundary: document.body.innerText.includes('rendering error'),
    composer: document.querySelector('.pd-composer-editor') !== null,
    sidebar: document.querySelector('[data-testid="sidebar"], .pd-sidebar, nav') !== null,
    card: document.querySelector('[data-testid="canvas-crash"]') !== null,
    tabs: window.__pi_canvas().getState().tabs.map((t) => t.kind),
  }));
  check(!state.appBoundary, `${label}: the APP boundary took the window`);
  check(state.composer, `${label}: the composer is gone`);
  return state;
};

// 1. First failure: an automatic reset, the rail back and empty.
const opened = await openBroken();
check(opened === 2, `expected two tabs before the failure, got ${opened}`);
await page.waitForTimeout(800);
const first = await windowIntact('after the first failure');
check(!first.card, 'the first failure should have reset silently, not shown the card');
check(first.tabs.length === 0, `the reset should have emptied the rail, tabs=${first.tabs.join(',')}`);
await shot('1-after-auto-reset');

// 2. Failure again inside the window: the card, the window intact.
await openBroken();
await page.waitForTimeout(800);
const second = await windowIntact('after the second failure');
check(second.card, 'the second failure inside 10s should show the reset card');
await shot('2-reset-card');

// 3. Reset by hand: rail back, usable.
const btn = await page.$('[data-testid="canvas-crash-reset"]');
check(btn !== null, 'no Reset button on the card');
await btn?.click();
await page.waitForTimeout(600);
const third = await windowIntact('after Reset');
check(!third.card, 'the card should be gone after Reset');
const reopened = await page.evaluate(() => {
  const ctl = window.__pi_canvas();
  ctl.openTab({
    kind: 'file',
    title: 'after-reset.md',
    artifact: { filename: 'after-reset.md', content: { kind: 'text', text: 'the canvas works again' } },
  });
  return ctl.getState().tabs.length;
});
check(reopened === 1, `a tab should open after Reset, tabs=${reopened}`);
await page.waitForTimeout(500);
check(
  await page.evaluate(() => document.body.innerText.includes('the canvas works again')),
  'the reopened tab did not draw',
);
await shot('3-after-reset-usable');

const stacks = errors.filter((e) => e.includes('Bobble canvas error'));
check(stacks.length >= 2, `expected the canvas boundary to log both failures, saw ${stacks.length}`);
check(
  errors.every((e) => !/Bobble hit a rendering error|AppErrorBoundary/.test(e)),
  'the app-level boundary logged — the failure escaped the rail',
);
console.log(JSON.stringify({ errors: errors.length, canvasLogs: stacks.length, first, second, third }));
await finish();
