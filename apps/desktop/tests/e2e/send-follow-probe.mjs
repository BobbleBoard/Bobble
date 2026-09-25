/**
 * ENTER TAKES YOU TO THE BOTTOM.
 *
 * the user (2026-09-24): "pressing enter on a chat should take you to the bottom".
 *
 * A long conversation, scrolled well up (a real wheel gesture, which is what
 * releases the thread's follow), then a message typed and sent with Enter. The
 * thread must land at its foot and KEEP following the streamed reply — and a
 * wheel tick up afterwards must still free the reader, exactly as before.
 *
 *   a-scrolled-up      the reader is up in the history
 *   b-after-enter      Enter: at the foot, the new message and its reply in view
 *   c-reply-followed   the reply kept streaming and the view kept up with it
 *
 * Checks assert the new behaviour, so the unmodified app fails them — that run
 * is the "before" picture.
 *
 *   OUT=/tmp/send-follow node apps/desktop/tests/e2e/send-follow-probe.mjs
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { streamedTurn, writeFixture } from './_mock-turns.mjs';
import { launchApp } from './harness.mjs';

const OUT = process.env.OUT ?? '/tmp/send-follow';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPLY =
  'Kestrels hover by flying into the wind at exactly the speed the wind is blowing, so they ' +
  'stay still relative to the ground. Their heads stay locked in place even as their bodies ' +
  'adjust, which lets them watch for voles in the grass below. When they spot one they drop ' +
  'in stages, pausing to re-aim, and finish with a short stoop. '.repeat(3);
const fixture = writeFixture(
  path.join(tmpdir(), `send-follow-${process.pid}.json`),
  'send-follow',
  [streamedTurn(REPLY, { chunks: 60, stepMs: 150 })],
);

const { page, check, finish } = await launchApp('send-follow', {
  fixture,
  env: { PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});
const shot = (label) => page.screenshot({ path: path.join(OUT, `${label}.png`) });
const geometry = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    return el === null
      ? null
      : {
          top: Math.round(el.scrollTop),
          gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          height: el.scrollHeight,
        };
  });

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1500);

  /* A long history: forty exchanges of a few paragraphs each. */
  await page.evaluate(() => {
    const para =
      'The survey crew logged the west manifold readings twice, once at dawn and once after ' +
      'the pumps cycled, and the two sets disagree by a margin nobody can explain yet.';
    const messages = [];
    for (let i = 0; i < 40; i++) {
      messages.push({
        kind: 'user',
        id: `hu${i}`,
        text: `Question ${i + 1}: what changed?`,
        timestamp: i * 10,
      });
      messages.push({
        kind: 'assistant',
        id: `ha${i}`,
        blocks: [{ type: 'text', text: `Answer ${i + 1}.\n\n${para}\n\n${para}` }],
        timestamp: i * 10 + 5,
      });
    }
    window.__pi_store().setState({ messages, session: { cwd: '/tmp' } });
  });
  await sleep(1200);

  /* Scroll well up the way a person does — wheel ticks over the thread. */
  const box = await page.locator('[data-testid="chat-scroll"]').boundingBox();
  if (box === null) throw new Error('no chat-scroll');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -600);
    await sleep(60);
  }
  await sleep(600);
  const up = await geometry();
  console.log('scrolled up:', JSON.stringify(up));
  await shot('a-scrolled-up');
  check(up !== null && up.gap > 2000, `the reader is well up in the history (gap ${up?.gap})`);

  /* Type and press Enter. */
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('How do kestrels hover in place?');
  await page.keyboard.press('Enter');
  await sleep(900);
  const sent = await geometry();
  console.log('after Enter:', JSON.stringify(sent));
  await shot('b-after-enter');
  check(sent !== null && sent.gap <= 2, `Enter brought the thread to its foot (gap ${sent?.gap})`);

  /* The reply streams on; the view keeps up with it. */
  await sleep(1600);
  const followed = await geometry();
  const streaming = () => page.evaluate(() => window.__pi_store().getState().agent.isStreaming);
  console.log('reply streaming:', JSON.stringify(followed), 'streaming', await streaming());
  await shot('c-reply-followed');
  check(
    followed !== null && followed.gap <= 2 && followed.height > (sent?.height ?? 0),
    `the thread followed the streaming reply (gap ${followed?.gap}, grew ${sent?.height}→${followed?.height})`,
  );

  /* …and scrolling up still frees the reader WHILE the reply streams: the
     rule the send must not break. (The pointer went to the composer to type;
     the wheel has to be over the thread again.) */
  check(await streaming(), 'the reply is still streaming when the reader scrolls up');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await sleep(1500);
  const freed = await geometry();
  console.log('wheel up mid-reply:', JSON.stringify(freed), 'streaming', await streaming());
  check(
    freed !== null && freed.gap > 200 && freed.height > (followed?.height ?? 0),
    `a wheel tick up mid-reply still releases the follow — the reply grew and the view stayed up (gap ${freed?.gap}, grew ${followed?.height}→${freed?.height})`,
  );
} finally {
  await finish();
}
