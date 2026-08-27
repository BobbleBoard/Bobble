/**
 * The quick menu, photographed doing the thing the user asked for: favourite a
 * model from "More models" and watch it lead the menu next time it opens.
 */

import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp';
const app = await _electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);

const CHIP = '[data-testid="footer-model-chip"]';
const shot = async (name) => {
  await win.screenshot({ path: path.join(OUT, `${name}.png`) });
};
const menuBox = async () =>
  win.evaluate(() => {
    const el = [...document.querySelectorAll('[role="menu"],[data-radix-menu-content]')].pop();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

await win.click(CHIP);
await win.waitForTimeout(700);
console.log('before, menu box:', JSON.stringify(await menuBox()));
await shot('qm-before');

await win.click('[data-testid="footer-more-models"]').catch(() => {});
await win.waitForTimeout(700);
const pins = await win.evaluate(
  () => document.querySelectorAll('[data-testid="quick-menu-star"]').length,
);
console.log('pin buttons:', pins);
await win.evaluate(() => document.querySelectorAll('[data-testid="quick-menu-star"]')[0]?.click());
await win.waitForTimeout(900);
await shot('qm-panel');
console.log('panel box:', JSON.stringify(await menuBox()));

// Customise: rename a slot and bind it, then confirm the menu reflects both.
await win.click('[data-testid="quick-menu-edit-toggle"]').catch(() => {});
await win.waitForTimeout(500);
console.log(
  'editor rows:',
  await win.evaluate(() => document.querySelectorAll('[data-testid="quick-menu-editrow"]').length),
);
await win.evaluate(() => {
  const names = document.querySelectorAll('[data-testid="quick-menu-slot-name"]');
  const el = names[1];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'Daily driver');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
// Settings persist through an IPC round trip, so give it a beat before asking
// whether the change survived — a fast re-read would test the render, not the
// persistence, which is the half that fails silently.
await win.waitForTimeout(1500);
await win.screenshot({ path: path.join(OUT, 'qm-editor.png') });
console.log('editor box:', JSON.stringify(await menuBox()));

await win.keyboard.press('Escape');
await win.waitForTimeout(500);
await win.click(CHIP);
await win.waitForTimeout(800);
console.log('after, menu box:', JSON.stringify(await menuBox()));
const rows = await win.evaluate(() =>
  [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent),
);
console.log('rows after favouriting:', JSON.stringify(rows));
await shot('qm-after');
await app.close();
