/**
 * menu-row-probe.mjs — the user: "ensure that the hovered item has the exact same
 * margin on each side while hovered please, currently doesn't."
 *
 * Opens each dropdown that matters and measures, for every row, the gap between
 * the row's box and the menu's box on the LEFT and on the RIGHT. Equal gaps are
 * the whole requirement, and eyeballing a 1–2px difference is hopeless.
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
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'menu-rows');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-menurow-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);

const measure = () =>
  win.evaluate(() => {
    const menus = [...document.querySelectorAll('.pd-menu')].filter(
      (m) => m.getBoundingClientRect().width > 0,
    );
    return menus.map((menu) => {
      const mr = menu.getBoundingClientRect();
      const ms = getComputedStyle(menu);
      const rows = [...menu.querySelectorAll('.pd-menu-item')].slice(0, 6).map((row) => {
        const rr = row.getBoundingClientRect();
        const rs = getComputedStyle(row);
        return {
          text: (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 22),
          left: +(rr.left - mr.left).toFixed(1),
          right: +(mr.right - rr.right).toFixed(1),
          radius: rs.borderRadius,
          color: rs.color,
        };
      });
      return {
        classes: menu.className,
        menuPadding: ms.padding,
        scrollbar: menu.offsetWidth - menu.clientWidth,
        rows,
      };
    });
  });

const results = {};

// 1. The project picker — the menu the user screenshotted.
const chip = win.locator('.pd-project-chip').first();
if ((await chip.count()) > 0) {
  await chip.click();
  await win.waitForTimeout(900);
  await win.screenshot({ path: path.join(OUT, '01-project-menu.png') });
  results.project = await measure();
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
}

// 2. The sidebar footer profile menu — the user's "bottom left".
const profile = win.locator('[data-testid="profile-button"]').first();
if ((await profile.count()) > 0) {
  await profile.click();
  await win.waitForTimeout(900);
  await win.screenshot({ path: path.join(OUT, '02-profile-menu.png') });
  results.profile = await measure();
  await win.keyboard.press('Escape');
}

for (const [name, menus] of Object.entries(results)) {
  for (const m of menus ?? []) {
    console.log(`\n[${name}] ${m.classes} padding=${m.menuPadding} scrollbar=${m.scrollbar}px`);
    for (const r of m.rows) {
      const flag = Math.abs(r.left - r.right) > 0.5 ? '  <-- ASYMMETRIC' : '';
      console.log(
        `   ${r.text.padEnd(24)} left=${r.left} right=${r.right} radius=${r.radius} ${r.color}${flag}`,
      );
    }
  }
}
writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(results, null, 2));
await app.close();
