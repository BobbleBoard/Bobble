/**
 * b1: Escape stops the turn, and Escape Escape clears the draft.
 *
 * The key every terminal agent binds to "stop" did nothing here — halting a
 * reply meant finding and clicking the Stop button. This drives the real app:
 * sends a message, presses Escape mid-stream, and asserts the composer flipped
 * back out of its busy state. Then, idle, it types a draft and checks that ONE
 * Escape leaves it alone and a second within the window clears it.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`escape-stop-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-esc-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

// --- Escape stops a running turn -------------------------------------------
await page.click('.pd-composer-editor');
await page.keyboard.type('say something long');
await page.keyboard.press('Enter');
// Busy = the Stop control is present. Mock pi streams, so this is a real turn.
await page.waitForSelector('[data-testid="composer-stop"]', { timeout: 15_000 });
await page.click('.pd-composer-editor');
await page.keyboard.press('Escape');
try {
  await page.waitForSelector('[data-testid="composer-stop"]', {
    state: 'detached',
    timeout: 5000,
  });
  console.log('[escape] OK: Escape stopped the turn');
} catch {
  fail('Escape did not stop the running turn');
}

// --- Escape Escape clears the draft, one Escape does not --------------------
await page.waitForTimeout(500);
await page.click('.pd-composer-editor');
await page.keyboard.type('a draft worth not losing');
const textOf = () =>
  page.evaluate(() => document.querySelector('.pd-composer-editor')?.textContent ?? '');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
if (!(await textOf()).includes('worth not losing')) fail('one Escape wiped the draft');
else console.log('[escape] OK: one Escape leaves the draft alone');

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if ((await textOf()).includes('worth not losing'))
  fail('the second Escape did not clear the draft');
else console.log('[escape] OK: the second Escape cleared it');

// A stray Escape long after the first must not combine with it.
await page.click('.pd-composer-editor');
await page.keyboard.type('kept');
await page.keyboard.press('Escape');
await page.waitForTimeout(1400);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
if (!(await textOf()).includes('kept')) fail('two Escapes outside the window cleared the draft');
else console.log('[escape] OK: the arming window expires');

await app.close();
if (process.exitCode !== 1) console.log('escape-stop-probe OK');
