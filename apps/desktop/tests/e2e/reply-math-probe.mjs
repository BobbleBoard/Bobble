/**
 * MATHS IN A REPLY, end to end — invisibly (harness.mjs).
 *
 * 1. A PRICE IS NOT A FORMULA. SEEN 2026-10-02, a Qwen 3.5 4B on "And if
 *    the bat cost $2.00 more than the ball?": "together they're $1.10, then
 *    x + (x + 2.00) = 1.10$, so 2x = -0.90" drew "1.10, thenx + …" in italic
 *    KaTeX. Streamed beside real inline maths and a reply that ENDS on a
 *    formula (which was held back as source on a finished reply).
 * 2. LATEX'S OWN DELIMITERS. `\(…\)` rendered as "(…)" and `\[…\]` as
 *    brackets round raw TeX (MEASURED 2026-10-06). A Qwen-style reply with
 *    both, streamed in chunks that end on a lone `\`, inside an open `\(`,
 *    half-way through a display, and just before a "  + b^2" line that
 *    markdown would make a list item.
 *
 * A MutationObserver keeps the TeX of every formula ever drawn and whether a
 * list item ever appeared, streamed frames included. Then a screenshot of
 * each reply to look at.
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { streamedTurn, writeFixture } from './_mock-turns.mjs';
import { APP_ROOT, launchApp } from './harness.mjs';

if (!existsSync(path.join(APP_ROOT, 'dist/index.html'))) {
  throw new Error('reply-math-probe: app is not built — run `pnpm build` first');
}

const BAT = "together they're $1.10, then x + (x + 2.00) = 1.10$, so 2x = -0.90";
// Chunk ends land right after `1.10$` and `r^2$`: a trailing `$` mid-stream.
const CURRENCY = [
  'Let the ball cost x, so the bat costs x + 2.00, and ',
  "together they're $1.10, then x + (x + 2.00) = 1.10$",
  ', so 2x = -0.90 — a negative price, so that version of the puzzle has no answer.\n\n',
  'For contrast, the area of a circle is $\\pi r^2$',
  ', which stays a formula.\n\n**Answer:** $x = -0.45$',
];
const LATEX = [
  'Use the quadratic formula. For \\',
  '(ax^2 + bx + c = 0\\',
  ') the roots are:\n\n\\[\nx = \\frac{-b \\pm',
  ' \\sqrt{b^2 - 4ac}}{2a}\n\\]\n\nA square expands to a line that starts with a plus:\n\\[\n(a + b)^2 = a^2 + 2ab\n',
  '  + b^2\n\\]\n\nOn one line, \\[ E = mc^2 \\] still displays, and `\\(code\\)` stays code.',
];
const LATEX_TEX = [
  'ax^2 + bx + c = 0',
  'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '(a + b)^2 = a^2 + 2ab\n  + b^2',
  ' E = mc^2 ',
];

const fixture = writeFixture(
  path.join(mkdtempSync(path.join(tmpdir(), 'pd-reply-math-')), 'fixture.json'),
  'reply-math',
  [
    // Long enough between chunks for each partial to paint.
    streamedTurn(CURRENCY, { stepMs: 250, match: 'bat cost' }),
    streamedTurn(LATEX, { stepMs: 250, match: 'quadratic' }),
  ],
);

const { page, shot, check, finish, shotDir } = await launchApp('reply-math', { fixture });

// Every formula ever drawn, by its TeX, and any list item — streamed frames included.
await page.evaluate(() => {
  const seen = new Set();
  const probe = { seen, li: false };
  window.__pdMath = probe;
  new MutationObserver(() => {
    for (const a of document.querySelectorAll('.pd-thread .katex annotation')) {
      seen.add(a.textContent ?? '');
    }
    if (document.querySelector('.pd-thread .pd-markdown li') !== null) probe.li = true;
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
});

/** Send `prompt`, wait for the reply to end with `last`, settle. */
async function turn(prompt, last) {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (text) => document.querySelector('.pd-thread')?.textContent?.includes(text),
    last,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1500);
}

/** The TeX of the formulas in the newest reply, and how many are displays. */
const lastReply = () =>
  page.evaluate(() => {
    const replies = document.querySelectorAll('.pd-thread .pd-markdown');
    const reply = replies[replies.length - 1];
    return {
      text: reply?.textContent ?? '',
      tex: [...(reply?.querySelectorAll('.katex annotation') ?? [])].map((a) => a.textContent),
      displays: reply?.querySelectorAll('.katex-display').length ?? -1,
      code: [...(reply?.querySelectorAll('code.pd-md-code') ?? [])].map((c) => c.textContent),
    };
  });
const seen = () =>
  page.evaluate(() => ({ tex: [...window.__pdMath.seen], li: window.__pdMath.li }));

// 1. A price is not a formula.
await turn('And if the bat cost $2.00 more than the ball?', 'which stays a formula');
const currency = await lastReply();
const seenCurrency = await seen();
console.log(JSON.stringify({ currency, seenCurrency }, null, 2));
check(currency.text.includes(BAT.slice('together '.length)), 'the price is not shown verbatim');
check(
  JSON.stringify(currency.tex) === JSON.stringify(['\\pi r^2', 'x = -0.45']),
  `the formulas drawn are ${JSON.stringify(currency.tex)}`,
);
check(
  seenCurrency.tex.every((t) => !/then|so 2x/.test(t)),
  `a streamed frame drew the price as maths: ${JSON.stringify(seenCurrency.tex)}`,
);
await page
  .locator('.pd-thread .pd-markdown')
  .last()
  .screenshot({
    path: path.join(shotDir, 'reply-currency.png'),
  });

// 2. LaTeX's own delimiters.
await turn('How do I solve a quadratic?', 'stays code');
const latex = await lastReply();
const seenAll = await seen();
console.log(JSON.stringify({ latex, seenAll }, null, 2));
check(
  JSON.stringify(latex.tex) === JSON.stringify(LATEX_TEX),
  `the LaTeX formulas drawn are ${JSON.stringify(latex.tex)}`,
);
check(latex.displays === 3, `${latex.displays} display equations, not 3`);
check(JSON.stringify(latex.code) === JSON.stringify(['\\(code\\)']), 'the code span changed');
check(!seenAll.li, 'a frame drew a list item (the "  + b^2" line read as markdown)');
check(!/\\[[(]/.test(latex.text.replace(/\\\(code\\\)/, '')), 'a raw \\( or \\[ is on screen');
await page
  .locator('.pd-thread .pd-markdown')
  .last()
  .screenshot({
    path: path.join(shotDir, 'reply-latex.png'),
  });
await shot('thread');
console.log(`shots: ${shotDir}`);
await finish();
