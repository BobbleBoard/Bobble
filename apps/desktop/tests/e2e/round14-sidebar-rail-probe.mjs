/**
 * Round-14 E2E (#7): the collapsed left rail no longer "grows + snaps right".
 *
 * The objectively-testable half of the anti-jank fix (the motion itself is
 * owner-validated FEEL): a collapsed RAIL glyph renders at the SAME size as its
 * expanded ROW glyph — both are 16px SVGs riding in an --pd-icon-size centering
 * box — so nothing resizes on collapse. We assert:
 *
 *   1. Every `.pd-rail-btn` wraps its glyph in a `.pd-rail-btn-icon` box (the
 *      keystone contract that makes glyph-x identical by construction).
 *   2. A rail icon's SVG `width`/`height` equal the expanded row icon's (16),
 *      i.e. the collapse no longer changes icon size (was 18 in the rail).
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('round14-sidebar-rail-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round14-sidebar-rail-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

/** The `width` attr of the first SVG under a selector, or null if absent. */
const iconSize = (page, selector) =>
  page.evaluate((sel) => {
    const svg = document.querySelector(`${sel} svg`);
    return svg ? svg.getAttribute('width') : null;
  }, selector);

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Expanded: the "New chat" ROW icon size (a SidebarRow → .pd-sidebar-row-icon).
  await page.waitForSelector('[data-testid="new-chat"] svg', { timeout: 8000 });
  const expandedSize = await iconSize(page, '[data-testid="new-chat"]');
  assert(expandedSize === '16', `expanded row icon should be 16px, got ${expandedSize}`);

  /*
   * THE COLLAPSED RAIL IS GONE, AND THAT IS THE POINT.
   *
   * Everything below this line used to measure `.pd-sidebar[data-open="false"]`
   * — a collapsed rail card with its own buttons — and that UI was removed
   * deliberately. `data-open` now stays TRUE for as long as the panel is
   * mounted (the SLOT owns open/closed), the panel LEAVES the tree once the
   * slide finishes, and the collapse toggle moved out into the shell beside the
   * traffic lights precisely so it survives the sidebar unmounting.
   *
   * So the probe asserts what replaced it, which is three real claims:
   *   1. closing keeps the panel in the tree while it slides (the user: "instant
   *      disappear and then slide left rather than the correct slide in");
   *   2. once the slide is over the panel is GONE, so a closed sidebar keeps
   *      no buttons in the tab order;
   *   3. the toggle is still there to open it again.
   */
  const slotWidth = () =>
    page.evaluate(() => {
      const el = document.querySelector('.pd-sidebar-slot');
      return el === null ? -1 : Math.round(el.getBoundingClientRect().width);
    });
  const panelPresent = () => page.evaluate(() => document.querySelector('.pd-sidebar') !== null);

  assert((await slotWidth()) > 100, 'the sidebar should start open');
  await page.click('[data-testid="collapse-sidebar"]');

  // 1. Mid-slide: the slot is narrowing and the panel is still there.
  let sawPanelWhileNarrowing = false;
  for (let i = 0; i < 40; i++) {
    const w = await slotWidth();
    if (w < 100 && w > 2 && (await panelPresent())) sawPanelWhileNarrowing = true;
    if (w <= 2) break;
    await page.waitForTimeout(15);
  }
  assert(
    sawPanelWhileNarrowing,
    'the panel left the DOM before the slide finished — the "instant disappear" bug',
  );

  // 2. Settled: the slot is closed and the panel is out of the tree.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.pd-sidebar-slot');
      return el !== null && el.getBoundingClientRect().width <= 2;
    },
    { timeout: 8000 },
  );
  await page.waitForTimeout(400);
  assert(!(await panelPresent()), 'a closed sidebar left its panel (and its tab stops) mounted');

  // 3. …and the toggle survived the panel it lives outside of.
  await page.waitForSelector('[data-testid="expand-sidebar"]', { timeout: 8000 });
  await page.click('[data-testid="expand-sidebar"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.pd-sidebar-slot');
      return el !== null && el.getBoundingClientRect().width > 100;
    },
    { timeout: 8000 },
  );
  assert(await panelPresent(), 'reopening did not bring the sidebar back');

  console.log(
    'round14-sidebar-rail-probe OK — 16px row icons; the panel stays mounted through the slide, ' +
      'leaves the tree once it is closed, and the shell toggle reopens it',
  );
} finally {
  await app.close().catch(() => {});
}
