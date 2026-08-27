/**
 * rail-look-probe.mjs — the COLLAPSED left sidebar, looked at properly.
 *
 * the user: "attempt to format/style the left sidebar (collapsed) to make it able to
 * look better and work better when collapsed) in a way that it fits better, and
 * does cenetering and all of icons properly".
 *
 * Collapses the rail and reports, for every button, whether its glyph is
 * actually centred in its own box and whether the boxes share one vertical
 * axis — the two things "centering properly" means, and both invisible to a
 * screenshot alone at this size.
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
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'rail-look');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-rail-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);
await win.screenshot({ path: path.join(OUT, '01-expanded.png') });

const collapse = win.locator('[data-testid="collapse-sidebar"]').first();
if ((await collapse.count()) > 0) await collapse.click();
await win.waitForTimeout(1200);
await win.screenshot({ path: path.join(OUT, '02-collapsed.png') });

const rail = win.locator('.pd-rail').first();
if ((await rail.count()) > 0) {
  const box = await rail.boundingBox();
  await win.screenshot({
    path: path.join(OUT, '03-rail-only.png'),
    clip: { x: 0, y: 0, width: Math.ceil(box.width + 24), height: Math.ceil(box.height + box.y) },
  });
}

const report = await win.evaluate(() => {
  const railEl = document.querySelector('.pd-rail');
  if (railEl === null) return { error: 'no rail' };
  const rr = railEl.getBoundingClientRect();
  const cs = getComputedStyle(railEl);
  const rows = [];
  for (const btn of railEl.querySelectorAll('.pd-rail-btn, button')) {
    const b = btn.getBoundingClientRect();
    const icon = btn.querySelector('svg') ?? btn.querySelector('.pd-rail-btn-icon');
    const i = icon?.getBoundingClientRect() ?? null;
    rows.push({
      label: btn.getAttribute('aria-label') ?? btn.textContent?.trim().slice(0, 14) ?? '?',
      box: `${Math.round(b.width)}x${Math.round(b.height)}`,
      // Where the button's centre sits relative to the rail's centre.
      offsetFromRailCentre: +(b.left + b.width / 2 - (rr.left + rr.width / 2)).toFixed(1),
      // Where the GLYPH sits relative to its own button's centre.
      glyphOffset: i === null ? null : +(i.left + i.width / 2 - (b.left + b.width / 2)).toFixed(1),
      glyph: i === null ? null : `${Math.round(i.width)}x${Math.round(i.height)}`,
    });
  }
  const sep = document.querySelector('.pd-rail-sep');
  return {
    railWidth: Math.round(rr.width),
    railPadding: cs.padding,
    railGap: cs.gap,
    railAlign: cs.alignItems,
    sepWidth: sep === null ? null : Math.round(sep.getBoundingClientRect().width),
    sepInset: sep === null ? null : +(sep.getBoundingClientRect().left - rr.left).toFixed(1),
    rows,
  };
});
console.log(JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, 'rail.json'), JSON.stringify(report, null, 2));
await app.close();
