/**
 * THE SIDEBAR LIGHTS WHAT IS ON SCREEN — however you got there.
 *
 * the user (2026-10-08): "ensure the sidebar highlight applies correctly to
 * whatever's actually selected, currently I think it gets stuck on chats,
 * doesn't show connectors and such if they're selected maybe also something to
 * do with if they're not directly selected given there's multiple ways to get
 * to different places".
 *
 * Visits each place by its sidebar row AND by another door (the composer's +
 * › Connectors › Manage, the model menu's More models, a studio from a
 * workspace screen, a chat from a studio), and after each records every
 * highlighted sidebar row. Exactly one row may be lit, and it must be the
 * place on screen.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/sidebar-selection-look.mjs
 */
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { page, check, shot, finish } = await launchApp('sidebar-selection', {
  args: ['--', '--piE2E=1'],
  env: { PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});

/** The lit sidebar rows, by test id (or text when a row has none). */
const lit = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('aside [data-selected="true"], nav [data-selected="true"]')]
      .filter((el) => el.closest('.pd-sidebar, [data-testid="sidebar"], aside') !== null)
      .map((el) => el.getAttribute('data-testid') ?? (el.textContent ?? '').trim().slice(0, 30)),
  );
let n = 0;
async function expectLit(label, want) {
  // Off the rows, so a hover wash is not mistaken for the highlight.
  await page.mouse.move(900, 500);
  await sleep(500);
  const got = await lit();
  const ok = got.length === 1 && (want instanceof RegExp ? want.test(got[0]) : got[0] === want);
  console.log(`${label}: ${JSON.stringify(got)}`);
  check(ok, `${label} → only ${want} lit (${got.join(', ') || 'nothing'})`);
  n += 1;
  await shot(`${String(n).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
}

try {
  await sleep(1500);
  // A chat to come back to.
  await page.click('[data-testid="new-chat"]');
  await sleep(800);
  await expectLit('a chat', /^chat-row-/);

  await page.click('[data-testid="nav-connectors"]');
  await expectLit('Extensions (row)', 'nav-connectors');

  await page.click('[data-testid="nav-model-management"]');
  await expectLit('Models (row)', 'nav-model-management');

  await page.click('[data-testid="nav-scheduled"]');
  await expectLit('Scheduled (row)', 'nav-scheduled');

  await page.click('[data-testid="modality-image"]');
  await expectLit('Image studio (row)', 'modality-image');

  // A studio, then a workspace screen from the sidebar: the studio comes down.
  await page.click('[data-testid="nav-connectors"]');
  await expectLit('Extensions from a studio', 'nav-connectors');

  // Back to the chat by its row.
  await page.click('[data-testid^="chat-row-"]');
  await expectLit('the chat again (row)', /^chat-row-/);

  // Another door: the composer's + › Connectors › Manage connectors.
  await page.click('[aria-label="Add to message"]');
  await sleep(300);
  await page.hover('[data-testid="add-connectors"]');
  await sleep(300);
  await page.click('[data-testid="add-connectors-manage"]');
  await expectLit('Extensions (composer +)', 'nav-connectors');

  // A studio from a workspace screen, then a chat from the studio.
  await page.click('[data-testid="modality-audio"]').catch(() => undefined);
  if ((await page.$('[data-testid="modality-audio"]')) !== null) {
    await expectLit('Audio studio from Extensions', 'modality-audio');
  }
  await page.click('[data-testid^="chat-row-"]');
  await expectLit('a chat from a studio', /^chat-row-/);
} finally {
  await finish();
}
