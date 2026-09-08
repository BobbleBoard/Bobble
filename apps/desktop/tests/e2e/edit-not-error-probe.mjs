/**
 * A SUCCESSFUL EDIT MUST NOT READ AS A FAILURE.
 *
 * the user, with a screenshot of a `file-icon.svg` canvas tab reading `+11 −18`
 * over a slab of red: "editing/writing tool calls a lot of the time show up as
 * red."
 *
 * Nothing had failed. Both places that draw an edit built their "diff" by
 * listing every line of `old_string` as a deletion and every line of
 * `new_string` as an addition — and a str_replace edit quotes its surroundings
 * to make the match unique, so a one-line change arrived with a dozen identical
 * lines and every one of them was painted deleted-then-added.
 *
 * So this drives a REAL successful edit (a fifteen-line SVG with one attribute
 * changed) into the thread and the canvas, and asks two questions of the pixels:
 *
 *   - how many rows are tinted as removals, and
 *   - does anything on screen carry the failure treatment.
 *
 * `LEGACY=1` flips the renderer back to the old block-for-block shape
 * (`window.__pi_legacy_diff`) so the before and after come out of the same run.
 *
 * Invisible (harness.mjs).
 */
import { launchApp } from './harness.mjs';

const LEGACY = process.env.LEGACY === '1';
const TAG = LEGACY ? 'before' : 'after';

const OLD = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '  <title>File</title>',
  '  <g fill="none" stroke="currentColor" stroke-width="1.25">',
  '    <path d="M4 1.75h5.5L12.25 4.5v9.75H4z" />',
  '    <path d="M9.5 1.75v3h2.75" />',
  '    <path d="M6 8h4" />',
  '    <path d="M6 10.5h4" />',
  '  </g>',
  '</svg>',
].join('\n');
const NEW = OLD.replace('stroke-width="1.25"', 'stroke-width="1.5"').replace(
  '<path d="M6 10.5h4" />',
  '<path d="M6 10.5h2.5" />',
);

const { page, shot, check, finish } = await launchApp('edit-not-error');

await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });
if (LEGACY) {
  await page.evaluate(() => {
    window.__pi_legacy_diff = true;
  });
}

/** A completed, SUCCESSFUL `edit` call, exactly as the router shapes one. */
await page.evaluate(
  ([oldText, newText]) => {
    window.__pi_store().setState({
      messages: [
        { kind: 'user', id: 'u1', text: 'make the icon stroke a touch heavier', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: 2,
          isStreaming: false,
          blocks: [
            {
              type: 'toolCall',
              id: 'e1',
              name: 'edit',
              arguments: {
                path: '/tmp/file-icon.svg',
                old_string: oldText,
                new_string: newText,
              },
            },
          ],
        },
        {
          kind: 'toolResult',
          id: 'tr-a1-e1',
          assistantId: 'a1',
          toolCallId: 'e1',
          toolName: 'edit',
          text: 'Edited /tmp/file-icon.svg',
          isError: false,
          timestamp: 3,
        },
      ],
    });
  },
  [OLD, NEW],
);
await page.waitForTimeout(900);

// Open the chain row so the diff is on screen.
const chainRow = await page.$('[data-testid="activity-chain"] .pd-chain-step');
if (chainRow !== null) await chainRow.click().catch(() => {});
await page.waitForTimeout(700);
await shot(`${TAG}-01-thread`);

const read = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pd-diff-row')];
  const stat = document.querySelector('.pd-diff-file-header')?.textContent ?? '';
  const tint = (el) => getComputedStyle(el).backgroundColor;
  const failed = document.querySelectorAll('[data-failed="true"]').length;
  const errBlocks = document.querySelectorAll('.pd-chain-error, .pd-chain-stderr').length;
  return {
    total: rows.length,
    del: rows.filter((r) => r.classList.contains('pd-diff-row--del')).length,
    add: rows.filter((r) => r.classList.contains('pd-diff-row--add')).length,
    context: rows.filter((r) => r.classList.contains('pd-diff-row--context')).length,
    stat: stat.replace(/\s+/g, ' ').trim(),
    delTint: rows.find((r) => r.classList.contains('pd-diff-row--del'))
      ? tint(rows.find((r) => r.classList.contains('pd-diff-row--del')))
      : null,
    failed,
    errBlocks,
    chainLabel: (document.querySelector('[data-testid="activity-chain"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
  };
});
console.log(`[${TAG}] ${JSON.stringify(read, null, 2)}`);

// The diff clipped tight, so the red block is measurable rather than described.
const diff = await page.$('.pd-diff');
if (diff !== null) {
  const box = await diff.boundingBox();
  if (box !== null) {
    await page.screenshot({
      path: `${process.env.SHOT_DIR ?? '/tmp'}/${TAG}-02-diff.png`,
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: Math.min(box.height, 420),
      },
    });
  }
}

if (!LEGACY) {
  // 15 lines quoted, 2 changed. Anything more than a handful of red rows is the
  // bug this probe exists for.
  check(read.del <= 3, `a two-line edit drew ${read.del} removal rows`);
  check(read.context > 0, 'the unchanged lines are not shown as context');
  check(read.failed === 0, `a successful edit rendered ${read.failed} failed step(s)`);
  check(read.errBlocks === 0, 'a successful edit rendered an error block');
  check(/\+2/.test(read.stat) && /2/.test(read.stat), `the ±stat is wrong: "${read.stat}"`);
}

await finish();
