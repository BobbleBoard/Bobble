/**
 * canvas-tabs-probe.mjs — the user: "tabs in the canvas: some look ok, but it just
 * doesn't look that great. note and utilize how the reference screenshot
 * provided shows the active tab and the other tabs."
 *
 * The reference is Chrome's strip: the ACTIVE tab is filled and reads as
 * continuous with the content below it, while the inactive ones are flat and
 * quiet — the hierarchy is carried by fill, not by a border. Opens three tabs
 * and dumps what actually distinguishes active from inactive here.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'canvas-tabs');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-tabs-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_DESKTOP_MOCK: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);

// Open three tabs so active-vs-inactive is actually visible.
for (const name of ['Terminal', 'Files', 'Browser']) {
  const empty = win.getByText(name, { exact: true }).first();
  if ((await empty.count()) > 0) {
    await empty.click();
    await win.waitForTimeout(1200);
    continue;
  }
  const plus = win.locator('.pd-canvas-newtab').first();
  if ((await plus.count()) > 0) {
    await plus.click();
    await win.waitForTimeout(500);
    const row = win.locator('[role="menuitem"]', { hasText: new RegExp(name, 'i') }).first();
    if ((await row.count()) > 0) await row.click();
    await win.waitForTimeout(1200);
  }
}
await win.waitForTimeout(1500);
await win.screenshot({ path: path.join(OUT, '01-tabs.png') });

const strip = win.locator('.pd-canvas-tabstrip, [role="tablist"]').first();
if ((await strip.count()) > 0) {
  const b = await strip.boundingBox();
  if (b !== null) {
    await win.screenshot({
      path: path.join(OUT, '02-strip.png'),
      clip: { x: b.x, y: Math.max(0, b.y - 6), width: b.width, height: b.height + 24 },
    });
  }
}

const report = await win.evaluate(() => {
  const tabs = [...document.querySelectorAll('[role="tab"], .pd-canvas-tab')];
  const read = (el) => {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 18),
      selected: el.getAttribute('aria-selected') ?? el.getAttribute('data-active') ?? '?',
      background: c.backgroundColor,
      color: c.color,
      border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
      radius: c.borderRadius,
      boxShadow: c.boxShadow === 'none' ? 'none' : c.boxShadow.slice(0, 48),
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      fontWeight: c.fontWeight,
    };
  };
  const stripEl =
    document.querySelector('.pd-canvas-tabstrip') ?? document.querySelector('[role="tablist"]');
  return {
    stripClass: stripEl?.className ?? null,
    stripBg: stripEl === null ? null : getComputedStyle(stripEl).backgroundColor,
    panelBg: (() => {
      const p = document.querySelector('.pd-canvas-tabpanel');
      return p === null ? null : getComputedStyle(p).backgroundColor;
    })(),
    tabs: tabs.map(read),
  };
});
console.log(JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, 'tabs.json'), JSON.stringify(report, null, 2));
await app.close();
