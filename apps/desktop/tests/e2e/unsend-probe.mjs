/**
 * ⌘Z JUST AFTER SENDING TAKES THE MESSAGE BACK — and is plain undo otherwise.
 *
 * the user (2026-09-24): "pressing cmd z within 3 seconds of sending a message and
 * before any text has been typed into the input box should unsend+rewind the
 * chat".
 *
 * Driven with real keystrokes against mock-pi (MOCK_PI_LOG records every RPC
 * the app sends it, which is how the rewind itself is checked):
 *
 *   A  send, ⌘Z at ~1s     → the message and its reply leave the thread, the text
 *                            is back in the box, pi's turn is stopped and its
 *                            session forked to before the message
 *   B  send again          → the next message goes through, onto that branch
 *   C  send, type, ⌘Z      → plain undo of the typing; the message stays sent
 *   D  send, wait 3.5s, ⌘Z → plain undo; the message stays sent
 *   E  a message QUEUED behind a running turn, ⌘Z → off the queue, and the
 *      running turn is NOT stopped
 *
 *   a-sent, b-unsent, c-resent, d-typed-then-undo, e-after-window, f-queued,
 *   g-queued-unsent
 *
 * Checks assert the new behaviour, so the unmodified app fails them — that run
 * is the "before" picture.
 *
 *   OUT=/tmp/unsend node apps/desktop/tests/e2e/unsend-probe.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { streamedTurn, writeFixture } from './_mock-turns.mjs';
import { launchApp } from './harness.mjs';

const OUT = process.env.OUT ?? '/tmp/unsend';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(tmpdir(), `unsend-mock-${process.pid}.jsonl`);
writeFileSync(LOG, '');

const para = (topic) =>
  `Here is a careful answer about ${topic}. It streams for a while so there is a turn to stop. `.repeat(
    6,
  );
const fixture = writeFixture(path.join(tmpdir(), `unsend-${process.pid}.json`), 'unsend', [
  streamedTurn(para('the fox'), { match: 'tiny hat', chunks: 40, stepMs: 120 }),
  streamedTurn('A fox in a tiny red hat, coming right up.', {
    match: 'tiny red hat',
    chunks: 10,
    stepMs: 60,
  }),
  streamedTurn('Owls hunt at night.', { match: 'owl', chunks: 8, stepMs: 60 }),
  streamedTurn('Herons wade.', { match: 'heron', chunks: 8, stepMs: 60 }),
  streamedTurn(para('kestrels'), { match: 'kestrel', chunks: 30, stepMs: 120, leadMs: 4000 }),
  streamedTurn('Swifts sleep on the wing.', { match: 'swift', chunks: 8, stepMs: 60 }),
]);

const { page, check, finish } = await launchApp('unsend', {
  fixture,
  env: { PI_E2E_NO_SERVER: '1', MOCK_PI_LOG: LOG },
  waitFor: '[data-testid="composer-input"]',
});
const shot = (label) => page.screenshot({ path: path.join(OUT, `${label}.png`) });
const composerText = () =>
  page.evaluate(() => document.querySelector('[data-testid="composer-input"]')?.textContent ?? '');
const userBubbles = () =>
  page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.filter((m) => m.kind === 'user')
      .map((m) => m.text),
  );
const queued = () =>
  page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .queuedSends.map((q) => q.text),
  );
const rpcs = () =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'command')
    .map((r) => r.command);
const idle = () =>
  page.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight;
    },
    undefined,
    { timeout: 20000 },
  );
const send = async (text) => {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(2000);

  /* ── A. send, then ⌘Z inside the window ── */
  const A = 'Draw a fox wearing a tiny hat';
  await send(A);
  await page.waitForFunction(() => window.__pi_store().getState().agent.isStreaming, undefined, {
    timeout: 8000,
  });
  await sleep(700);
  await shot('a-sent');
  const beforeZ = rpcs().length;
  await page.keyboard.press('Meta+z');
  await sleep(1200);
  await shot('b-unsent');
  const aUsers = await userBubbles();
  const aBox = await composerText();
  const aRpc = rpcs()
    .slice(beforeZ)
    .map((c) => c.type);
  console.log('A:', JSON.stringify({ users: aUsers, composer: aBox, rpcs: aRpc }));
  check(!aUsers.includes(A), `the message left the thread (${JSON.stringify(aUsers)})`);
  check(aBox === A, `its text is back in the box ("${aBox}")`);
  check(aRpc.includes('abort'), `its turn was stopped (${aRpc.join(',')})`);
  check(
    aRpc.includes('get_fork_messages') && aRpc.includes('fork'),
    `pi's session was rewound to before it (${aRpc.join(',')})`,
  );
  const assistantRows = await page.evaluate(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.filter((m) => m.kind === 'assistant').length,
  );
  check(assistantRows === 0, `nothing of its reply is left in the thread (${assistantRows} rows)`);

  /* ── B. edit it and send again: it goes through, onto the rewound branch ── */
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.press('End');
  // "…tiny hat" → "…tiny red hat"
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('red ');
  const B = await composerText();
  await page.keyboard.press('Enter');
  await idle();
  await sleep(400);
  await shot('c-resent');
  const forkAt = rpcs().findLastIndex((c) => c.type === 'fork');
  const promptAfter = rpcs().findIndex((c, i) => i > forkAt && c.type === 'prompt');
  console.log('B:', JSON.stringify({ sent: B, users: await userBubbles() }));
  check(
    B === 'Draw a fox wearing a tiny red hat',
    `the restored text was edited in place ("${B}")`,
  );
  check(
    (await userBubbles()).join('|') === B,
    `the thread holds only the resent message (${JSON.stringify(await userBubbles())})`,
  );
  check(promptAfter > forkAt, 'the resend reached pi AFTER the rewind');

  /* ── C. send, type something, ⌘Z → plain undo of the typing ── */
  const C = 'Tell me about the owl';
  await send(C);
  await sleep(300);
  await page.keyboard.type('xyz');
  const forksBeforeC = rpcs().filter((c) => c.type === 'fork').length;
  await page.keyboard.press('Meta+z');
  await sleep(700);
  await shot('d-typed-then-undo');
  const cBox = await composerText();
  console.log('C:', JSON.stringify({ composer: cBox, users: await userBubbles() }));
  check((await userBubbles()).includes(C), 'typing first: the message stays sent');
  check(!cBox.includes('xyz'), `…and ⌘Z undid the typing ("${cBox}")`);
  check(
    rpcs().filter((c) => c.type === 'fork').length === forksBeforeC,
    '…and nothing was rewound',
  );
  // Clear the box for the next case.
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await idle();

  /* ── D. after the window → plain undo ── */
  const D = 'And the heron?';
  await send(D);
  await sleep(3600);
  const forksBeforeD = rpcs().filter((c) => c.type === 'fork').length;
  await page.keyboard.press('Meta+z');
  await sleep(700);
  await shot('e-after-window');
  console.log('D:', JSON.stringify({ composer: await composerText(), users: await userBubbles() }));
  check((await userBubbles()).includes(D), 'after three seconds the message stays sent');
  check(
    rpcs().filter((c) => c.type === 'fork').length === forksBeforeD,
    '…and nothing was rewound',
  );
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await idle();

  /* ── E. a message queued behind a running turn ── */
  // The kestrel reply holds EMPTY for 4s — the window in which the composer
  // queues a second message rather than sending it into the turn.
  await send('What about the kestrel?');
  await page.waitForFunction(() => window.__pi_store().getState().agent.isStreaming, undefined, {
    timeout: 8000,
  });
  await sleep(300);
  const E = 'And a swift?';
  await send(E);
  await sleep(500);
  await shot('f-queued');
  const qBefore = await queued();
  const abortsBefore = rpcs().filter((c) => c.type === 'abort').length;
  await page.keyboard.press('Meta+z');
  await sleep(800);
  await shot('g-queued-unsent');
  const qAfter = await queued();
  const stillStreaming = await page.evaluate(
    () => window.__pi_store().getState().agent.isStreaming,
  );
  console.log(
    'E:',
    JSON.stringify({ qBefore, qAfter, composer: await composerText(), stillStreaming }),
  );
  check(
    qBefore.includes(E) && !qAfter.includes(E),
    `the queued message came off the queue (${JSON.stringify(qAfter)})`,
  );
  check((await composerText()) === E, 'its text is back in the box');
  check(
    stillStreaming && rpcs().filter((c) => c.type === 'abort').length === abortsBefore,
    'the turn it was waiting behind was NOT stopped',
  );
  await idle();
} finally {
  await finish();
}
