/**
 * A TURN THAT DID NOT FINISH — a plain account and a fix, never red text.
 *
 * the user (2026-10-08): "'The local model server returned an error. Please try
 * again.' … red text that's just a real unknown error or something that
 * doesn't have handling attached to it or can be easily done something about
 * just can't exist anymore."
 *
 * Part 1, real: the real pi, harness and provider against a scripted server
 * (_mock-openai) that answers the first ask with an HTTP 500 and the next with
 * a reply. The turn shows the problem card — what happened, Try again — and no
 * red text; Details holds the engine's words; Try again sends it again and the
 * reply arrives.
 *
 * Part 2, every kind: turns seeded with each error the engine can end a turn
 * in (memory, too long, stalled, engine gone, unknown); each card names its
 * cause and its fix, and "Choose a smaller model" opens the model menu.
 *
 *   SHOT_DIR=/tmp/turn-problem node apps/desktop/tests/e2e/turn-problem-look.mjs
 */
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = 'mock-4b@rapid-mlx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rules = [
  {
    name: 'fail-once',
    match: { lastUser: 'OOPS', stream: true },
    reply: { status: 500, error: 'mock: the engine fell over' },
    times: 1,
  },
];
const mock = await startMockOpenAI({
  model: MODEL,
  rules,
  defaultReply: { content: 'Here is your answer.' },
});
const home = probeHome('turn-problem');
writeModelsJson(home, {
  provider: 'mlx',
  api: 'mlx-stream',
  baseUrl: mock.baseUrl,
  model: MODEL,
  name: 'Mock 4B (rapid-mlx)',
});
const { page, check, shot, finish } = await launchApp('turn-problem', {
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
  timeout: 60_000,
});

const busy = () =>
  page.evaluate(() => {
    const st = window.__pi_store().getState();
    return (
      st.messages.some((m) => m.isStreaming) || st.promptInFlight === true || st.agent.isStreaming
    );
  });
async function settle(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  await sleep(800);
  while (Date.now() < end) {
    if (!(await busy())) return true;
    await sleep(250);
  }
  return false;
}
/** Red text anywhere in the thread: the thing that must not exist. */
const redInThread = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid="chat-thread"] *, main *')].filter((el) => {
        if (el.children.length > 0 || (el.textContent ?? '').trim() === '') return false;
        const c = getComputedStyle(el).color.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
        return c[0] > 180 && c[1] < 120 && c[2] < 120;
      }).length,
  );

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  check(started.pid > 0, 'pi started');
  const set = await page.evaluate(
    (m) => window.piDesktop.invoke('pi:set-model', { provider: 'mlx', modelId: m }),
    MODEL,
  );
  check(set.success === true, 'the mock model is selected');
  await page.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 20_000,
  });
  await page.click('[data-testid="new-chat"]');
  await sleep(1200);

  // ── Part 1: a real failed turn ────────────────────────────────────────────
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText('OOPS: tell me something');
  await page.keyboard.press('Enter');
  check(await settle(), 'the failing turn settles');
  await page.waitForSelector('[data-testid="turn-problem"]', { timeout: 10_000 });
  const card = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="turn-problem"]');
    return {
      kind: el?.getAttribute('data-kind'),
      text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      buttons: [...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim()),
    };
  });
  console.log('card', JSON.stringify(card));
  check(card.kind === 'engine-error', `the card names the cause (${card.kind})`);
  check(
    !/HTTP|500|mock:|fell over|"error"/.test(card.text.replace(/Details.*/, '')),
    'the engine’s words are not the message',
  );
  check(card.buttons[0] === 'Try again', `its first button is the fix (${card.buttons[0]})`);
  const red = await redInThread();
  check(red === 0, `no red text in the chat (${red})`);
  await shot('1-problem');
  await page.click('[data-testid="turn-problem-details"]');
  await sleep(300);
  const detail = await page.textContent('.pd-turn-problem-detail pre');
  check(
    /500|fell over/.test(detail ?? ''),
    `Details holds the engine's words (${detail?.slice(0, 60)})`,
  );
  await shot('2-details');
  await page.click('[data-testid="turn-fix-retry"]');
  check(await settle(), 'the retried turn settles');
  await sleep(800);
  const after = await page.evaluate(() => ({
    reply: [...document.querySelectorAll('[data-testid="chat-thread"] p, main p')]
      .map((p) => p.textContent ?? '')
      .some((t) => t.includes('Here is your answer.')),
    problems: document.querySelectorAll('[data-testid="turn-problem"]').length,
  }));
  console.log('after retry', JSON.stringify(after));
  check(after.reply, 'Try again sends it again and the answer arrives');
  check(after.problems === 0, `the fixed turn shows no problem card (${after.problems})`);
  await shot('3-retried');

  // ── Part 2: every kind ────────────────────────────────────────────────────
  const kinds = [
    [
      'memory',
      'The local model could not run ("Compute error.") — it is short of memory. Close other apps or choose a smaller model, then try again.',
    ],
    [
      'too-long',
      "This conversation is too long for the model's context window, even after trimming older tool output. Start a new chat or switch to a larger-context model.",
    ],
    [
      'stalled',
      'The model stopped responding: no output for 120s. It was cancelled and sent again, and the new attempt stalled the same way. Switching models or restarting Bobble restarts the model engine.',
    ],
    ['engine-away', 'fetch failed'],
    ['unexpected', 'TypeError: Cannot read properties of undefined (reading "x")'],
  ];
  const messages = [];
  kinds.forEach(([kind, err], i) => {
    messages.push({
      kind: 'user',
      id: `u${i}`,
      text: `Question ${i + 1} (${kind})`,
      timestamp: i * 10,
    });
    messages.push({
      kind: 'assistant',
      id: `a${i}`,
      timestamp: i * 10 + 1,
      blocks: [],
      errorMessage: err,
    });
  });
  await page.evaluate((m) => window.__pi_store().setState({ messages: m }), messages);
  await sleep(800);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="turn-problem"]')].map((el) => ({
      kind: el.getAttribute('data-kind'),
      title: el.querySelector('.pd-turn-problem-title')?.textContent,
      buttons: [...el.querySelectorAll('.pd-turn-problem-actions button')].map((b) =>
        b.textContent?.trim(),
      ),
    })),
  );
  for (const c of cards) console.log('  ', JSON.stringify(c));
  check(
    cards.map((c) => c.kind).join(',') === kinds.map(([k]) => k).join(','),
    `each error gets its own card (${cards.map((c) => c.kind).join(', ')})`,
  );
  check(
    cards.every((c) => c.buttons.length > 0),
    'every card carries a fix',
  );
  const red2 = await redInThread();
  check(red2 === 0, `still no red text (${red2})`);
  await shot('4-every-kind');
  await page.click(
    '[data-testid="turn-problem"][data-kind="memory"] [data-testid="turn-fix-smaller-model"]',
  );
  await sleep(500);
  const menu = await page.$('[data-testid="footer-model-menu"]');
  check(menu !== null, '"Choose a smaller model" opens the model menu');
  await shot('5-model-menu');
  await page.keyboard.press('Escape');
} finally {
  await finish();
  await mock.close?.();
}
