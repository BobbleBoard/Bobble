/**
 * b10: /help, /new and /compact for real.
 *
 * All three were in the `/` menu and none did anything — typing `/compact` sent
 * the literal text to the model, which answered as if asked ABOUT compaction.
 *
 * Drives the real app. `/compact` needs a live model to actually summarise, so
 * what is asserted here is the part that is ours: it is REFUSED while a reply is
 * streaming (pi's compact() calls abort() first, which would kill the reply the
 * user is reading), and it says which of the two happened either way.
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
const PROBE_HOME = probeHome('slash-commands-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`slash-commands-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-slash-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const send = async (page, line) => {
  await page.click('.pd-composer-editor');
  await page.keyboard.type(line);
  // Typing `/` opens the command autocomplete, where Enter ACCEPTS the
  // highlighted item rather than submitting. Escape closes it (the first branch
  // of the composer's Escape chain) and leaves the typed text alone.
  if (line.startsWith('/')) {
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Enter');
};
const threadText = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="chat-scroll"]')?.textContent ?? '');

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // --- /help renders help, and does NOT reach the model ----------------------
  await send(page, '/help');
  await page.waitForTimeout(800);
  const help = await threadText(page);
  if (!help.includes('/compact')) fail('/help printed nothing about the commands');
  else if (!help.includes('Esc')) fail('/help omitted the keys section');
  else console.log('[slash] OK: /help renders the help');
  // A model turn would have produced a user bubble echoing "/help".
  const userBubbles = await page.evaluate(
    () => document.querySelectorAll('[data-testid="chat-scroll"] .pd-msg--user').length,
  );
  if (userBubbles > 0) fail('/help was sent to the model as a message');
  else console.log('[slash] OK: /help never reached the model');

  // --- a command with a tail is a MESSAGE, not a command ---------------------
  await send(page, '/help me write a regex');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(
    () => document.querySelectorAll('[data-testid="chat-scroll"] .pd-msg--user').length,
  );
  if (after === 0) fail('"/help me write a regex" was swallowed as a command');
  else console.log('[slash] OK: a command with a tail is treated as a message');

  // --- /compact is refused mid-stream, and says so ---------------------------
  await send(page, 'say something long please');
  await page.waitForSelector('[data-testid="composer-stop"]', { timeout: 15_000 });
  await send(page, '/compact');
  await page.waitForTimeout(900);
  const busyText = await threadText(page);
  if (!busyText.includes('Not compacted')) {
    fail('/compact mid-stream did not refuse (it would have killed the reply)');
  } else if (!busyText.includes('wait for the reply to finish')) {
    fail('the refusal did not say why');
  } else {
    console.log('[slash] OK: /compact refuses mid-stream, and says why');
  }
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('slash-commands-probe OK');
