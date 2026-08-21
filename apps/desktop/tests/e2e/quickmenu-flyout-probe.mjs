/**
 * "More models" as a HOVER FLYOUT, photographed.
 *
 * the user: "I need to hover on the more models > and then have the stuff popup on
 * the right side, not click and have a menu within a menu."
 *
 * Two things have to be true and neither is visible from the markup alone: the
 * panel must open on HOVER (no click), and it must land BESIDE the quick menu
 * rather than inside it — so this measures the parent menu's right edge against
 * the panel's left edge, and shoots the result.
 */
import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT = process.env.OUT ?? '/tmp/quickmenu-flyout';
const app = await _electron.launch({
  // Isolated userData: the single-instance lock lives there, so without this the
  // probe races an installed Bobble and the window closes under it.
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);

const box = async (sel) =>
  win.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(r.right),
    };
  }, sel);

try {
  /*
   * TWO WINDOW WIDTHS, because the side the flyout picks is a function of the
   * room next to the menu, not of the markup. The quick menu is anchored to the
   * model chip at the right end of the composer, so on a narrow window there is
   * no 300px to its right and the browser flips it — which is correct, a panel
   * hanging off the window edge is worse than one on the other side. What has to
   * hold at BOTH widths is that it opens on hover and lands BESIDE the menu
   * rather than inside it; the right side is what it takes whenever it fits.
   */
  for (const [label, width, height] of [
    ['narrow', 1440, 868],
    ['wide', 1900, 1000],
  ]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win0 = BrowserWindow.getAllWindows()[0];
      win0?.setBounds({ x: 60, y: 60, width: size.w, height: size.h });
    }, { w: width, h: height });
    await win.waitForTimeout(700);

    await win.click('[data-testid="footer-model-chip"]');
    await win.waitForTimeout(600);
    const menu = await box('[data-testid="footer-model-menu"]');
    await win.screenshot({ path: path.join(OUT, `${label}-1-menu.png`) });

    // HOVER ONLY — never a click.
    await win.hover('[data-testid="footer-more-models"]');
    await win.waitForTimeout(900);

    const panel = await box('[data-testid="footer-more-models-panel"]');
    const rows = await win.evaluate(
      () => document.querySelectorAll('[data-testid="quick-menu-row"]').length,
    );
    await win.screenshot({ path: path.join(OUT, `${label}-2-hover-flyout.png`) });

    if (panel === null) throw new Error(`${label}: hovering "More models" opened nothing`);
    if (menu === null) throw new Error(`${label}: the quick menu is not on screen`);

    // BESIDE, not inside: the panel's box must not overlap the menu's box.
    const beside = panel.x >= menu.right - 2 || panel.right <= menu.x + 2;
    const side = panel.x >= menu.right - 2 ? 'right' : 'left';
    // And the menu itself must be unchanged — the old behaviour grew it.
    const menuAfter = await box('[data-testid="footer-model-menu"]');
    const grew = menuAfter !== null && menuAfter.h > menu.h + 4;

    console.log(
      `${label} ${width}x${height}: menu ${menu.x}..${menu.right}, flyout ${panel.x}..${panel.right}` +
        ` (${rows} rows) → ${side}${beside ? '' : ' OVERLAPPING'}${grew ? ' MENU GREW' : ''}`,
    );
    if (!beside) throw new Error(`${label}: the flyout overlaps the menu`);
    if (grew) throw new Error(`${label}: the quick menu grew (${menu.h} → ${menuAfter?.h})`);
    if (label === 'wide' && side !== 'right')
      throw new Error('wide: there was room on the right and it still opened left');

    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
  }

  console.log('quickmenu-flyout-probe OK — hover opens it beside the menu, right when it fits');
} finally {
  await app.close();
}
