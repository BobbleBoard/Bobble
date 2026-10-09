/**
 * PRESSING A THING IN THE SIDEBAR PAINTS NOW.
 *
 * The user, twice: "clicking onto a different chat has a ~2 second delay", then
 * "clicking new chat still takes a few seconds". Both had the same cause — the
 * renderer awaited a pi RPC before touching a pixel — and both are fixed the
 * same way: reset what is local immediately, settle with pi behind it.
 *
 * The mock answers instantly, which is why no probe ever caught this. So the
 * mock is told to take its time (`MOCK_PI_SLOW_MS`), and the assertion is that
 * the UI does NOT: an empty thread within a fraction of the RPC it no longer
 * waits for. Without the delay this probe passes on a broken build.
 *
 *   node apps/desktop/tests/e2e/instant-nav-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

/** How long pi is pretending to take. */
const SLOW_MS = 1500;
/** What the UI is allowed to take. Generous — the point is orders, not tuning. */
const BUDGET_MS = 400;

/*
 * Two chats ON DISK, because switching to the one you are already in is not a
 * switch — the first cut clicked the only row there was and measured a no-op.
 */
const home = mkdtempSync(path.join(tmpdir(), 'instant-nav-home-'));
const sessions = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessions, { recursive: true });
const seed = (file, id, text) =>
  writeFileSync(
    path.join(sessions, file),
    `${[
      JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd: '/tmp' }),
      JSON.stringify({
        type: 'message',
        id: `${id}-u1`,
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n')}\n`,
  );
seed('alpha.jsonl', 'sess-alpha', 'the chat about apples');
seed('beta.jsonl', 'sess-beta', 'the chat about bananas');

const { page, shot, check, finish } = await launchApp('instant-nav', {
  env: { HOME: home, MOCK_PI_SLOW_MS: String(SLOW_MS) },
});

/** ms from `act()` until `done()` reads true in the page. */
const timeUntil = async (act, done, label) => {
  const started = Date.now();
  await act();
  await page.waitForFunction(done, undefined, { timeout: SLOW_MS * 4 }).catch(() => undefined);
  const took = Date.now() - started;
  console.log(`  ${label}: ${took}ms`);
  return took;
};

try {
  // A conversation to leave behind.
  await page.evaluate(() => {
    const store = window.__pi_store();
    store.getState().setMessagesExternal([
      { kind: 'user', id: 'u1', text: 'the chat I am leaving', timestamp: 1 },
      { kind: 'assistant', id: 'a1', blocks: [{ type: 'text', text: 'a reply' }], timestamp: 2 },
    ]);
  });
  await page.waitForTimeout(200);
  await shot('01-before');

  const newChat = await timeUntil(
    async () => {
      // The REAL control, never a store poke — a probe that falls back to
      // calling the state directly is asserting nothing about the button.
      await page.click('[data-testid="new-chat"]', { timeout: 5000 });
    },
    () => (window.__pi_store().getState().messages ?? []).length === 0,
    'new chat cleared the thread',
  );
  check(
    newChat < BUDGET_MS,
    `New chat paints in ${newChat}ms, well inside pi's ${SLOW_MS}ms (budget ${BUDGET_MS}ms)`,
  );
  await shot('02-after-new-chat');

  // The session pointer settles behind it — the RPC still happens, it is just
  // no longer standing between the click and the screen.
  await page.waitForTimeout(SLOW_MS + 600);
  const settled = await page.evaluate(() => window.__pi_store().getState().session ?? null);
  check(settled !== null, 'the session pointer settles after the RPC returns');
  console.log('  session after settle:', JSON.stringify(settled)?.slice(0, 120));

  /*
   * THE OTHER HALF: switching to an existing chat. Same complaint ("clicking
   * onto a different chat has a ~2 second delay"), same fix, and until this
   * probe it was only ever measured against a mock that answered instantly —
   * which is to say, not measured.
   */
  const rows = await page.$$('[data-testid^="chat-row-"]');
  if (rows.length === 0) {
    console.log('  (no on-disk chat rows in this fixture — switch timing skipped)');
  } else {
    console.log(`  ${rows.length} chat rows`);
    const switchMs = await timeUntil(
      async () => {
        await page.evaluate(() => {
          const s = window.__pi_store().getState();
          window.__navMark = { epoch: s.sessionEpoch, n: (s.messages ?? []).length };
        });
        // The LAST row, so it is never the one already open.
        await rows[rows.length - 1].click();
      },
      () => {
        const s = window.__pi_store().getState();
        return (
          s.sessionEpoch !== window.__navMark.epoch ||
          (s.messages ?? []).length !== window.__navMark.n
        );
      },
      'switching chats repainted',
    );
    check(
      switchMs < BUDGET_MS,
      `chat switch paints in ${switchMs}ms, inside pi's ${SLOW_MS}ms (budget ${BUDGET_MS}ms)`,
    );
  }
} finally {
  await finish();
}
