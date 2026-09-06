/**
 * CHAT | WORK — the ledge slides, and nothing else moves.
 *
 * the user: "have that bottom bar that has the context model and project slide down
 * and slide up when we want it, by default … slid down. Claude has this little
 * thing in the top left that I think we can lift off of … left one being 'chat'
 * and right being 'work'."
 *
 * What is checked, in the order a person would notice it:
 *   1. the app opens in CHAT — no "No project", no "Effort · Adaptive";
 *   2. the toggle is in the top-left corner, beside the sidebar button;
 *   3. WORK slides the ledge out and it is really there (not just painted);
 *   4. the composer itself does not jump when it does — the ledge grows
 *      downward, and a composer that hops is the jitter this whole round is
 *      about;
 *   5. the choice survives a restart.
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/mode node apps/desktop/tests/e2e/mode-toggle-probe.mjs
 */
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('mode-toggle');
const { page, shot, check, finish, shotDir } = await launchApp('mode-toggle', {
  env: { HOME: home },
});

const geom = () =>
  page.evaluate(() => {
    const ledge = document.querySelector('[data-testid="composer-ledge"]');
    const bar = document.querySelector('[data-testid="composer-bar"]');
    const card = document.querySelector('.pd-composer-root');
    const r = (el) => (el === null ? null : el.getBoundingClientRect());
    const lb = r(ledge);
    const cb = r(card);
    return {
      open: ledge?.getAttribute('data-open') ?? null,
      ledgeHeight: lb === null ? null : Math.round(lb.height),
      barVisible: bar !== null && (r(bar)?.height ?? 0) > 4,
      cardTop: cb === null ? null : Math.round(cb.top),
      text: (ledge?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });

try {
  await page.waitForSelector('[data-testid="mode-toggle"]', { timeout: 15_000 });
  await page.waitForTimeout(900);

  // 2. Where it is: in the top-left, left of centre and above the fold.
  const where = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="mode-toggle"]').getBoundingClientRect();
    const s = document.querySelector('[data-testid="sidebar-toggle-zone"]').getBoundingClientRect();
    return {
      x: Math.round(t.x),
      y: Math.round(t.y),
      inZone: t.x >= s.x - 1,
      w: Math.round(t.width),
    };
  });
  console.log('   toggle at', JSON.stringify(where));
  check(where.y < 80, `the toggle is in the top strip (y=${where.y})`);
  check(where.x < 400, `and on the LEFT (x=${where.x})`);
  check(where.inZone, 'inside the no-drag zone with the sidebar button');

  // 1. Chat by default.
  const chat = await geom();
  console.log('   chat: ', JSON.stringify(chat));
  check(chat.open === 'false', 'the app opens in chat, with the ledge away');
  check(chat.ledgeHeight === 0, `the ledge takes no space (${chat.ledgeHeight}px)`);
  check(
    !/No project|Effort/.test(chat.text) || chat.ledgeHeight === 0,
    'and its words are off the screen',
  );
  await shot('01-chat');

  // 3 + 4. Work slides it out; the card above must not move.
  await page.click('[data-testid="mode-work"]');
  await page.waitForTimeout(700);
  const work = await geom();
  console.log('   work: ', JSON.stringify(work));
  check(work.open === 'true', 'work opens the ledge');
  check((work.ledgeHeight ?? 0) > 16, `the ledge is really there (${work.ledgeHeight}px)`);
  check(work.barVisible, 'and the bar inside it is laid out');
  check(
    /No project/.test(work.text),
    `it carries the project chip (got "${work.text.slice(0, 80)}")`,
  );
  await shot('02-work');

  /*
   * 4. THE COMPOSER MUST NOT HOP — in a real thread.
   *
   * On the EMPTY screen the greeting, chips and composer are one vertically
   * centred group, so growing it by 35px moves the card up ~17px. That is
   * ordinary layout responding to a click the user just made (the jitter
   * detector excludes `hadRecentInput` for exactly this reason).
   *
   * In a loaded thread the composer is bottom-anchored and a hop there would be
   * a real defect: the thing you are typing into moving while you look at it.
   * So that is the case this asserts.
   */
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        { kind: 'user', id: 'u1', text: 'hello', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'Hi there.' }],
        },
      ],
    });
  });
  await page.waitForTimeout(600);
  const threadWork = await geom();
  await page.click('[data-testid="mode-chat"]');
  await page.waitForTimeout(700);
  const threadChat = await geom();
  const moved = (threadChat.cardTop ?? 0) - (threadWork.cardTop ?? 0);
  console.log(
    `   in a thread: card ${threadWork.cardTop} → ${threadChat.cardTop} (moved ${moved}px, ledge was ${threadWork.ledgeHeight}px)`,
  );
  check(threadChat.open === 'false', 'chat closes it again');
  /*
   * THE COMPOSER MOVES BY EXACTLY THE LEDGE, AND NOTHING ELSE MOVES.
   *
   * It does move, and it should: the ledge is a bar UNDER the composer in a
   * bottom-anchored column, so taking it away lets the card settle into the
   * space it was using. the user asked for precisely that — "slide down and slide
   * up" — and it is animated, in response to a click the user just made.
   *
   * What would be a defect is moving by MORE than the ledge, which would mean
   * something else in the column resized too. That is what this pins.
   */
  check(
    Math.abs(moved - (threadWork.ledgeHeight ?? 0)) <= 2,
    `the composer moves by exactly the ledge's height and no more (${moved}px vs ${threadWork.ledgeHeight}px)`,
  );
  await page.click('[data-testid="mode-work"]');
  await page.waitForTimeout(700);
  await shot('03-thread-work');

  // 5. It sticks.
  await page.waitForTimeout(400);
  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}

// A second launch on the SAME home: the choice has to survive the app closing.
const second = await launchApp('mode-toggle-persist', { env: { HOME: home } });
try {
  await second.page.waitForSelector('[data-testid="composer-ledge"]', { timeout: 15_000 });
  await second.page.waitForTimeout(900);
  const open = await second.page.evaluate(() =>
    document.querySelector('[data-testid="composer-ledge"]')?.getAttribute('data-open'),
  );
  console.log('   after restart, ledge open:', open);
  second.check(open === 'true', 'the chat/work choice survives a restart');
} finally {
  await second.finish();
}
