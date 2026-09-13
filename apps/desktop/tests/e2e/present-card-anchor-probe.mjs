/**
 * A PRESENTED CARD STAYS WITH THE MESSAGE IT WAS HANDED OVER IN.
 *
 * the user (2026-09-12): "file cards pin themselves to the bottom of a chat
 * rather than the bottom of the message they were called in … when a new user
 * message is sent after I see this file card, I should not see it move down
 * with the chat … if the model presents the same file and it has an update
 * that's when a new file card appears below but they don't travel through a
 * user sent message."
 *
 * mock-pi answers three prompts. The card is recorded the way `present:show`
 * records it — anchored to the LAST message at the moment, which mid-turn is
 * the first assistant message of a group that goes on — then two more prompts
 * are sent. The card must sit under its own reply, above the later user
 * bubbles; a re-present from a later turn adds a second card there and leaves
 * the first where it was. Then a second chat: no cards.
 *
 *   FIXTURE=/tmp/stream-fixture.json node apps/desktop/tests/e2e/present-card-anchor-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const FIXTURE = process.env.FIXTURE ?? '/tmp/stream-fixture.json';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'present-anchor');
mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'present-anchor-udd-'))}`],
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_E2E_NO_SERVER: '1',
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: FIXTURE,
  },
});
const doc = path.join(mkdtempSync(path.join(tmpdir(), 'present-anchor-doc-')), 'brief.md');
writeFileSync(doc, '# Brief\n\nmade from your brief\n');
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForFunction(() => typeof window.__present_store === 'function', { timeout: 20000 });
  await win.waitForTimeout(1200);
  const send = async (text) => {
    const editor = win.locator('[contenteditable="true"]').first();
    await editor.click();
    await win.keyboard.type(text, { delay: 2 });
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => window.__pi_store().getState().agent.isStreaming, undefined, {
      timeout: 20000,
    });
    await win.waitForFunction(() => !window.__pi_store().getState().agent.isStreaming, undefined, {
      timeout: 60000,
    });
    await win.waitForTimeout(300);
  };
  const layout = () =>
    win.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="presented"]')].map((c) => ({
        top: Math.round(
          c.getBoundingClientRect().top +
            document.querySelector('[data-testid="chat-scroll"]').scrollTop,
        ),
        text: c.textContent?.slice(0, 40),
      }));
      const users = [...document.querySelectorAll('[data-user-turn]')].map((u) => ({
        id: u.getAttribute('data-user-turn'),
        top: Math.round(
          u.getBoundingClientRect().top +
            document.querySelector('[data-testid="chat-scroll"]').scrollTop,
        ),
      }));
      return { cards, users };
    });

  await send('first');
  // Record the card the way present:show does — anchored to the last message
  // right now (the first reply), in this chat.
  await win.evaluate((p) => {
    const s = window.__pi_store().getState();
    const messages = s.messages;
    const anchor = messages[messages.length - 1].id;
    window
      .__present_store()
      .getState()
      .add({
        path: p,
        note: 'made from your brief',
        afterMessageId: anchor,
        chat: s.session?.sessionFile ?? '',
      });
  }, doc);
  await win.waitForTimeout(400);
  const l1 = await layout();
  log('after the first reply:', JSON.stringify(l1));
  check(l1.cards.length === 1, 'one card after the first present');

  await send('second');
  await send('third');
  const l2 = await layout();
  log('after two more prompts:', JSON.stringify(l2));
  check(l2.users.length === 3, `three user turns (${l2.users.length})`);
  check(l2.cards.length === 1, `still one card (${l2.cards.length})`);
  const secondUserTop = l2.users[1]?.top ?? 0;
  check(
    (l2.cards[0]?.top ?? Number.POSITIVE_INFINITY) < secondUserTop,
    `the card sits ABOVE the second user message (card ${l2.cards[0]?.top} vs user ${secondUserTop})`,
  );
  await win.evaluate(() => {
    document.querySelector('[data-testid="presented"]')?.scrollIntoView({ block: 'center' });
  });
  await win.waitForTimeout(300);
  writeFileSync(path.join(OUT, '01-card-stays-with-its-reply.png'), await win.screenshot());

  // A re-present from the newest turn: a second card there, the first stays.
  await win.evaluate((p) => {
    const s = window.__pi_store().getState();
    const messages = s.messages;
    window
      .__present_store()
      .getState()
      .add({
        path: p,
        note: 'updated',
        afterMessageId: messages[messages.length - 1].id,
        chat: s.session?.sessionFile ?? '',
      });
  }, doc);
  await win.waitForTimeout(400);
  const l3 = await layout();
  log('after a re-present:', JSON.stringify(l3));
  check(l3.cards.length === 2, `a re-present from a later turn adds a card (${l3.cards.length})`);
  check((l3.cards[0]?.top ?? 0) < secondUserTop, 'the first card did not move');
  check(
    (l3.cards[1]?.top ?? 0) > (l3.users[2]?.top ?? 0),
    'the new card is under the newest reply',
  );
  writeFileSync(path.join(OUT, '02-represent-adds-below.png'), await win.screenshot());

  // Another chat: none of this chat's cards.
  await win.locator('[data-testid="new-chat"]').click();
  await win.waitForTimeout(800);
  const l4 = await layout();
  check(l4.cards.length === 0, `a new chat shows no cards from the old one (${l4.cards.length})`);
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'present-card-anchor-probe OK' : `FAILED: ${failures.length}`);
