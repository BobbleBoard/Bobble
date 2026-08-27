import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp';
const app = await _electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.click('[data-testid="tp-gate-view"]').catch(() => {});
await win.waitForSelector('[data-testid="tp-canvas-host"]', { timeout: 30000 }).catch(() => {});
await win.waitForTimeout(2500);
const read = async (sel) =>
  await win.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
console.log('generate:', await read('[data-testid="tp-generate-btn"]'));
for (const [tab, sel] of [
  ['segment', 'tp-segment-btn'],
  ['retopo', 'tp-retopo-btn'],
  ['texture', 'tp-texture-btn'],
  ['animate', 'tp-rig-btn'],
]) {
  await win.click(`[data-testid="tp-rail-${tab}"]`).catch(() => {});
  await win.waitForTimeout(500);
  console.log(`${tab}:`, await read(`[data-testid="${sel}"]`));
}
for (const tab of ['model', 'segment', 'retopo', 'texture']) {
  await win.click(`[data-testid="tp-rail-${tab}"]`).catch(() => {});
  await win.waitForTimeout(700);
  await win.screenshot({ path: path.join(OUT, `est-${tab}.png`) });
}
await app.close();
