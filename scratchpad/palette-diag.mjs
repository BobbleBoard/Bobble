/* Why does Escape stop closing the palette over Settings when the composer
 * subscribes to one more store key? Look at focus, the DOM and the console. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from '../apps/desktop/tests/e2e/_focus.mjs';

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble',
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'palette-diag-'))}`],
  env: { ...process.env, PI_E2E: '1', ...background.env },
});
const page = await app.firstWindow();
background.restore();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.waitForSelector('[data-testid="composer-input"]', { timeout: 90_000 });

const state = () =>
  page.evaluate(() => ({
    palette: document.querySelector('[data-testid="command-palette"]') !== null,
    paletteInput: document.querySelector('[data-testid="command-palette-input"]') !== null,
    settings: document.querySelector('[data-testid="settings-view"]') !== null,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    active: (() => {
      const el = document.activeElement;
      if (el === null) return null;
      return `${el.tagName}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}${el.className ? `.${String(el.className).slice(0, 40)}` : ''}`;
    })(),
  }));

await page.keyboard.press('Meta+k');
await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 5000 });
await page.fill('[data-testid="command-palette-input"]', 'Settings');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
console.log('after opening Settings :', JSON.stringify(await state()));
await page.keyboard.press('Meta+k');
await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 5000 });
await page.waitForTimeout(200);
console.log('palette over Settings   :', JSON.stringify(await state()));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
console.log('after Escape            :', JSON.stringify(await state()));
await page.waitForTimeout(1500);
console.log('1.5s later              :', JSON.stringify(await state()));
console.log('console:', errors.slice(0, 8));
await app.close().catch(() => undefined);
