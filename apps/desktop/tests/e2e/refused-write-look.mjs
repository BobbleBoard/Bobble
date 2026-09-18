/**
 * LOOK at a refused write and at an edit's diff. the user (2026-09-17, two
 * screenshots): a `sample.svg` write the guard refused showed "Could not write
 * the file · +88" over eighty-eight green lines ("failed what exactly?") and
 * the canvas opened a tab that set "Could not read this file" in a code editor
 * — and the diff itself should look like the reference: numbers, −/+, tinted
 * rows, syntax colour, the changed stretch emphasised; no bar, no header.
 *
 * Plays the states straight into the store (the guard's own refusal for this
 * case is fixed harness-side; the UI must still be right for every refusal)
 * and photographs: the refused row open, the edit row open, the canvas.
 *
 *   SHOT_DIR=/tmp/refused-write node apps/desktop/tests/e2e/refused-write-look.mjs
 */
import { mkdirSync } from 'node:fs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/refused-write';
mkdirSync(SHOT_DIR, { recursive: true });
const { page, check, finish } = await launchApp('refused-write', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const setTheme = async (mode) => {
  await page.evaluate(
    (mode) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};
const shot = async (label) => {
  const thread = page.locator('[data-testid="chat-scroll"]').first();
  const box = await thread.boundingBox().catch(() => null);
  if (box) await page.screenshot({ path: `${SHOT_DIR}/${label}.png`, clip: box });
  else await page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
};

const SVG = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!--',
  '  SVG File Format Examples',
  '  ------------------------',
  '  Common formatting conventions for SVG files.',
  '-->',
  '<svg',
  '  xmlns="http://www.w3.org/2000/svg"',
  '  width="200"',
  '  height="200"',
  '  viewBox="0 0 200 200">',
  '  <rect x="10" y="10" width="80" height="80" fill="#4a90d9"/>',
  '  <circle cx="150" cy="50" r="40" fill="#e94e77"/>',
  '</svg>',
].join('\n');
const REFUSAL =
  'Not written: sample.svg is hand-written SVG markup, and drawing SVGs is what the `svg` command is for — it runs OmniSVG on-device and produces a real vector drawing, not a guess at one.\n\nRun it with the bash tool, describing what to draw, and say where the file goes:\n  svg "a red heart with smooth curved edges, centered" --out sample.svg';
const OLD = 'function greet(name: string) {\n  return "Hello, " + name;\n}';
const NEW = 'function greet(name: string) {\n  return `Hello, ${name}!`;\n}';

const user = {
  kind: 'user',
  id: 'u1',
  text: 'show me how svg is generally formatted',
  timestamp: 1,
};
const writeCall = {
  type: 'toolCall',
  id: 'w1',
  name: 'write',
  arguments: { path: 'sample.svg', content: SVG },
};
const editCall = {
  type: 'toolCall',
  id: 'e1',
  name: 'edit',
  arguments: { path: '/w/greet.ts', old_string: OLD, new_string: NEW },
};
const assistant = (blocks, isStreaming) => ({
  kind: 'assistant',
  id: 'a1',
  blocks,
  timestamp: 2,
  isStreaming,
});
const result = (id, text, isError) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: id.startsWith('w') ? 'write' : 'edit',
  text,
  isError,
  timestamp: 3,
});
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pd-chain-step')].map((r) => ({
      label: r.querySelector('.pd-chain-step-label')?.textContent ?? '',
      failed: r.getAttribute('data-failed'),
      stat: r.querySelector('.pd-chain-step-diffstat')?.textContent ?? null,
      opens: r.querySelector('.pd-chain-step-open-main, .pd-chain-step-canvas') !== null,
      error: r.querySelector('.pd-chain-error-text')?.textContent?.slice(0, 40) ?? null,
      diffRows: r.querySelectorAll('.pd-diff-row').length,
      tinted: [...r.querySelectorAll('.pd-diff-row--add, .pd-diff-row--del')].filter(
        (row) => !/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(row).backgroundColor),
      ).length,
      emphRows: [...r.querySelectorAll('.pd-diff-row')].filter(
        (row) => row.querySelector('.pd-diff-emph') !== null,
      ).length,
      newFile: r.querySelector('section[data-new-file]') !== null,
      numbers: [...r.querySelectorAll('.pd-diff-gutter')].map((g) =>
        g.getAttribute('data-line-number'),
      ),
      emph: r.querySelectorAll('.pd-diff-emph').length,
      hl: r.querySelectorAll('.pd-diff-text [class^="hljs-"]').length,
      header: r.querySelector('.pd-diff-file-header') !== null,
    })),
  );
const tabs = () =>
  page.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => t.title ?? t.key),
  );

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1500);
  await setTheme('dark');
  await set({ session: { cwd: '/w' }, agent: { isStreaming: true } });

  // 1. The write streams in: the canvas opens its tab on the streamed content.
  await set({ messages: [user, assistant([writeCall], true)], runningToolCalls: ['w1'] });
  await sleep(900);
  let t = await tabs();
  // Ordinary chat routes writes into the ONE Activity tab (it morphs), not a
  // tab per file — the `sample.svg` tab in the user's screenshot came from clicking
  // the failed row, which is what the row no longer offers.
  check(t.length >= 1, `the activity tab is up while the write streams: ${JSON.stringify(t)}`);

  // 2. The tool refuses it: the tab goes, the row says why.
  await set({
    messages: [
      user,
      assistant([writeCall, editCall], false),
      result('w1', REFUSAL, true),
      result('e1', 'Successfully replaced 1 block(s) in /w/greet.ts', false),
    ],
    runningToolCalls: [],
    agent: { isStreaming: false },
  });
  await sleep(1200);
  t = await tabs();
  check(
    !t.some((x) => /sample\.svg$/.test(x)),
    `the refused write's tab is closed: ${JSON.stringify(t)}`,
  );

  // One reveal at a time (the chain is an accordion): open the refused row,
  // read + shoot; then the edit row, read + shoot.
  const openChain = async () => {
    const chain = page.locator('[data-testid="activity-chain"]').first();
    if ((await chain.getAttribute('data-expanded')) === 'false') {
      await chain.locator('.pd-chain-summary, [role="button"]').first().click();
      await sleep(500);
    }
  };
  const openRow = async (selector) => {
    await openChain();
    const row = page.locator(selector).first();
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    await sleep(700);
  };
  await openRow('.pd-chain-step[data-failed="true"] > .pd-chain-step-row');
  let r = await rows();
  await shot('1-dark-refused');
  const refused = r.find((x) => /Could not write/.test(x.label));
  check(refused !== undefined, `a refused row: ${JSON.stringify(r.map((x) => x.label))}`);
  check(
    refused?.failed === 'true' && refused?.stat === null,
    `red, and no ±stat: ${JSON.stringify(refused)}`,
  );
  check(
    refused?.opens === false,
    'a refused write does not offer to open a file that does not exist',
  );
  check(
    refused?.error?.startsWith('Not written') === true,
    `the reason leads the reveal: ${refused?.error}`,
  );
  check(
    refused?.newFile === true && refused?.tinted === 0 && refused?.diffRows === 14,
    `the content follows as a numbered listing, untinted: ${JSON.stringify({ rows: refused?.diffRows, tinted: refused?.tinted, numbers: refused?.numbers?.slice(0, 3) })}`,
  );
  check(refused?.header === false, 'no file strip over the listing');

  await openRow('.pd-chain-step[data-kind="edit"]:not([data-failed]) .pd-chain-step-disclose');
  r = await rows();
  await shot('2-dark-edit');
  const edit = r.find((x) => /Edited a file/.test(x.label));
  check(edit !== undefined, `an edit row: ${JSON.stringify(r.map((x) => x.label))}`);
  check(
    edit?.diffRows === 4 && edit?.tinted === 2,
    `the edit shows context + one del + one add: ${JSON.stringify({ rows: edit?.diffRows, tinted: edit?.tinted })}`,
  );
  check(
    edit?.emphRows === 2,
    `the changed stretch is emphasised on both rows (${edit?.emphRows} rows, ${edit?.emph} spans)`,
  );
  check((edit?.hl ?? 0) > 0, `syntax colour inside the diff (${edit?.hl} spans)`);
  check(edit?.header === false, 'no header strip on the edit');

  await setTheme('light');
  await sleep(500);
  await shot('3-light-edit');
  await openRow('.pd-chain-step[data-failed="true"] > .pd-chain-step-row');
  await shot('4-light-refused');

  // 3. A tab for a file that cannot be read: a notice, not a document. A read
  // row for a path that is gone, opened the way a person opens it — by click.
  const readCall = {
    type: 'toolCall',
    id: 'r1',
    name: 'read',
    arguments: { path: '/w/missing/report.md' },
  };
  await set({
    messages: [
      user,
      assistant([writeCall, editCall, readCall], false),
      result('w1', REFUSAL, true),
      result('e1', 'Successfully replaced 1 block(s) in /w/greet.ts', false),
      { ...result('r1', '# Report\n\nfindings…', false), toolName: 'read' },
    ],
  });
  await sleep(600);
  const readRow = page
    .locator(
      '.pd-chain-step[data-kind="read"] .pd-chain-step-open-main, .pd-chain-step[data-kind="read"] .pd-chain-step-row',
    )
    .first();
  await readRow.click().catch(() => {});
  await sleep(1800);
  const notice = await page.evaluate(() => ({
    notice: document.querySelector('.pd-file-notice') !== null,
    editorLines: document.querySelectorAll('.pd-file-body .cm-lineNumbers .cm-gutterElement')
      .length,
    toggle:
      document.querySelector('[data-testid="file-view-toggle"], .pd-canvas-view-toggle') !== null,
    title: document.querySelector('.pd-file-notice-title')?.textContent ?? null,
  }));
  await page.screenshot({ path: `${SHOT_DIR}/5-light-notice.png` });
  console.log(JSON.stringify({ rows: r, notice }, null, 1));
  check(
    notice.notice && notice.title === 'Could not read this file.',
    `an unreadable file is a notice: ${JSON.stringify(notice)}`,
  );
} finally {
  await finish();
}
