/**
 * b13: tell the user when they are not looking.
 *
 * A background chat could finish, or block on a question, with the only sign
 * being a dot in a sidebar the user was not on — or not in the app to see.
 *
 * The OS actually DISPLAYING a notification depends on the signing identity
 * (under a per-checkout dev build macOS may silently show nothing), so what is
 * asserted here is everything this app controls: the focus gate, the badge, and
 * an honest `shown:false` with a reason when the OS declines.
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
  console.error(`notify-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-notify-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const notify = (page) =>
  page.evaluate(() =>
    window.piDesktop.invoke('app:notify', {
      title: 'A background chat finished',
      body: 'It finished while you were away.',
      sessionFile: '/tmp/some-chat.jsonl',
      kind: 'finished',
    }),
  );

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  /* --- the gate ------------------------------------------------------------
     THIS NO LONGER STEALS THE SCREEN, and it should never have.

     It used to call `app.focus({ steal: true })` and `win.show()` to make the
     window frontmost so it could check that a focused window is not
     interrupted. That ran on every suite pass, over whatever the user was
     doing — the exact thing the test mode exists to prevent, and almost
     certainly the "app popping up as a real window" the user saw.

     It was not even testing the thing: `app:notify` suppresses on test mode
     FIRST, so the focused branch was unreachable here, and every run that
     failed to steal the screen fell into a vacuous `else`. The decision is a
     pure function now (electron/notify-gate.ts) with all five rules covered in
     notify-gate.test.ts, including the two this could never reach.

     What is left is what only a real app can say: that the channel answers
     honestly, with a reason, and that the answer here is the suppression a test
     run must get. */
  const gated = await notify(page);
  if (gated?.shown !== false) {
    fail(`a test run posted a notification: ${JSON.stringify(gated)}`);
  } else if (!String(gated.reason ?? '').includes('background test mode')) {
    fail(`suppressed without saying it was the test mode: ${JSON.stringify(gated)}`);
  } else {
    console.log(`[notify] OK: a test run is suppressed and says why — "${gated.reason}"`);
  }

  // --- and it stays suppressed with the window blurred ----------------------
  // Blurring is free — it takes nothing from the user — and it proves the
  // suppression is not just the focus gate wearing a different hat.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur());
  await page.waitForTimeout(400);
  const away = await notify(page);
  if (away === null || typeof away.shown !== 'boolean') {
    fail(`no answer at all: ${JSON.stringify(away)}`);
  } else if (away.shown) {
    fail(`a test run posted a notification once the window blurred: ${JSON.stringify(away)}`);
  } else {
    console.log(`[notify] OK: still suppressed with the window blurred — "${away.reason}"`);
  }

  // --- the badge ------------------------------------------------------------
  const set = await page.evaluate(() => window.piDesktop.invoke('app:set-badge', { count: 3 }));
  const badge = await app.evaluate(({ app: a }) => a.dock?.getBadge?.() ?? null);
  if (process.platform === 'darwin') {
    if (set?.ok !== true) fail(`set-badge refused on macOS: ${JSON.stringify(set)}`);
    else if (badge !== '3') fail(`badge is ${JSON.stringify(badge)}, expected "3"`);
    else console.log('[notify] OK: the dock badge counts waiting chats');
    await page.evaluate(() => window.piDesktop.invoke('app:set-badge', { count: 0 }));
    const cleared = await app.evaluate(({ app: a }) => a.dock?.getBadge?.() ?? null);
    if (cleared !== '') fail(`badge did not clear: ${JSON.stringify(cleared)}`);
    else console.log('[notify] OK: zero clears it');
  }
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('notify-probe OK');
