/**
 * A CHART, A FAILED TURN, AND THE CHAT OPENED AGAIN — how many charts, and where?
 *
 * The user (2026-10-08): "I asked for a radar chart, it was made, then I asked about
 * something else, it failed, but then going out and back into the chat, it
 * showed two radar charts at the bottom, not where they were originally".
 *
 * Real app, real pi and harness, real `chart` command; only the model is
 * scripted (_mock-openai): the first ask calls `chart radar …` through bash and
 * answers; the second ask gets an HTTP 500. Then the probe leaves the chat (New
 * chat) and comes back through the sidebar, and counts the chart cards and the
 * user message each one stands after — before the failure, after it, and after
 * coming back. VARIANT=nofail skips the failing turn.
 *
 *   SHOT_DIR=/tmp/chart-reentry node apps/desktop/tests/e2e/chart-reentry-probe.mjs
 */
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = 'mock-4b@rapid-mlx';
const VARIANT = process.env.VARIANT ?? 'fail';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rules = [
  {
    name: 'radar',
    match: { lastUser: 'RADAR', stream: true, hasTools: true, afterTool: false },
    reply: {
      reasoning: 'A radar chart of the five skills.',
      content: '\n\n',
      toolCalls: [
        {
          name: 'bash',
          arguments: {
            command:
              'chart radar "Skills" --labels "Speed,Power,Range,Control,Stamina" --values "8,6,7,9,5"',
          },
        },
      ],
    },
  },
  {
    name: 'radar-answer',
    match: { afterTool: 'radar' },
    reply: { content: 'Here is the radar chart of your skills.' },
  },
  {
    name: 'fail',
    match: { lastUser: 'FAIL', stream: true },
    reply: { status: 500, error: 'mock: the engine fell over' },
  },
];
const mock = await startMockOpenAI({ model: MODEL, rules, defaultReply: { content: 'OK.' } });
const home = probeHome('chart-reentry');
writeModelsJson(home, {
  provider: 'mlx',
  api: 'mlx-stream',
  baseUrl: mock.baseUrl,
  model: MODEL,
  name: 'Mock 4B (rapid-mlx)',
});
const launch = () =>
  launchApp('chart-reentry', {
    env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
    timeout: 60_000,
  });
let { page, check, shot, finish } = await launch();

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
async function sendHere(text) {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}
/** Every chart card, and the last user message above it. */
const charts = (label) =>
  page.evaluate((lab) => {
    const users = [...document.querySelectorAll('[data-user-turn]')];
    const cards = [...document.querySelectorAll('[data-testid="presented-chart"]')];
    const store = window.__pi_store().getState();
    const pres = window.__present_store?.().getState();
    const file = store.session?.sessionFile ?? '';
    return {
      label: lab,
      file,
      cwd: store.session?.cwd ?? null,
      workspaceRoot: (() => {
        try {
          return JSON.parse(store.extensionStatus?.harness ?? '{}').workspaceRoot ?? null;
        } catch {
          return 'unparsable';
        }
      })(),
      messageIds: store.messages.map((m) => `${m.kind}:${m.id}`),
      toolTexts: store.messages
        .filter((m) => m.kind === 'toolResult')
        .map((m) => (m.text ?? '').slice(0, 160)),
      records: (pres?.byChat?.[file] ?? []).map((r) => ({ path: r.path, after: r.afterMessageId })),
      cards: cards.map((card) => {
        const above = users.filter(
          (u) => (u.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        );
        const last = above.at(-1);
        return {
          after: (last?.textContent ?? '(none)').trim().slice(0, 24),
          inFoot: card.closest('[data-testid="turn-foot"]') !== null,
          inChain: card.closest('.pd-chain') !== null,
        };
      }),
    };
  }, label);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  check(started.pid > 0, `pi started (${JSON.stringify(started)})`);
  const set = await page.evaluate(
    (m) => window.piDesktop.invoke('pi:set-model', { provider: 'mlx', modelId: m }),
    MODEL,
  );
  check(set.success === true, `the mock model is selected (${JSON.stringify(set)})`);
  await page.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 20_000,
  });

  await page.click('[data-testid="new-chat"]');
  await sleep(1200);
  await sendHere('RADAR: make a radar chart of my skills');
  check(await settle(), 'the radar turn settles');
  await page
    .waitForSelector('[data-testid="presented-chart"]', { timeout: 15_000 })
    .catch(() => undefined);
  await sleep(1200);
  const a = await charts('after the chart');
  console.log(JSON.stringify(a));
  await shot('1-after-chart');

  if (VARIANT === 'fail') {
    await sendHere('FAIL: what about my strengths');
    check(await settle(), 'the failing turn settles');
    await sleep(1500);
    const b = await charts('after the failure');
    console.log(JSON.stringify(b));
    await shot('2-after-failure');
  }

  // PIRESTART=1: pi restarts under the open chat (what an engine crash does).
  if (process.env.PIRESTART === '1') {
    const r = await page.evaluate(() =>
      window.piDesktop.invoke('pi:restart', {}).catch((e) => String(e)),
    );
    console.log('pi:restart', JSON.stringify(r));
    await sleep(5000);
    const d = await charts('after pi restarted');
    console.log(JSON.stringify(d));
    await shot('2b-after-pi-restart');
  }

  // Out of the chat and back in — or, VARIANT=restart, out of the app and back.
  if (process.env.RESTART === '1') {
    await finish();
    ({ page, check, shot, finish } = await launch());
    await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
    // STARTPI=1: pi up and the model set by hand (the first launch's way);
    // otherwise the app boots as it does for a person.
    if (process.env.STARTPI === '1') {
      await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
      await page.evaluate(
        (m) => window.piDesktop.invoke('pi:set-model', { provider: 'mlx', modelId: m }),
        MODEL,
      );
    }
    await sleep(2500);
  } else {
    await page.click('[data-testid="new-chat"]');
  }
  await sleep(1500);
  const rows = await page.$$eval('[data-testid^="chat-row-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid')),
  );
  console.log('sidebar rows', JSON.stringify(rows));
  const target =
    rows.find((r) => /RADAR|radar|skills/i.test(r ?? '')) ??
    rows.find((r) => r !== 'chat-row-New chat');
  check(target !== undefined, `the chart's chat is in the sidebar (${target})`);
  if (target !== undefined) {
    await page.click(`[data-testid="${target}"]`);
    await sleep(Number(process.env.SETTLE_MS ?? 3500));
  }
  const c = await charts('after coming back');
  console.log(JSON.stringify(c));
  await shot('3-after-reentry');
  check(c.cards.length === 1, `one chart after coming back (${c.cards.length})`);
  check(
    c.cards.every((k) => /RADAR/.test(k.after)),
    `it stands after the message that asked for it (${c.cards.map((k) => k.after).join(' | ')})`,
  );
} finally {
  await mock.close?.();
  await finish();
}
