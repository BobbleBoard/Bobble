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

  /* --- the focus gate ------------------------------------------------------
     Asserted against MAIN's own answer rather than against a `focus()` call:
     a launched-under-test window does not reliably take focus, and a probe that
     assumed it did would be testing the harness, not the gate. */
  await app.evaluate(({ app: a, BrowserWindow }) => {
    // `focus()` alone does not take when the app is not frontmost, so ask the
    // OS to bring it forward first.
    a.focus?.({ steal: true });
    const w = BrowserWindow.getAllWindows()[0];
    w?.show();
    w?.focus();
  });
  await page.waitForTimeout(900);
  const reallyFocused = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false,
  );
  const focused = await notify(page);
  if (reallyFocused) {
    if (focused?.shown !== false) fail(`notified a focused window: ${JSON.stringify(focused)}`);
    else if (!String(focused.reason ?? '').includes('focused')) {
      fail(`no reason given: ${JSON.stringify(focused)}`);
    } else console.log('[notify] OK: a focused window is not interrupted, and it says why');
  } else if (focused?.shown === false && String(focused.reason ?? '').includes('focused')) {
    fail('claimed the window was focused when main says it is not');
  } else {
    console.log('[notify] OK: unfocused here, so the gate correctly let it through');
  }

  // --- unfocused: attempted, and honest about the outcome --------------------
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur());
  await page.waitForTimeout(400);
  const away = await notify(page);
  if (away === null || typeof away.shown !== 'boolean') {
    fail(`no answer at all: ${JSON.stringify(away)}`);
  } else if (away.shown) {
    console.log('[notify] OK: shown while unfocused');
  } else {
    // Not a failure — this is the signing-identity caveat, reported honestly.
    console.log(`[notify] OK: refused by the OS and SAID so — "${away.reason}"`);
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
