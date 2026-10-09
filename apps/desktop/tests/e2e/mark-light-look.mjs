/**
 * LOOK: the sidebar mark in LIGHT mode. The user, with the light-mode wordmark:
 * "in light mode make these black." Reads the tiles' computed fill in both
 * modes and photographs the identity row.
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('mark-light');
try {
  await page.waitForSelector('[data-testid="sidebar-identity"]', { timeout: 15_000 });
  const fills = async () =>
    page.evaluate(() => {
      const rect = document.querySelector('[data-testid="sidebar-identity"] svg rect');
      const word = document.querySelector('.pd-wordmark');
      return {
        mode: document.documentElement.getAttribute('data-mode'),
        tile: rect === null ? null : getComputedStyle(rect).fill,
        word: word === null ? null : getComputedStyle(word).color,
      };
    });
  const dark = await fills();
  console.log('  dark:', JSON.stringify(dark));
  check(dark.tile === 'rgb(255, 255, 255)', `dark tiles are white (${dark.tile})`);
  await page.evaluate(() => {
    const t = window.__pi_theme?.();
    if (t?.setMode) t.setMode('light');
    else document.documentElement.setAttribute('data-mode', 'light');
  });
  await page.waitForTimeout(600);
  const light = await fills();
  console.log('  light:', JSON.stringify(light));
  check(light.mode === 'light', `theme flipped to light (${light.mode})`);
  check(light.tile === 'rgb(0, 0, 0)', `light tiles are black (${light.tile})`);
  await shot('01-light-mark');
  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
