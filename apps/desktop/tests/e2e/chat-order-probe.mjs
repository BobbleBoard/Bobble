/**
 * DOES NEW STUFF LAND BELOW OLD STUFF? the user (2026-09-20), after trying the
 * media tools in a chat: "new stuff seems to go above old stuff in the chat
 * rather than going below the old stuff".
 *
 * Real app, real model, one chat, four turns — a plain sentence, an SVG
 * drawing (the `svg` tool + present), a chart (the `chart` tool), a plain
 * sentence again. After every turn the thread's DOM is read top to bottom:
 * each user bubble, assistant text, media card and presented card with its
 * y position and the turn it belongs to. The claim under test is that the
 * order on screen is the order of the turns, and that nothing from turn N
 * sits above anything from turn N-1. A screenshot per turn.
 *
 *   MODEL=qwen3.5-4b-mtp ENGINE=rapid-mlx/mtp SHOT_DIR=/tmp/order \
 *     node apps/desktop/tests/e2e/chat-order-probe.mjs
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ENGINE = process.env.ENGINE ?? 'rapid-mlx/mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/order';
const TURN_CAP_MS = Number(process.env.TURN_CAP_S ?? 420) * 1000;
mkdirSync(SHOT_DIR, { recursive: true });

const TURNS = [
  'Say hello in one short sentence.',
  'Draw a simple smiley face as an SVG drawing and show it to me.',
  'Here are units sold by year: 2022: 3, 2023: 5, 2024: 2. Make a bar chart of it and show me.',
  'Now tell me one short sentence about cats.',
];

const home = probeHome('chat-order');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL }, experimentalGeneration: true }, null, 2)}\n`,
);
const { app, page, check, finish } = await launchApp('chat-order', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_DESKTOP_GEN: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * The thread, top to bottom: every row that carries content, with its y and
 * a short label. `turn` is which user message it comes after (the number of
 * user bubbles at or above it), so ordering can be judged per turn.
 */
const readOrder = () =>
  page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]');
    const base = scroll?.getBoundingClientRect().top ?? 0;
    const st = scroll?.scrollTop ?? 0;
    const rows = [];
    const seen = new Set();
    const add = (el, kind, label) => {
      if (seen.has(el)) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.height === 0) return;
      rows.push({
        kind,
        label: label.slice(0, 60),
        y: Math.round(r.top - base + st),
        h: Math.round(r.height),
      });
    };
    for (const el of document.querySelectorAll('.pd-msg--user'))
      add(el, 'user', el.innerText.trim());
    for (const el of document.querySelectorAll('.pd-msg--assistant'))
      add(el, 'assistant', el.innerText.trim());
    for (const el of document.querySelectorAll('[data-testid="media-card"]'))
      add(el, 'media', 'media card');
    for (const el of document.querySelectorAll('[data-testid="presented"]'))
      add(el, 'presented', 'presented');
    for (const el of document.querySelectorAll(
      '[data-testid="presented-svg"], [data-testid="presented-chart"]',
    ))
      add(el, 'presented-item', el.getAttribute('data-testid'));
    rows.sort((a, b) => a.y - b.y);
    let turn = 0;
    for (const r of rows) {
      if (r.kind === 'user') turn += 1;
      r.turn = turn;
    }
    return {
      rows,
      scrollTop: st,
      scrollHeight: scroll?.scrollHeight ?? 0,
      clientHeight: scroll?.clientHeight ?? 0,
    };
  });

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await sleep(3000);
  log(`starting ${MODEL} on ${ENGINE}…`);
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  const [engine, spec] = ENGINE.split('/');
  const already = await page.evaluate(
    ({ engine, spec }) => {
      const s = window.__llm_store().getState().status;
      return s.profile?.engine === engine && s.profile?.spec === spec;
    },
    { engine, spec },
  );
  if (ENGINE !== 'llamacpp/none' && !already) {
    await page.evaluate(
      ({ engine, spec }) => window.__llm_store().getState().switchProfile(engine, spec),
      { engine, spec },
    );
    await page.waitForFunction(
      ({ engine, spec }) => {
        const s = window.__llm_store().getState().status;
        return s.phase === 'ready' && s.profile?.engine === engine && s.profile?.spec === spec;
      },
      { engine, spec },
      { timeout: 300_000 },
    );
  }
  const want = ENGINE.startsWith('llamacpp') ? MODEL : `${MODEL}@${engine}`;
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    want,
    { timeout: 120_000 },
  );
  await sleep(4000);
  log(`model ${want} up`);

  await page.click('[data-testid="new-chat"]').catch(() => {});
  await sleep(1500);
  /*
   * WHO MOVES THE THREAD. With DIAG=1 every programmatic scroll (scrollTop
   * setter, scrollTo/scrollBy/scrollIntoView, focus) and every scroll event on
   * the thread is logged with its stack, so a release of the stick can be
   * traced to the code that caused it.
   */
  if (process.env.DIAG === '1') {
    await page.evaluate(() => {
      const log = (window.__scrollLog = []);
      const isThread = (n) =>
        n instanceof Element && n.getAttribute('data-testid') === 'chat-scroll';
      const thread = () => document.querySelector('[data-testid="chat-scroll"]');
      const gapOf = (el) => (el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1);
      const stamp = (what, extra = '') => {
        const el = thread();
        log.push(
          `${Math.round(performance.now())} ${what} top=${el?.scrollTop} gap=${gapOf(el)} ${extra} :: ${new Error().stack?.split('\n').slice(2, 7).join(' <- ')}`,
        );
      };
      document.addEventListener(
        'scroll',
        (e) => {
          if (!isThread(e.target)) return;
          const el = e.target;
          log.push(
            `${Math.round(performance.now())} SCROLL-EVENT top=${el.scrollTop} gap=${gapOf(el)} h=${el.scrollHeight} c=${el.clientHeight} active=${document.activeElement?.tagName}.${document.activeElement?.className?.toString().slice(0, 40)}`,
          );
        },
        true,
      );
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(Element.prototype, 'scrollTop', {
        ...desc,
        set(v) {
          if (isThread(this)) stamp('SET scrollTop', `to=${v} h=${this.scrollHeight}`);
          desc.set.call(this, v);
        },
      });
      for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy']) {
        const orig = Element.prototype[name];
        Element.prototype[name] = function (...a) {
          if (thread()?.contains(this)) stamp(name, JSON.stringify(a).slice(0, 60));
          return orig.apply(this, a);
        };
      }
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...a) {
        if (thread()?.contains(this))
          stamp('FOCUS', `${this.tagName}.${this.className?.toString().slice(0, 40)}`);
        return focus.apply(this, a);
      };
    });
  }
  const orders = [];
  for (let i = 0; i < TURNS.length; i += 1) {
    const prompt = TURNS[i];
    log(`── turn ${i + 1}: ${prompt}`);
    const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(prompt);
    await page.keyboard.press('Enter');
    const t0 = Date.now();
    const ended = await page
      .waitForFunction(
        (k) => {
          const s = window.__pi_store().getState();
          const m = s.messages.slice(k);
          const replied = m.some(
            (x) =>
              x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          );
          return replied && !s.messages.some((x) => x.isStreaming) && s.promptInFlight !== true;
        },
        n,
        { timeout: TURN_CAP_MS, polling: 1000 },
      )
      .then(() => true)
      .catch(() => false);
    await sleep(5000);
    const secs = Math.round((Date.now() - t0) / 1000);
    check(ended, `turn ${i + 1} ended (${secs}s)`);
    const order = await readOrder();
    orders.push(order);
    await page.screenshot({ path: path.join(SHOT_DIR, `turn-${i + 1}.png`) });
    const msgs = await page.evaluate(
      (k) =>
        window
          .__pi_store()
          .getState()
          .messages.slice(k)
          .map(
            (m) =>
              `${m.kind}${m.kind === 'assistant' ? ':' + (m.blocks ?? []).map((b) => (b.type === 'toolCall' ? `[${b.name}]` : b.type === 'text' ? `"${b.text.slice(0, 40)}"` : b.type)).join(' ') : ''}`,
          ),
      n,
    );
    log(`store tail: ${msgs.join(' | ')}`);
    log(`screen: ${order.rows.map((r) => `${r.turn}:${r.kind}@${r.y}`).join(' ')}`);
    // THE CLAIM: every row of this turn sits below every row of earlier turns,
    // and the user bubble of this turn is the (i+1)th user bubble from the top.
    const users = order.rows.filter((r) => r.kind === 'user');
    check(users.length === i + 1, `turn ${i + 1}: ${users.length} user bubble(s) on screen`);
    const last = users[users.length - 1];
    const earlier = order.rows.filter((r) => r.turn < i + 1);
    const mine = order.rows.filter((r) => r.turn === i + 1);
    const maxEarlier = earlier.length > 0 ? Math.max(...earlier.map((r) => r.y + r.h)) : -1;
    const minMine = mine.length > 0 ? Math.min(...mine.map((r) => r.y)) : Number.POSITIVE_INFINITY;
    check(
      last !== undefined && minMine >= maxEarlier - 2,
      `turn ${i + 1}: everything new is below everything old (new from y=${minMine}, old ends y=${maxEarlier})`,
    );
    check(
      mine.some((r) => r.kind === 'assistant'),
      `turn ${i + 1}: the reply is on screen under the question`,
    );
    // And the scroll followed the new content to the foot.
    check(
      order.scrollTop + order.clientHeight >= order.scrollHeight - 40,
      `turn ${i + 1}: the thread is scrolled to its foot (${order.scrollTop}+${order.clientHeight} of ${order.scrollHeight})`,
    );
    if (process.env.DIAG === '1') {
      const lines = await page.evaluate(() => window.__scrollLog.splice(0));
      writeFileSync(path.join(SHOT_DIR, `scroll-log-turn-${i + 1}.txt`), lines.join('\n'));
      log(`scroll log: ${lines.length} lines`);
    }
  }
  writeFileSync(path.join(SHOT_DIR, 'orders.json'), JSON.stringify(orders, null, 1));
} finally {
  await finish();
}
