/**
 * present-card-probe.mjs — LOOK at the presentation card.
 *
 * The user, twice: "are you taking screenshots?" and then a screenshot of the card
 * showing four bugs I had not seen because I verified by tests. This drives the
 * real card so each claim about it can be backed by a picture:
 *
 *   1. the split button's primary segment, and the card body, are DIFFERENT verbs
 *   2. "Show" carries a folder icon and a border by default
 *   3. the default app's icon (generic when the OS default is unidentifiable)
 *   4. the dropdown surface matches every other menu
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'present-card');
const FILE = process.env.FILE ?? `${homedir()}/bobble-testbed/chartdemo/chart.html`;
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-present-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3500);

/* The cards live INSIDE the thread, and an empty chat renders the "What are we
 * building?" empty state instead — so the first attempt seeded the store and saw
 * nothing. Give the thread a turn to exist in first. */
await win.evaluate(() => {
  const pi = window.__pi_store?.();
  if (pi === undefined) return;
  pi.getState().appendUser('Make me a bar chart of quarterly revenue.');
  pi.getState().appendAssistantText('Here it is.');
});
await win.waitForTimeout(800);

// Put a real artefact on the card through the store the app itself writes to.
const added = await win.evaluate((file) => {
  const store = window.__present_store?.();
  if (store === undefined) return 'no store hook';
  store.getState().add({ path: file, note: 'A bar chart of quarterly revenue' });
  return 'added';
}, FILE);
console.log('seed:', added);
await win.waitForTimeout(2500);

/*
 * `window.piDesktop` is a frozen contextBridge object — `invoke` cannot be
 * redefined, which is why canvasShellInvoke carries its own E2E seam. So the
 * two clicks are told apart by their OBSERVABLE effect instead: the body must
 * put a tab on the canvas, and the Open button must not (it hands the file to
 * an application, which a probe should never actually launch).
 */
const card = win.locator('.pd-present-card').first();
if ((await card.count()) === 0) {
  console.log('NO CARD RENDERED');
  await win.screenshot({ path: path.join(OUT, 'no-card.png') });
  await app.close();
  process.exit(0);
}

const shot = async (name) => {
  const b = await card.boundingBox();
  await win.screenshot({
    path: path.join(OUT, `${name}.png`),
    ...(b !== null
      ? {
          clip: {
            x: Math.max(0, b.x - 12),
            y: Math.max(0, b.y - 12),
            width: b.width + 24,
            height: b.height + 260,
          },
        }
      : {}),
  });
};
await shot('01-card');

// The dropdown, so its surface can be compared with every other menu.
// Click the BODY — it must bring the artefact into the canvas.
const tabsBefore = await win.locator('.pd-canvas-tab').count();
await win.locator('.pd-present-main').first().click();
await win.waitForTimeout(1500);
const tabsAfter = await win.locator('.pd-canvas-tab').count();
console.log(`card BODY  → canvas tabs ${tabsBefore} -> ${tabsAfter}`);
console.log(
  tabsAfter > tabsBefore
    ? '  PASS: the body opens it in the canvas'
    : '  FAIL: the body did not open a canvas tab',
);
await shot('04-after-body-click');

const caret = win.locator('.pd-split-caret').first();
if ((await caret.count()) > 0) {
  await caret.click();
  await win.waitForTimeout(700);
  await shot('02-dropdown-open');
}

/* Open the PROJECT picker as well, so "is this menu different from the others?"
 * is answered by comparing two live surfaces rather than by eye. */
const openMenuBg = await win.evaluate(() => {
  const m = document.querySelector('.pd-split-menu');
  return m === null ? null : getComputedStyle(m).backgroundColor;
});
console.log('split menu background (open):', openMenuBg);
await win.keyboard.press('Escape');
await win.waitForTimeout(300);
const chip = win.locator('.pd-project-chip').first();
if ((await chip.count()) > 0) {
  await chip.click();
  await win.waitForTimeout(700);
  await win.screenshot({ path: path.join(OUT, '03-project-menu.png') });
}

const report = await win.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const c = getComputedStyle(el);
    return {
      background: c.backgroundColor,
      border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
      radius: c.borderRadius,
      backdrop: c.backdropFilter,
      boxShadow: c.boxShadow === 'none' ? 'none' : c.boxShadow.slice(0, 44),
    };
  };
  return {
    showButton: pick('.pd-present-action'),
    showButtonText: document.querySelector('.pd-present-action')?.textContent ?? null,
    hasFolderIcon: document.querySelector('.pd-present-action svg') !== null,
    splitMain: document.querySelector('.pd-split-main')?.getAttribute('aria-label') ?? null,
    hasRealAppIcon: document.querySelector('.pd-split-app-icon img') !== null,
    // The two surfaces that must look identical.
    splitMenu: pick('.pd-split-menu'),
    projectMenu: pick('.pd-project-menu'),
  };
});
console.log(JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await app.close();
