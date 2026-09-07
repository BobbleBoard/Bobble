/**
 * THE PILL ABOVE THE INPUT BAR — both of the things it says, looked at.
 *
 * the user: "moving to a new chat shows this 'getting ready' thing that I'd like to
 * move to a pill that floats above the input bar we can use … both should have
 * a % bar able to be accurately made. If no % is available or able to be shown
 * ACCURATELY, then make the circle a loading spinner." And: "for images on non
 * visual model, show a yellow circle + ! on images both in chat input and when
 * sent and then show a quick pill bar … 'selected model does not support
 * images'."
 *
 * The load-bearing property, beyond the words: the pill FLOATS. It must appear
 * and disappear without moving the composer, because a status that shoves the
 * box you are typing into is the jitter this whole round is about.
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/pill node apps/desktop/tests/e2e/composer-pill-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('composer-pill');

const pill = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-pill"]');
    if (el === null) return null;
    const card = document.querySelector('.pd-composer-root');
    return {
      kind: el.getAttribute('data-kind'),
      tone: el.getAttribute('data-tone'),
      text: document.querySelector('[data-testid="composer-pill-text"]')?.textContent ?? '',
      // A spinner or a ring — never both, and never a ring without a number.
      hasSpinner: el.querySelector('.pd-spinner, [class*="spinner"]') !== null,
      hasRing: el.querySelector('svg circle') !== null,
      position: getComputedStyle(el).position,
      cardTop: card === null ? null : Math.round(card.getBoundingClientRect().top),
    };
  });

const cardTop = () =>
  page.evaluate(() => {
    const c = document.querySelector('.pd-composer-root');
    return c === null ? null : Math.round(c.getBoundingClientRect().top);
  });

const setLlm = (phase, extras = {}) =>
  page.evaluate(
    ({ phase, extras }) => {
      window
        .__llm_store()
        .getState()
        .applyStatus({
          phase,
          serverRunning: phase === 'ready',
          baseUrl: phase === 'ready' ? 'http://127.0.0.1:8080' : null,
          model:
            phase === 'ready'
              ? {
                  id: 'qwen3.5-9b-mtp',
                  displayName: 'Qwen3.5 9B (MTP)',
                  quant: 'Q4',
                  contextWindow: 65536,
                }
              : null,
          metrics: null,
          downloadedModelIds: ['qwen3.5-9b-mtp'],
          ...extras,
        });
    },
    { phase, extras },
  );

try {
  await page.waitForSelector('.pd-composer-editor', { timeout: 15_000 });
  await page.waitForTimeout(600);

  const quiet = await cardTop();
  check((await pill()) === null, 'no pill when nothing is happening');

  /* ── 1. Loading the model: a spinner, and NEVER an invented percentage ── */
  await setLlm('starting');
  await page.waitForSelector('[data-testid="composer-pill"]', { timeout: 5000 });
  const loading = await pill();
  console.log('   loading:', JSON.stringify(loading));
  check(loading?.kind === 'loading', `it says the app is starting (${loading?.text})`);
  check(/^Starting up/.test(loading?.text ?? ''), `exact words (${loading?.text})`);
  check(!/%/.test(loading?.text ?? ''), 'and no percentage, because none exists');
  check(loading?.position === 'absolute', 'the pill floats');
  check(
    loading?.cardTop === quiet,
    `the composer does not move when it appears (${quiet} → ${loading?.cardTop})`,
  );
  await shot('01-loading');

  /* ── 2. Getting ready: a spinner until a real number arrives, then a ring ── */
  await setLlm('ready');
  await page.evaluate(() => {
    window.__pi_store().setState({ extensionStatus: { 'harness-prefix-warm': 'warming' } });
  });
  await page.waitForTimeout(400);
  const preparing = await pill();
  console.log('   preparing:', JSON.stringify(preparing));
  check(preparing?.kind === 'preparing', `it says it is getting ready (${preparing?.text})`);
  check(/^Getting ready/.test(preparing?.text ?? ''), `exact words (${preparing?.text})`);
  /*
   * TWO WAITS, TWO PHRASES. They said the same words in the first cut, and the
   * tester: "I will see both of those in my first week. The moment I do, the one
   * without the number becomes a bug."
   */
  check(
    (preparing?.text ?? '') !== (loading?.text ?? ''),
    'the two boot waits do not say the same thing',
  );

  /*
   * THE CLOCK IS WHAT MAKES A SPINNER HONEST. "The spinner isn't what reassures
   * me. The changing digits are." So the number that matters here is not a
   * percentage — it is the one going up.
   */
  await page.waitForTimeout(2600);
  const ticked = await pill();
  console.log('   after 2.6s:', ticked?.text);
  check(/· \d+:\d\d$/.test(ticked?.text ?? ''), `the clock is running (${ticked?.text})`);
  check(!/%/.test(ticked?.text ?? ''), 'and still no invented percentage');
  await shot('02-getting-ready');

  /* ── 3. An image on a model that cannot read one ──────────────────────── */
  await page.evaluate(() => {
    window.__pi_store().setState({ extensionStatus: {} });
    // A text-only model, pinned: a pin is an instruction, so the app will not
    // swap — which is exactly the case the warning exists for.
    window
      .__llm_store()
      .getState()
      .applyStatus({
        phase: 'ready',
        serverRunning: true,
        baseUrl: 'http://127.0.0.1:8080',
        model: {
          id: 'ling-3.0-tiny',
          displayName: 'Ling 3.0 Tiny',
          quant: 'Q4',
          contextWindow: 32768,
        },
        metrics: null,
        downloadedModelIds: ['ling-3.0-tiny'],
        visionReady: false,
        launchMode: 'fast-text',
      });
    window
      .__settings_store?.()
      .getState?.()
      .update?.({
        modelSelection: { mode: 'model', modelId: 'ling-3.0-tiny' },
      });
  });
  await page.waitForTimeout(500);

  // A 1x1 PNG, dropped in the way the composer's own paste path would.
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  /*
   * Through the composer's own file input — the same path the + menu uses.
   * A synthetic ClipboardEvent does not reach Lexical's PASTE_COMMAND, so it
   * attached nothing and the probe was measuring an empty composer.
   */
  const png = Buffer.from(PNG.split(',')[1] ?? '', 'base64');
  const tmp = path.join(tmpdir(), `pill-probe-${Date.now()}.png`);
  writeFileSync(tmp, png);
  await page.setInputFiles('[data-testid="composer-file-input"]', tmp);
  await page.waitForTimeout(1200);

  const blind = await pill();
  console.log('   blind model:', JSON.stringify(blind));
  const badge = await page.$('[data-testid="attach-blind-badge"]');
  check(badge !== null, 'the attached image itself carries the warning mark');
  check(blind?.kind === 'no-vision', `the pill says why (${blind?.text})`);
  check(blind?.text === 'Selected model does not support images', `exact words (${blind?.text})`);
  check(blind?.tone === 'warn', 'and it is a warning, not a status');
  await shot('03-no-vision');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
