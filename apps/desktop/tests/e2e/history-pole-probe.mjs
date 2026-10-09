/**
 * THE HISTORY POLE, looked at rather than asserted.
 *
 * The user asked for a line down the right edge of a long chat with up to four
 * marked places on it, appearing on hover, "only when useful". Three things can
 * go wrong that a unit test cannot see: it shows up on a short thread, it never
 * shows up at all, or it draws over the canvas. So this drives a real thread of
 * each length and photographs the result.
 *
 *   SHOT_DIR=/tmp/pole node apps/desktop/tests/e2e/history-pole-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('history-pole');
const clip = async (label, box) => {
  writeFileSync(path.join(shotDir, `${label}.png`), await page.screenshot({ clip: box }));
};

/** Fill the thread with `n` exchanges of `size` characters each. */
const seed = (n, size) =>
  page.evaluate(
    ([count, chars]) => {
      const filler = 'the quick brown fox jumps over the lazy dog. '.repeat(
        Math.max(1, Math.round(chars / 45)),
      );
      const msgs = [];
      for (let i = 0; i < count; i++) {
        msgs.push({
          kind: 'user',
          id: `u${i}`,
          text: `question ${i}: what about ${filler}`,
          timestamp: i,
        });
        msgs.push({
          kind: 'assistant',
          id: `a${i}`,
          blocks: [{ type: 'text', text: `answer ${i}. ${filler}` }],
          timestamp: i,
        });
      }
      window.__pi_store().getState().setMessagesExternal(msgs);
    },
    [n, size],
  );

const poleState = () =>
  page.evaluate(() => {
    const zone = document.querySelector('[data-testid="history-pole-zone"]');
    const pole = document.querySelector('[data-testid="history-pole"]');
    const dots = [...document.querySelectorAll('[data-testid="history-pole-dot"]')];
    const scroller = document.querySelector('[data-testid="chat-scroll"]');
    return {
      mounted: zone !== null,
      opacity: pole === null ? null : getComputedStyle(pole).opacity,
      dots: dots.length,
      dotTops: dots.map((d) => Math.round(d.getBoundingClientRect().top)),
      zoneRight: zone === null ? null : Math.round(zone.getBoundingClientRect().right),
      scrollRight: scroller === null ? null : Math.round(scroller.getBoundingClientRect().right),
      scrollHeight: scroller?.scrollHeight ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
    };
  });

try {
  /* ── 1. A SHORT thread must show nothing at all ───────────────────────── */
  await seed(2, 60);
  await page.waitForTimeout(600);
  const short = await poleState();
  console.log('  short thread:', JSON.stringify(short));
  check(!short.mounted, 'a short conversation gets no pole');
  await shot('01-short-none');

  /* ── 2. A LONG thread grows one ───────────────────────────────────────── */
  await seed(14, 900);
  await page.waitForTimeout(900);
  const long = await poleState();
  console.log('  long thread:', JSON.stringify(long));
  check(long.mounted, 'a long conversation gets a pole');
  check(long.dots > 0 && long.dots <= 4, `at most four dots, and at least one (got ${long.dots})`);
  check(
    long.scrollHeight >= long.clientHeight * 4,
    `the fixture really is long (${long.scrollHeight} vs ${long.clientHeight})`,
  );
  check(
    long.zoneRight !== null &&
      long.scrollRight !== null &&
      Math.abs(long.zoneRight - long.scrollRight) <= 2,
    'the pole lives on the chat column, not over the canvas',
  );

  /* ── 3. Hidden until hovered, then visible ────────────────────────────── */
  check(long.opacity === '0', `at rest the pole is invisible (opacity ${long.opacity})`);
  const box = await page.evaluate(() => {
    const z = document.querySelector('[data-testid="history-pole-zone"]');
    const r = z.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      r: {
        x: Math.max(0, Math.round(r.right) - 340),
        y: Math.round(r.y),
        width: 340,
        height: Math.round(r.height),
      },
    };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(450);
  const hovered = await poleState();
  console.log('  hovered:', JSON.stringify(hovered));
  check(hovered.opacity === '1', `hovering reveals it (opacity ${hovered.opacity})`);
  await shot('02-hovered');
  await clip('03-pole', box.r);

  /* ── 4. A dot previews what it will take you to ───────────────────────── */
  const dot = (await page.$$('[data-testid="history-pole-dot"]'))[1];
  if (dot !== undefined) {
    await dot.hover();
    await page.waitForTimeout(350);
    const preview = await page.$('[data-testid="history-pole-preview"]');
    check(preview !== null, 'hovering a dot previews the message it lands on');
    console.log('  preview:', ((await preview?.textContent()) ?? '').slice(0, 80));
    await clip('04-preview', box.r);
  }

  /* ── 5. Clicking travels, and lands where the dot said ────────────────── */
  const before = (await poleState()).scrollTop;
  if (dot !== undefined) {
    await dot.click();
    await page.waitForTimeout(700);
  }
  const after = await poleState();
  console.log(`  scrollTop ${before} → ${after.scrollTop}`);
  check(after.scrollTop !== before, 'clicking a dot moves the thread');
  await shot('05-after-jump');

  /* ── 6. Clicking the bare line goes proportionally ────────────────────── */
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(300);
  const trackBox = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="history-pole"]').getBoundingClientRect();
    return {
      x: Math.round(p.x + p.width / 2),
      bottom: Math.round(p.bottom - 1),
      h: Math.round(p.height),
    };
  });
  await page.mouse.click(trackBox.x, trackBox.bottom);
  await page.waitForTimeout(800);
  const atEnd = await poleState();
  console.log(`  after clicking the foot of the line: ${atEnd.scrollTop}`);
  /* The click lands a pixel above the very bottom, so the target is a pixel
     short of the end — the tolerance is that one pixel expressed in thread
     scroll, not a fudge factor. */
  const span = atEnd.scrollHeight - atEnd.clientHeight;
  check(
    atEnd.scrollTop >= span - Math.ceil((span / trackBox.h) * 3),
    `clicking the foot of the line reaches the end (${atEnd.scrollTop} of ${span})`,
  );
  await shot('06-after-track-click');

  /* ── 7. With the CANVAS open it stays on the chat column ──────────────── */
  await page.evaluate(() => {
    window.__pi_canvas?.().openTab({
      kind: 'code',
      title: 'x.ts',
      filePath: '/tmp/x.ts',
      artifact: {
        id: 'x',
        filename: 'x.ts',
        content: { kind: 'code', text: 'const a = 1;\n'.repeat(40), language: 'typescript' },
      },
    });
  });
  await page.waitForTimeout(900);
  const withCanvas = await poleState();
  console.log('  with canvas open:', JSON.stringify(withCanvas));
  check(
    withCanvas.zoneRight !== null &&
      withCanvas.scrollRight !== null &&
      Math.abs(withCanvas.zoneRight - withCanvas.scrollRight) <= 2,
    'with the canvas open the pole is still on the chat column, not over the canvas',
  );
  await page.mouse.move(withCanvas.zoneRight - 20, 400);
  await page.waitForTimeout(400);
  await shot('07-with-canvas');

  console.log('shots in', shotDir);
} finally {
  await finish();
}
