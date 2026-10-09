/**
 * A MESSAGE SENT WITH NO MODEL TO ANSWER IT — held, explained, never "fetch
 * failed".
 *
 * The user (2026-10-08): "our dreaded 'fetch failed' … red text that's just a
 * real unknown error or something that doesn't have handling attached to it
 * … just can't exist anymore." The commonest cause: the send waited for a
 * model that never came up and went on anyway.
 *
 * A fresh home with no models: the real app (no `piNoServer`), the real wait
 * for a model. "hello" stays on screen as the bubble, a card under it says
 * there is no model on this Mac and offers Open Models — no assistant error,
 * no red text — and Open Models goes there. Then each other reason (seeded:
 * a launch that ran short of memory, one that could not download, a slow
 * load) draws its own card and fix, and Choose another model opens the menu.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/held-send-look.mjs
 */
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { page, check, shot, finish } = await launchApp('held-send', {
  args: ['--', '--piE2E=1'],
  waitFor: '[data-testid="composer-input"]',
  timeout: 60_000,
});
const redInThread = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('main *')].filter((el) => {
        if (el.children.length > 0 || (el.textContent ?? '').trim() === '') return false;
        const c = getComputedStyle(el).color.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
        return c[0] > 180 && c[1] < 120 && c[2] < 120;
      }).length,
  );
try {
  await sleep(1500);
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText('hello');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="held-send"]', { timeout: 90_000 });
  await sleep(500);
  const held = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="held-send"]');
    const st = window.__pi_store().getState();
    return {
      kind: el?.getAttribute('data-kind'),
      text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      bubble: st.messages.some((m) => m.kind === 'user' && m.text === 'hello'),
      errors: st.messages.filter((m) => m.errorMessage !== undefined).length,
      inFlight: st.promptInFlight,
    };
  });
  console.log('held', JSON.stringify(held));
  check(held.kind === 'no-model', `no model on this Mac is the reason (${held.kind})`);
  check(held.bubble, 'the message stays on screen');
  check(held.errors === 0, `no error turn (${held.errors})`);
  check(held.inFlight === false, 'the composer is free again');
  check(
    /no model on this Mac/.test(held.text) && /Open Models/.test(held.text),
    'it says so, with Open Models',
  );
  check((await redInThread()) === 0, 'no red text');
  await shot('1-no-model');
  await page.click('[data-testid="held-fix-models"]');
  await sleep(1200);
  const onModels = await page.evaluate(
    () =>
      document.querySelector(
        '[data-testid="models-view"], [data-testid="model-hub"], .pd-models',
      ) !== null,
  );
  check(onModels, 'Open Models goes to the Models page');
  await shot('2-models');

  // Each other reason, drawn from a seeded hold.
  // Back to the chat (its row in the sidebar), where the message still waits.
  await page.click('[data-testid^="chat-row-"]');
  await page.waitForSelector('[data-testid="held-send"]', { timeout: 10_000 });
  check(true, 'back in the chat, the message still waits with its card');
  await sleep(500);
  const reasons = [
    [
      'failed',
      'refusing to launch: needs 21.4 GB, 9.8 GB free (fit reserve 30%)',
      /not enough free memory/,
    ],
    ['failed', 'failed to fetch vision projector: fetch failed', /could not reach the internet/],
    ['timeout', undefined, /more than five minutes/],
  ];
  for (const [i, [kind, detail, want]] of reasons.entries()) {
    await page.evaluate(
      ({ kind, detail }) => {
        const st = window.__pi_store().getState();
        const echo = st.messages.findLast((m) => m.kind === 'user');
        window
          .__held_send()
          .getState()
          .hold({
            sessionFile: st.session?.sessionFile ?? null,
            echoId: echo?.id ?? '',
            message: 'hello',
            images: [],
            problem: { kind, modelName: 'Qwen 3.8 27B', ...(detail ? { detail } : {}) },
            retrying: false,
          });
      },
      { kind, detail },
    );
    await sleep(400);
    const t = await page.textContent('[data-testid="held-send"]').catch(() => null);
    console.log('  ', kind, '→', (t ?? '(none)').replace(/\s+/g, ' ').slice(0, 140));
    check(
      want.test(t ?? ''),
      `${kind}${detail ? ` (${detail.slice(0, 30)}…)` : ''} has its own sentence`,
    );
    await shot(`3-${i}-${kind}`);
  }
  await page.click('[data-testid="held-fix-other-model"]');
  await sleep(500);
  check(
    (await page.$('[data-testid="footer-model-menu"]')) !== null,
    'Choose another model opens the model menu',
  );
} finally {
  await finish();
}
