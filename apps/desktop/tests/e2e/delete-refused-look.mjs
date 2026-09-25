/**
 * A DELETE THE DISK REFUSES — the row comes back, and says why.
 *
 * Review of the 2026-09-23 wave: the sidebar dropped what deleteChatNow
 * returned, so a chat whose file could not be removed simply reappeared. Here
 * the chat's folder is read-only (the rm fails with EACCES, as for a file owned
 * by another user), the chat is deleted from its row menu like a person does,
 * and the probe reads what is on screen: the row back, and the error toast
 * naming the chat and the reason. No model, no pi turn.
 *
 *   SHOT_DIR=/tmp/delete-refused node tests/e2e/delete-refused-look.mjs
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('delete-refused');
const l = (o) => JSON.stringify(o);
const session = (dir, name, text, minute) => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  writeFileSync(
    file,
    [
      l({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: `2026-09-25T10:${String(minute).padStart(2, '0')}:00.000Z`,
        cwd: path.join(home, '.pi/desktop/sandbox', `conv-${name}`),
      }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: `2026-09-25T10:${String(minute).padStart(2, '0')}:01.000Z`,
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
  return file;
};
const sessions = path.join(home, '.pi', 'agent', 'sessions');
session(path.join(sessions, 'proj'), 'other', 'plan the launch', 1);
// Its own folder, made read-only: nothing in it can be unlinked.
const lockedDir = path.join(sessions, 'locked');
const stuck = session(lockedDir, 'stuck', 'trip plans for march', 2);
chmodSync(lockedDir, 0o555);

const { page, shot, check, finish } = await launchApp('delete-refused', {
  env: { HOME: home },
  waitFor: '[data-testid="composer-input"]',
});
const title = 'trip plans for march';
const summary = {};
try {
  const row = `[data-testid="chat-row-${title}"]`;
  await page.waitForSelector(row, { timeout: 15_000 });
  await page.locator(row).hover();
  await page.click(`[data-testid="chat-menu-${title}"]`);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.waitForSelector('[data-testid="delete-chat-confirm"]', { timeout: 5000 });
  await page.click('[data-testid="delete-chat-confirm"]');

  const toast = page.getByText("Couldn't delete", { exact: false });
  const shown = await toast
    .first()
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  summary.toast = shown ? await toast.first().innerText() : null;
  check(shown, 'no toast said the delete failed');
  check(
    typeof summary.toast === 'string' && summary.toast.includes(title),
    `the toast does not name the chat: ${summary.toast}`,
  );
  check(/permission/i.test(summary.toast ?? ''), `the toast does not say why: ${summary.toast}`);
  await page.waitForTimeout(400);
  await shot('01-refused-delete-toast');

  // The row is back — and stays on the next listing (its tombstone was forgotten).
  summary.rowBack = (await page.$(row)) !== null;
  check(summary.rowBack, 'the row did not come back');
  await page.evaluate(() => window.__pi_store().setState({ session: { sessionId: 'relist' } }));
  await page.waitForTimeout(900);
  summary.rowAfterRelist = (await page.$(row)) !== null;
  check(summary.rowAfterRelist, 'the row vanished again on the next listing');
  summary.fileStillThere = existsSync(stuck);
} finally {
  chmodSync(lockedDir, 0o755);
  console.log(JSON.stringify(summary, null, 2));
  await finish();
}
