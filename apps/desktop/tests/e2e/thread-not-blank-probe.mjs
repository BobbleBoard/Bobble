/**
 * The 70 seconds the tester lost.
 *
 * "The chat froze for 70 seconds while the panel filled beautifully; the app was
 * fine and I couldn't tell. Put a line in the chat column: 'Writing your launch
 * plan in the panel →'. And auto-scroll."
 *
 * This drives the exact shape she hit — a whole-file write streaming into the
 * canvas — and asks the only question that matters: with the panel doing the
 * work, is there ANYTHING in the chat column that names it?
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/blank node apps/desktop/tests/e2e/thread-not-blank-probe.mjs
 */
import { launchApp } from './harness.mjs';

const PLAN = [
  '# Launch plan',
  '',
  '## Week 1',
  '- Confirm the roastery can hit 400 bags',
  '- Draft the announcement email',
  '',
  '## Week 2',
  '- Photograph the new packaging',
  '- Line up three local cafes',
].join('\\n');

const FULL_ARGS = `{"path":"/tmp/launch-plan.md","content":"${PLAN}"}`;

const { page, shot, check, finish, shotDir } = await launchApp('thread-not-blank');

const columnText = () =>
  page.evaluate(() => {
    const thread = document.querySelector('[data-testid="chat-scroll"]');
    return (thread?.textContent ?? '').replace(/\s+/g, ' ').trim();
  });

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('.pd-composer-editor', { timeout: 15_000 });

  const streamTo = (argsText) =>
    page.evaluate((args) => {
      window.__pi_store().setState({
        messages: [
          { kind: 'user', id: 'u1', text: 'write me a launch plan', timestamp: 1 },
          {
            kind: 'assistant',
            id: 'a1',
            timestamp: 2,
            isStreaming: true,
            blocks: [
              { type: 'toolCall', id: 'w1', name: 'write_file', arguments: {}, argsText: args },
            ],
          },
        ],
      });
    }, argsText);

  // Half-written: the canvas is filling, the model has produced no prose.
  await streamTo(FULL_ARGS.slice(0, FULL_ARGS.indexOf('## Week 2')));
  await page.waitForTimeout(1200);
  const mid = await columnText();
  console.log(`   column mid-write: "${mid.slice(0, 220)}"`);
  await shot('01-mid-write');

  check(mid.length > 0, 'the chat column is not empty while the panel fills');
  /*
   * The chain row is what names it now. The dedicated "Writing <file> in the
   * panel →" status line is gone (the user, round 21: it pinned itself to the foot
   * of the thread, its clock reset on every file, and it said nothing the row
   * above it and the open canvas were not already saying) — so the assertion is
   * on the file being named SOMEWHERE in the column, which is the thing the
   * blind tester actually asked for.
   */
  check(
    /launch-plan|writing|editing/i.test(mid),
    `the column names what is happening (got "${mid.slice(0, 120)}")`,
  );

  // And the panel really is where the work went.
  const tab = await page.evaluate(() => {
    const t = window.__pi_canvas?.().getState();
    const f = t?.tabs.find((x) => x.kind === 'file');
    return f === undefined
      ? null
      : { path: f.filePath, chars: (f.artifact?.content?.text ?? '').length };
  });
  console.log('   canvas tab:', JSON.stringify(tab));
  check(tab !== null && (tab.chars ?? 0) > 20, 'the canvas is the thing that is filling');

  await streamTo(FULL_ARGS);
  await page.waitForTimeout(800);
  console.log(`   column at end:   "${(await columnText()).slice(0, 220)}"`);
  await shot('02-written');

  /*
   * NOTHING IS PINNED TO THE FOOT OF THE THREAD any more. The panel-jump line
   * that used to live here is deleted (round 21); this asserts it stays gone,
   * because it is the kind of thing that grows back.
   */
  await streamTo(FULL_ARGS.slice(0, FULL_ARGS.indexOf('## Week 2')));
  await page.waitForTimeout(600);
  check(
    (await page.$('[data-testid="panel-work-jump"]')) === null,
    'the pinned "Writing … in the panel →" line is gone',
  );

  /* ── Auto-scroll ────────────────────────────────────────────────────────
   *
   * "And auto-scroll. Not auto-scrolling assumes I'm watching the whole time. I
   * wasn't." Tested the only way that means anything: fill the thread past its
   * own height, stream more into it, and ask whether the newest line is on
   * screen — then scroll up by hand and require that it STAYS up, because a
   * thread that drags you back down while you are reading is the other half of
   * the same complaint.
   */
  const long = (n) =>
    Array.from({ length: n }, (_, i) => ({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      id: `m${i}`,
      timestamp: i,
      ...(i % 2 === 0
        ? { text: `question number ${i}` }
        : {
            blocks: [
              {
                type: 'text',
                text: `answer number ${i}, with enough words in it to take up a line or two of the column`,
              },
            ],
          }),
    }));

  await page.evaluate((msgs) => {
    window.__pi_store().setState({ messages: msgs });
  }, long(40));
  await page.waitForTimeout(700);

  const scrollState = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-scroll"]');
      return el === null
        ? null
        : {
            fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            height: el.scrollHeight,
          };
    });

  const parked = await scrollState();
  console.log('   after loading 40 messages:', JSON.stringify(parked));
  check(
    parked !== null && parked.fromBottom < 24,
    `the thread is at the bottom (${parked?.fromBottom}px from it)`,
  );

  // More arrives while the user is not touching anything → it must follow.
  await page.evaluate((msgs) => {
    window.__pi_store().setState({ messages: msgs });
  }, long(48));
  await page.waitForTimeout(700);
  const followed = await scrollState();
  console.log('   after 8 more messages:  ', JSON.stringify(followed));
  check(
    followed !== null && followed.fromBottom < 24,
    `new content scrolls into view on its own (${followed?.fromBottom}px from the bottom)`,
  );
  check(
    followed !== null && parked !== null && followed.height > parked.height,
    'the thread really did grow',
  );
  await shot('03-autoscrolled');

  // Now the user reads back up. The stream must NOT drag them down again.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    el.scrollTop = Math.max(0, el.scrollTop - 900);
  });
  await page.waitForTimeout(300);
  const readingUp = await scrollState();
  await page.evaluate((msgs) => {
    window.__pi_store().setState({ messages: msgs });
  }, long(56));
  await page.waitForTimeout(700);
  const stillUp = await scrollState();
  console.log(
    '   scrolled up:',
    JSON.stringify(readingUp),
    '→ after more streamed:',
    JSON.stringify(stillUp),
  );
  check(
    stillUp !== null && stillUp.fromBottom > 200,
    `reading up is not yanked back down (${stillUp?.fromBottom}px from the bottom)`,
  );
  await shot('04-scrolled-up');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
