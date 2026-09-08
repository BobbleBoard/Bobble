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
 * The BEFORE of this — nine red rows and nine green ones for a two-line change,
 * `+9 −9` in the header — was captured the same way against a build carrying
 * the old shape; the assertions below are what stops it coming back.
 *
 * Invisible (harness.mjs).
 */
import { launchApp } from './harness.mjs';

const TAG = 'edit';

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

/**
 * The edit as it arrives: a LIVE `edit` call, which is the state the user
 * photographed — the canvas tab open on the file with the hunk drawn into it.
 */
const inject = (streaming) =>
  page.evaluate(
    ([oldText, newText, live]) => {
      window.__pi_store().setState({
        messages: [
          { kind: 'user', id: 'u1', text: 'make the icon stroke a touch heavier', timestamp: 1 },
          {
            kind: 'assistant',
            id: 'a1',
            timestamp: 2,
            isStreaming: live,
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
          ...(live
            ? []
            : [
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
              ]),
        ],
      });
    },
    [OLD, NEW, streaming],
  );

await inject(true);
await page.waitForTimeout(1600);
await shot(`${TAG}-01-canvas`);

/** What the CANVAS is showing — the surface in the user's screenshot. */
const readCanvas = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="canvas-tabs-panel"]') ?? document;
    const rows = [...panel.querySelectorAll('.pd-diff-row')];
    const visible = rows.filter((r) => r.getBoundingClientRect().height > 2);
    return {
      rows: visible.length,
      del: visible.filter((r) => r.classList.contains('pd-diff-row--del')).length,
      add: visible.filter((r) => r.classList.contains('pd-diff-row--add')).length,
      context: visible.filter((r) => r.classList.contains('pd-diff-row--context')).length,
      stat: (panel.querySelector('.pd-diff-file-header')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      redPixels: visible
        .filter((r) => r.classList.contains('pd-diff-row--del'))
        .reduce((n, r) => n + r.getBoundingClientRect().height, 0),
      failed: document.querySelectorAll('[data-failed="true"]').length,
      errBlocks: document.querySelectorAll('.pd-chain-error, .pd-chain-stderr').length,
    };
  });

const live = await readCanvas();
console.log(`[${TAG}] live edit in the canvas: ${JSON.stringify(live)}`);

// …and once it has landed, nothing anywhere carries the failure treatment.
await inject(false);
await page.waitForTimeout(1400);
await shot(`${TAG}-02-settled`);
const settled = await readCanvas();
console.log(`[${TAG}] after it lands: ${JSON.stringify(settled)}`);

// Nine lines quoted, two changed.
check(live.del <= 3, `a two-line edit drew ${live.del} removal rows in the canvas`);
check(live.context > 0, 'the unchanged lines are not shown as context');
check(/\+2/.test(live.stat), `the ±stat is wrong: "${live.stat}"`);
check(live.redPixels < 60, `${live.redPixels}px of red for a two-line edit`);
check(settled.failed === 0, `a successful edit rendered ${settled.failed} failed step(s)`);
check(settled.errBlocks === 0, 'a successful edit rendered an error block');

await finish();
