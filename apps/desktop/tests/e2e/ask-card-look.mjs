/**
 * THE ASK CARD, LOOKED AT — every question to the person as one card the
 * composer's width, just above it (chat/AskCard.tsx). The user (2026-10-01): "let's
 * put this sort of permission popup just as a little card same width as the
 * input bar floating directly above it (not on top of), and make the 'ask user'
 * question modals and any user inputs from the model or for the chat just
 * appear there".
 *
 * A conversation first (mock pi), then a permission ask, a question and a
 * yes/no raised through the renderer's own sink; each one screenshotted, and
 * measured: no backdrop, the card's width equals the composer's, its bottom
 * sits above the composer's top (never over it), and answering clears it.
 *
 *   node scripts/with-lock.mjs probe -- node apps/desktop/tests/e2e/ask-card-look.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

const { page, shot, check, finish } = await launchApp('ask-card-look', {
  env: { PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture },
});
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });
await page.waitForFunction(() => typeof window.__pi_sink === 'function', { timeout: 10_000 });

// A conversation on screen, so the card is seen where it lives: under the thread.
await page.click('.pd-composer-editor');
await page.keyboard.type('Hello there');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);

const geometry = () =>
  page.evaluate(() => {
    const card = document.querySelector('[data-testid="ask-slot"] > *');
    const composer = document.querySelector('.pd-composer');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
      };
    };
    return {
      card: r(card),
      composer: r(composer),
      overlay: document.querySelector('.pd-dialog-overlay') !== null,
      modal: document.querySelector('[aria-modal="true"]') !== null,
    };
  });

const looks = async (label) => {
  await page.waitForSelector('[data-testid="ask-slot"]', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot(label);
  const g = await geometry();
  check(g.card !== null, `${label}: a card in the composer slot`);
  check(!g.overlay && !g.modal, `${label}: no backdrop, not a modal`);
  if (g.card && g.composer) {
    check(
      Math.abs(g.card.left - g.composer.left) <= 1 &&
        Math.abs(g.card.right - g.composer.right) <= 1,
      `${label}: the composer's width (card ${g.card.left}..${g.card.right}, composer ${g.composer.left}..${g.composer.right})`,
    );
    check(
      g.card.bottom <= g.composer.top,
      `${label}: above the composer, never over it (card bottom ${g.card.bottom}, composer top ${g.composer.top})`,
    );
  }
  console.log(label, JSON.stringify(g));
};

// 1. A permission ask (the reviewer's "Run this command?").
await page.evaluate(() =>
  window.__pi_sink().uiRequest({
    id: 'perm-1',
    method: 'permission',
    title: 'Allow bash?',
    permission: {
      v: 1,
      toolName: 'bash',
      reason:
        'reviewer mode: flagged by model: This command lists the contents of a private system path.',
      args: { command: 'ls -la ~/Bobble/hi-im-a-really-visual-learner/ 2>&1' },
    },
  }),
);
await looks('1-permission');
await page.click('[data-testid="permission-once"]');
await page.waitForSelector('[data-testid="ask-slot"]', { state: 'detached', timeout: 5000 });
check(true, 'answering clears it');

// 2. The model's ask_user question.
await page.evaluate(() =>
  window.__pi_sink().uiRequest({
    id: 'ask-1',
    method: 'askUser',
    title: 'Which picture helps most?',
    ask: {
      v: 1,
      question: 'Which picture would help you most?',
      mode: 'choice',
      options: [
        { value: 'slices', label: 'Pizza slices rearranged into a rectangle' },
        { value: 'rings', label: 'Onion rings unrolled into a triangle' },
        { value: 'grid', label: 'Counting squares on a grid' },
      ],
    },
  }),
);
await looks('2-question');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const stillAsking = await page.locator('[data-testid="ask-slot"]').count();
if (stillAsking > 0) {
  const skip = page.getByRole('button', { name: /skip/i });
  if ((await skip.count()) > 0) await skip.first().click();
}
await page.waitForSelector('[data-testid="ask-slot"]', { state: 'detached', timeout: 5000 });

// 3. A yes/no (computer use for an app).
await page.evaluate(() =>
  window.__pi_sink().uiRequest({
    id: 'confirm-1',
    method: 'confirm',
    title: 'Let Bobble use Maps?',
    message: 'Bobble will click and type in Maps while it works on this.',
  }),
);
await looks('3-confirm');
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForSelector('[data-testid="ask-slot"]', { state: 'detached', timeout: 5000 });

await finish();
