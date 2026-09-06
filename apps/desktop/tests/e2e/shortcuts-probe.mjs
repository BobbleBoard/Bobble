/**
 * b2: the shortcuts the UI prints must do what they say.
 *
 * ⌘P ("Files"), ⌘T ("Browser") and ⌘U ("Add files or photos") were printed as
 * hints beside menu rows and bound nowhere. A printed shortcut that does
 * nothing is the same failure as a menu row that does nothing.
 *
 * ⌘U opens a native file dialog, which a probe cannot dismiss — so it is
 * checked by spying on the hidden input's click, not by pressing it for real.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('shortcuts-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`shortcuts-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-keys-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

const tabTitles = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="canvas-tabs-panel"] .pd-canvas-tab')].map(
      (n) => n.textContent?.trim() ?? '',
    ),
  );

// --- ⌘U: the hidden file input is clicked ----------------------------------
await page.evaluate(() => {
  const input = document.querySelector('input[type="file"]');
  window.__uClicks = 0;
  input?.addEventListener('click', (e) => {
    e.preventDefault(); // never let a native dialog open in a probe
    window.__uClicks += 1;
  });
});
await page.click('.pd-composer-editor');
await page.keyboard.press('Meta+u');
await page.waitForTimeout(300);
const uClicks = await page.evaluate(() => window.__uClicks ?? 0);
if (uClicks < 1) fail('⌘U did not open the file picker');
else console.log('[keys] OK: ⌘U opens the file picker');

// --- ⌘T: a browser tab ------------------------------------------------------
const beforeT = (await tabTitles()).length;
await page.keyboard.press('Meta+t');
await page.waitForTimeout(1200);
const afterT = await tabTitles();
if (afterT.length <= beforeT) fail(`⌘T opened no tab (was ${beforeT}, now ${afterT.length})`);
else console.log(`[keys] OK: ⌘T opened a tab (${JSON.stringify(afterT)})`);

// --- ⌘P: the project file tree ---------------------------------------------
const beforeP = (await tabTitles()).length;
await page.keyboard.press('Meta+p');
await page.waitForTimeout(1500);
const afterP = await tabTitles();
if (afterP.length <= beforeP) fail(`⌘P opened no tab (was ${beforeP}, now ${afterP.length})`);
else console.log(`[keys] OK: ⌘P opened a tab (${JSON.stringify(afterP)})`);

await app.close();
if (process.exitCode !== 1) console.log('shortcuts-probe OK');
