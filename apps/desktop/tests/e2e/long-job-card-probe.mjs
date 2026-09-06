/**
 * The 293 seconds of silence, now with words on them.
 *
 * The blind tester, on the moment that lost her: an image took 293 seconds and
 * the app said nothing for any of them. Her three rules, tested here on the
 * real card:
 *
 *   (a) it appears the instant a long job starts — title, estimate, timer, Cancel;
 *   (b) the timer MOVES (the proof of life for a job with nothing to show);
 *   (c) when it blows the estimate, it says so and offers the way out.
 *
 * Driven by injecting a running generate_image call, so it costs a second
 * rather than five minutes. The overrun state is reached by back-dating the
 * call's timestamp — the card reads wall-clock, which is exactly why it can be.
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/longjob node apps/desktop/tests/e2e/long-job-card-probe.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('long-job-card');

const cardText = () =>
  page.evaluate(() => {
    const q = (sel) => document.querySelector(sel)?.textContent ?? null;
    const card = document.querySelector('[data-testid="long-job-card"]');
    return {
      present: card !== null,
      overrunAttr: card?.getAttribute('data-overrun') ?? null,
      title: q('[data-testid="long-job-title"]'),
      estimate: q('[data-testid="long-job-estimate"]'),
      timer: q('[data-testid="long-job-timer"]'),
      cancel: q('[data-testid="long-job-cancel"]'),
      overrun: q('[data-testid="long-job-overrun"]'),
    };
  });

/** A turn with one generate_image call in flight, started `agoMs` ago. */
const runningImage = (agoMs) =>
  page.evaluate((ago) => {
    const started = Date.now() - ago;
    window.__pi_store().setState({
      messages: [
        {
          kind: 'user',
          id: 'u1',
          text: 'make me a picture of a coffee shop',
          timestamp: started - 10,
        },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: started,
          isStreaming: true,
          blocks: [
            {
              type: 'toolCall',
              id: 'img1',
              name: 'generate_image',
              arguments: { prompt: 'a coffee shop' },
            },
          ],
        },
      ],
      runningToolCalls: ['img1'],
    });
  }, agoMs);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('.pd-composer-editor', { timeout: 15_000 });

  // (a) The instant it starts.
  await runningImage(1_000);
  await page.waitForSelector('[data-testid="long-job-card"]', { timeout: 10_000 });
  const early = await cardText();
  console.log('   at 1s: ', JSON.stringify(early));
  check(early.title === 'Making your image', `the card names the work (got "${early.title}")`);
  check(
    early.estimate !== null && /on this Mac/.test(early.estimate),
    `it quotes a range up front (got "${early.estimate}")`,
  );
  check(early.cancel === 'Cancel', 'there is a way out');
  check(early.overrun === null, 'no overrun message while it is inside the estimate');
  await shot('01-card');

  // (b) The timer moves.
  const t1 = early.timer;
  await page.waitForTimeout(2500);
  const t2 = (await cardText()).timer;
  console.log(`   timer ${t1} → ${t2}`);
  check(t1 !== t2, `the timer moves (${t1} → ${t2})`);

  // (c) Past the estimate, it says so.
  await runningImage(11 * 60 * 1000);
  await page.waitForTimeout(1200);
  const late = await cardText();
  console.log('   at 11m:', JSON.stringify(late));
  check(late.overrunAttr === 'true', 'the card knows it has overrun');
  check(
    late.overrun !== null && /longer than usual/i.test(late.overrun),
    `it admits the estimate is blown (got "${late.overrun}")`,
  );
  check(late.timer === '11:00', `and the clock is honest about how long (got "${late.timer}")`);
  await shot('02-overrun');

  // An ordinary tool gets NO card — the point is the long waits, not every call.
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        { kind: 'user', id: 'u2', text: 'read the file', timestamp: Date.now() - 1000 },
        {
          kind: 'assistant',
          id: 'a2',
          timestamp: Date.now(),
          isStreaming: true,
          blocks: [
            { type: 'toolCall', id: 'r1', name: 'read_file', arguments: { path: '/tmp/x' } },
          ],
        },
      ],
      runningToolCalls: ['r1'],
    });
  });
  await page.waitForTimeout(800);
  const ordinary = await cardText();
  console.log('   ordinary tool:', ordinary.present);
  check(!ordinary.present, 'an ordinary tool call gets no card');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
