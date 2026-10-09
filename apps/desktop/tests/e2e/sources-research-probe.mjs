/**
 * ONE REAL RESEARCH TURN — the sources UI on a real model and the real web.
 *
 * The user (2026-09-24): "source citing (for research and such, examples from
 * google search summary shown)". sources-look.mjs stages the turn; this one
 * asks for it: the app's own model path (the settings' model, like
 * first-token-probe), a throwaway HOME with the real model cache, the real
 * search backend and the real pages, hidden window, focus guard.
 *
 * It sends the question, waits for the turn to finish, and reports:
 *   - every request's prompt and cached tokens, as the engine counted them
 *     (the provider's PI_DIAG_PROMPTS usage lines) — prefill, per request;
 *   - the calls the model made, and whether its answer cited: links to pages
 *     THIS turn saw, drawn as chips;
 *   - shots: the answer, a chip's card, the Sources card folded and open, the
 *     chain reopened on its search row — dark, then the answer in light.
 *
 * It loads a model, so it runs under the HEAVY lock:
 *
 *   OUT=/tmp/sources-research node scripts/with-lock.mjs heavy -- \
 *     node apps/desktop/tests/e2e/sources-research-probe.mjs
 *
 * MODEL=<id> picks the model (default qwen3.5-4b-mtp); EXTRA_SETTINGS='{…}'
 * merges into the settings (`{"toolInterface":"schemas"}` for schemas mode).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';
import { cropPng } from './png.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const QUESTION =
  process.env.QUESTION ??
  "What's the latest on the fruit fly brain connectome? Give me a short summary with sources.";
const OUT = process.env.OUT ?? '/tmp/sources-research';
mkdirSync(OUT, { recursive: true });
const DIAG = path.join(OUT, 'prompts.log');
const LOG = path.join(OUT, 'app.log');
writeFileSync(DIAG, '');
writeFileSync(LOG, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const home = probeHome('sources-research');
const extra = process.env.EXTRA_SETTINGS ? JSON.parse(process.env.EXTRA_SETTINGS) : {};
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL }, ...extra }, null, 2)}\n`,
);

const { app, page, check, finish } = await launchApp('sources-research', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    PI_DIAG_PROMPTS: DIAG,
  },
  timeout: 120_000,
});
for (const s of [app.process().stderr, app.process().stdout])
  s?.on('data', (c) => appendFileSync(LOG, c));

const usage = () =>
  readFileSync(DIAG, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('[pi-diag-usage]'))
    .map((l) => ({
      prompt: Number(/prompt_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
      cached: Number(/cached_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
    }));
const shot = async (label) => {
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, `${label}.png`), buf);
  return buf;
};
const crop = async (label, buf, selector, pad = 16) => {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio };
  }, selector);
  if (box === null) return;
  const s = box.dpr;
  writeFileSync(
    path.join(OUT, `${label}.png`),
    cropPng(buf, {
      x: (box.x - pad) * s,
      y: (box.y - pad) * s,
      width: (box.width + pad * 2) * s,
      height: (box.height + pad * 2) * s,
    }),
  );
};
const setMode = (mode) =>
  page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), mode);
const lastAnswerSel = '[data-testid="sources-card"]';

const summary = { model: MODEL, question: QUESTION, extra };
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 600_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  summary.modelId = await page.evaluate(() => window.__pi_store().getState().agent.model?.id);
  say(`model up: ${summary.modelId}`);
  await sleep(6000); // the warm-up has the slot; a send now measures the send

  const warm = usage().length;
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(QUESTION);
  const sentAt = Date.now();
  await page.keyboard.press('Enter');

  /* The first token, then the whole turn. */
  let ttft = null;
  while (Date.now() - sentAt < 180_000) {
    const chars = await page.evaluate(() => {
      const rows = window.__pi_store().getState().messages;
      const last = rows[rows.length - 1];
      return last?.kind === 'assistant'
        ? (last.blocks ?? []).reduce((n, b) => n + (b.text ?? b.thinking ?? '').length, 0)
        : 0;
    });
    if (chars > 0) {
      ttft = Date.now() - sentAt;
      break;
    }
    await sleep(25);
  }
  summary.ttftMs = ttft;
  say(`first token ${ttft} ms`);

  let quietSince = null;
  let lastProgress = '';
  while (Date.now() - sentAt < 15 * 60_000) {
    const s = await page.evaluate(() => {
      const st = window.__pi_store().getState();
      return {
        busy: st.agent.isStreaming === true || st.promptInFlight === true,
        running: st.runningToolCalls.length,
        rows: st.messages.length,
      };
    });
    const progress = JSON.stringify(s);
    if (progress !== lastProgress) {
      lastProgress = progress;
      say('turn:', progress);
    }
    if (!s.busy && s.running === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince > 5000) break;
    } else quietSince = null;
    await sleep(1000);
  }
  summary.turnMs = Date.now() - sentAt;
  say(`turn done in ${Math.round(summary.turnMs / 1000)} s`);

  /* What it did, and what it wrote. */
  const turn = await page.evaluate(() => {
    const rows = window.__pi_store().getState().messages;
    const userAt = rows.findLastIndex((m) => m.kind === 'user');
    const mine = rows.slice(userAt + 1);
    const calls = mine
      .filter((m) => m.kind === 'assistant')
      .flatMap((m) => m.blocks.filter((b) => b.type === 'toolCall'))
      .map((b) => ({
        name: b.name,
        what: b.arguments?.command ?? b.arguments?.query ?? b.arguments?.url ?? '',
      }));
    const text = mine
      .filter((m) => m.kind === 'assistant')
      .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
      .join('\n');
    return { calls, text, errors: mine.filter((m) => m.kind === 'toolResult' && m.isError).length };
  });
  summary.calls = turn.calls;
  summary.answer = turn.text;
  summary.failedCalls = turn.errors;
  await sleep(4000); // icons and pictures land through main

  const dom = await page.evaluate(() => {
    const groups = document.querySelectorAll('.pd-msg');
    const last = groups[groups.length - 1] ?? document;
    return {
      chips: [...last.querySelectorAll('[data-testid="source-chip"]')].map((c) => ({
        label: c.getAttribute('aria-label'),
        count: Number(c.getAttribute('data-count')),
        icon: (c.querySelector('img')?.getAttribute('src') ?? '').slice(0, 10),
      })),
      links: [...last.querySelectorAll('.pd-markdown a[href]')].map((a) => a.getAttribute('href')),
      cardRows:
        document.querySelector('[data-testid="sources-card"] .pd-sources-count')?.textContent ??
        null,
      thumbs: document.querySelectorAll('[data-testid="sources-card"] img[data-role="thumb"]')
        .length,
    };
  });
  summary.dom = dom;
  summary.cited = dom.chips.length > 0;
  say(`chips ${dom.chips.length}, plain links ${dom.links.length}, sources ${dom.cardRows}`);

  /* The pictures. */
  await setMode('dark');
  await sleep(400);
  await page.evaluate(() => {
    const md = [...document.querySelectorAll('.pd-markdown')].pop();
    md?.scrollIntoView({ block: 'start' });
    document.querySelector('[data-testid="chat-scroll"]')?.scrollBy(0, -24);
  });
  await sleep(400);
  await shot('01-answer-dark');
  const chip = await page.$('[data-testid="source-chip"]');
  if (chip !== null) {
    await chip.hover();
    await page
      .waitForSelector('[data-testid="source-hovercard"]', { timeout: 4000 })
      .catch(() => undefined);
    await sleep(1500);
    const buf = await shot('02-hover-card-dark');
    await crop('02-hover-card-dark-crop', buf, '[data-testid="source-hovercard"]', 24);
    await page.mouse.move(5, 5);
    await sleep(600);
  }
  if ((await page.$(lastAnswerSel)) !== null) {
    await page.evaluate(
      (sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
      lastAnswerSel,
    );
    await sleep(500);
    let buf = await shot('03-sources-collapsed-dark');
    await crop('03-sources-collapsed-dark-crop', buf, lastAnswerSel);
    const toggle = await page.$(`${lastAnswerSel} [data-testid="sources-toggle"]`);
    if (toggle !== null) {
      await toggle.click();
      await sleep(2500);
      await page.evaluate(
        (sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }),
        lastAnswerSel,
      );
      await sleep(400);
      buf = await shot('04-sources-expanded-dark');
      await crop('04-sources-expanded-dark-crop', buf, lastAnswerSel);
      await toggle.click();
      await sleep(400);
    }
  }
  const summaryRow = await page.$('.pd-chain-summary');
  if (summaryRow !== null) {
    await summaryRow.click();
    await sleep(900);
    await page.evaluate(() =>
      document.querySelector('.pd-chain')?.scrollIntoView({ block: 'start' }),
    );
    await sleep(400);
    const buf = await shot('05-chain-dark');
    await crop('05-chain-dark-crop', buf, '.pd-chain', 12);
    await summaryRow.click();
    await sleep(400);
  }
  await setMode('light');
  await sleep(400);
  await page.evaluate(() => {
    const md = [...document.querySelectorAll('.pd-markdown')].pop();
    md?.scrollIntoView({ block: 'start' });
  });
  await sleep(400);
  await shot('06-answer-light');

  /* Prefill, per request. */
  const all = usage();
  const mine = all.slice(warm);
  summary.warmupRequests = all.slice(0, warm);
  summary.requests = mine.map((u, i) => ({
    n: i + 1,
    prompt: u.prompt,
    cached: u.cached,
    computed: u.prompt - u.cached,
  }));
  const apc = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((l) => l.includes('[mllm_apc]'));
  summary.engineApcLines = apc.slice(-40);
  console.log('\nrequest  prompt  cached  computed');
  for (const r of summary.requests) {
    console.log(
      `${String(r.n).padStart(7)}  ${String(r.prompt).padStart(6)}  ${String(r.cached).padStart(6)}  ${String(r.computed).padStart(8)}`,
    );
  }
  console.log(`\ncited: ${summary.cited} (${dom.chips.length} chips)`);
  console.log(
    `calls: ${summary.calls.map((c) => `${c.name}:${String(c.what).slice(0, 70)}`).join(' | ')}`,
  );
  check(summary.calls.length > 0, 'the model researched (made at least one call)');
} finally {
  writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await finish();
}
