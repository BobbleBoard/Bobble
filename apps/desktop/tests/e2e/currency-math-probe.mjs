/**
 * A PRICE IS NOT A FORMULA, end to end — invisibly (harness.mjs).
 *
 * SEEN 2026-10-02, a Qwen 3.5 4B on "And if the bat cost $2.00 more than the
 * ball?": "together they're $1.10, then x + (x + 2.00) = 1.10$, so 2x = -0.90"
 * drew "1.10, thenx + …" in italic KaTeX. This streams that sentence beside
 * real inline maths and a reply that ENDS on a formula, then checks:
 *   1. the sentence never renders as KaTeX — in ANY frame, streamed included
 *      (a MutationObserver keeps the TeX of every formula that ever appears);
 *   2. `$\pi r^2$` and the closing `$x = -0.45$` do (the closing one was
 *      held back as source text on a finished reply);
 *   3. a screenshot of the reply to look at.
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, launchApp } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (!existsSync(path.join(APP_ROOT, 'dist/index.html'))) {
  throw new Error('currency-math-probe: app is not built — run `pnpm build` first');
}

const BAT = "together they're $1.10, then x + (x + 2.00) = 1.10$, so 2x = -0.90";
// Chunk ends land right after `1.10$` and `r^2$`: a trailing `$` mid-stream.
const CHUNKS = [
  'Let the ball cost x, so the bat costs x + 2.00, and ',
  "together they're $1.10, then x + (x + 2.00) = 1.10$",
  ', so 2x = -0.90 — a negative price, so that version of the puzzle has no answer.\n\n',
  'For contrast, the area of a circle is $\\pi r^2$',
  ', which stays a formula.\n\n**Answer:** $x = -0.45$',
];
const REPLY = CHUNKS.join('');

/** The code-fence fixture's session, with this reply streamed in CHUNKS. */
function writeFixture() {
  const base = JSON.parse(readFileSync(path.join(HERE, 'fixtures/code-fence.json'), 'utf8'));
  const steps = base.prompts[0].steps;
  const original = steps.find((s) => s.emit.type === 'message_end').emit.message.content[0].text;
  const swap = (node) =>
    JSON.parse(
      JSON.stringify(node)
        .split(JSON.stringify(original).slice(1, -1))
        .join(JSON.stringify(REPLY).slice(1, -1)),
    );
  const head = steps.filter(
    (s) =>
      ['agent_start', 'turn_start', 'message_start'].includes(s.emit.type) ||
      s.emit.assistantMessageEvent?.type === 'text_start',
  );
  const tail = steps
    .filter(
      (s) =>
        s.emit.assistantMessageEvent?.type === 'text_end' ||
        ['message_end', 'turn_end', 'agent_end'].includes(s.emit.type),
    )
    .map(swap);
  let sofar = '';
  const deltas = CHUNKS.map((delta) => {
    sofar += delta;
    const message = { role: 'assistant', content: [{ type: 'text', text: sofar }] };
    return {
      // Long enough between chunks for each partial to paint.
      delayMs: 250,
      emit: {
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: message },
      },
    };
  });
  const fixture = {
    ...base,
    name: 'currency-math',
    prompts: [{ ...base.prompts[0], steps: [...head, ...deltas, ...tail] }],
  };
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pd-currency-math-')), 'fixture.json');
  writeFileSync(file, JSON.stringify(fixture));
  return file;
}

const { page, shot, check, finish, shotDir } = await launchApp('currency-math', {
  fixture: writeFixture(),
});

// Every formula that is ever drawn, by its TeX source, streamed frames included.
await page.evaluate(() => {
  const seen = new Set();
  window.__pdSeenTex = seen;
  const record = () => {
    for (const a of document.querySelectorAll('.pd-thread .katex annotation')) {
      seen.add(a.textContent ?? '');
    }
  };
  new MutationObserver(record).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
});

await page.click('[data-testid="composer-input"]');
await page.keyboard.type('And if the bat cost $2.00 more than the ball?');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.querySelector('.pd-thread')?.textContent?.includes('which stays a formula'),
  undefined,
  { timeout: 15000 },
);
await page.waitForTimeout(1500);

const result = await page.evaluate((bat) => {
  const paragraphs = [...document.querySelectorAll('.pd-thread .pd-markdown p')];
  const batP = paragraphs.find(
    (p) => p.textContent?.includes('they’re') || p.textContent?.includes("they're"),
  );
  const tex = (el) =>
    [...(el?.querySelectorAll('.katex annotation') ?? [])].map((a) => a.textContent);
  return {
    batText: batP?.textContent ?? null,
    batKatex: batP?.querySelectorAll('.katex').length ?? -1,
    finalTex: tex(document.querySelector('.pd-thread')),
    seenTex: [...window.__pdSeenTex],
    hasBat: batP?.textContent?.includes(bat.slice('together '.length)) ?? false,
  };
}, BAT);
console.log(JSON.stringify(result, null, 2));

check(result.batText !== null, 'the bat-and-ball paragraph is not in the thread');
check(result.batKatex === 0, `the bat-and-ball sentence rendered ${result.batKatex} KaTeX spans`);
check(result.hasBat, 'the bat-and-ball sentence is not shown verbatim, dollars and all');
check(
  JSON.stringify(result.finalTex) === JSON.stringify(['\\pi r^2', 'x = -0.45']),
  `the formulas drawn are ${JSON.stringify(result.finalTex)}`,
);
check(
  result.seenTex.every((t) => !/then|so 2x/.test(t)),
  `a streamed frame drew the price as maths: ${JSON.stringify(result.seenTex)}`,
);

const reply = page.locator('.pd-thread .pd-markdown').last();
await reply.screenshot({ path: path.join(shotDir, 'reply.png') });
await shot('thread');
console.log(`shots: ${shotDir}`);
await finish();
