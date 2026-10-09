/**
 * A DIAGRAM ASK ON THE APP'S OWN MODEL PATH, WITH ITS PREFILL ON RECORD (VQ-10).
 *
 * The user: "always be checking whenever you do chat/harness work … ensure you log
 * and check prefill times … make sure you don't introduce any reprefill
 * required bugs". A new tool is a new tool RESULT in the conversation, and the
 * turn after it is where a prefix that did not survive shows up — so this is
 * three turns, not one:
 *
 *   1. "hi"                           — the opening prefix (first-token-probe's turn)
 *   2. the §2.2.3 flow-diagram brief  — what the model reaches for, one call or many
 *   3. a follow-up about the diagram  — does the prefix after a tool turn hold
 *
 * Per user turn: the time to the first streamed character, every tool call and
 * whether it failed, the reply, and whether a diagram card landed in the thread
 * (a screenshot of it). Per REQUEST: the engine's own prompt/cached counts
 * (`[pi-diag-usage]`, PI_DIAG_PROMPTS) and the rapid-mlx `[mllm_apc]` HIT lines
 * from the app log, attributed to the turn that sent them.
 *
 * Hidden (PI_E2E background — never shown, never focused); a throwaway HOME
 * with the real model cache.
 *
 *   LOG=/tmp/dt/app.log PI_DIAG_PROMPTS=/tmp/dt/diag.txt PI_DIAG_PROMPTS_FULL=1 SHOT_DIR=/tmp/dt \
 *     node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/diagram-turn-probe.mjs
 *   EXTRA_SETTINGS='{"toolInterface":"schemas"}' …   the same three turns in schemas mode
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/diagram-turn';
const LOG = process.env.LOG ?? path.join(SHOT_DIR, 'app.log');
const DIAG = process.env.PI_DIAG_PROMPTS ?? '';
const TURN_CAP_MS = Number(process.env.TURN_CAP_S ?? 420) * 1000;
const TURNS = [
  'hi',
  readFileSync(
    new URL('../../../../tools/visual-eval/prompts/flow-diagram.txt', import.meta.url),
    'utf8',
  ).trim(),
  'Which steps can send an order back to an earlier step? One sentence.',
];
mkdirSync(SHOT_DIR, { recursive: true });

const home = probeHome('diagram-turn');
const extra = process.env.EXTRA_SETTINGS ? JSON.parse(process.env.EXTRA_SETTINGS) : {};
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    { userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL }, ...extra },
    null,
    2,
  )}\n`,
);
const { app, page, check, finish } = await launchApp('diagram-turn', {
  realCache: true,
  env: { HOME: home, PI_BIN: undefined, HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 120_000,
});
for (const s of [app.process().stderr, app.process().stdout])
  s?.on('data', (c) => appendFileSync(LOG, c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lines = (file) =>
  file !== '' && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

/** The engine's own count per request, as the diag file and the app log say it. */
function requestsSince(diagFrom, logFrom) {
  const usage = lines(DIAG)
    .slice(diagFrom)
    .map((l) => /\[pi-diag-usage\] engine=(\S+) prompt_tokens=(\S+) cached_tokens=(\S+)/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({
      engine: m[1],
      prompt: Number(m[2]),
      cached: Number(m[3]),
      computed: Number(m[2]) - Number(m[3]),
    }));
  const shapes = lines(DIAG)
    .slice(diagFrom)
    .filter((l) => l.startsWith('[pi-diag-prompt]'))
    .map((l) => /msgs=\[([^\]]*)\] tools=\[([^\]]*)\] sys=(\d+)/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({
      msgs: m[1].split(' ').length,
      tools: m[2].split(',').length,
      sys: Number(m[3]),
    }));
  const apc = lines(LOG)
    .slice(logFrom)
    .map((l) => /\[mllm_apc\].*prompt_tokens=(\d+) cached=(\d+) remaining=(\d+)/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ prompt: Number(m[1]), cached: Number(m[2]), remaining: Number(m[3]) }));
  return { usage, shapes, apc };
}

const report = { model: MODEL, extra, turns: [] };
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  report.modelId = await page.evaluate(() => window.__pi_store().getState().agent.model?.id);
  report.engine = await page.evaluate(() => {
    const s = window.__llm_store().getState().status;
    return `${s.profile?.engine ?? '?'}/${s.profile?.spec ?? '?'}`;
  });
  // The same settle first-token-probe gives the warm-up before its "hi".
  await sleep(6000);
  for (const [i, text] of TURNS.entries()) {
    const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
    const diagFrom = lines(DIAG).length;
    const logFrom = lines(LOG).length;
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.insertText(text);
    const sentAt = Date.now();
    await page.keyboard.press('Enter');
    let ttft = null;
    const deadline = Date.now() + TURN_CAP_MS;
    while (Date.now() < deadline && ttft === null) {
      const chars = await page.evaluate((k) => {
        const rows = window.__pi_store().getState().messages.slice(k);
        return rows
          .filter((r) => r.kind === 'assistant')
          .reduce(
            (sum, r) =>
              sum + (r.blocks ?? []).reduce((c, b) => c + (b.text ?? b.thinking ?? '').length, 0),
            0,
          );
      }, n);
      if (chars > 0) ttft = Date.now() - sentAt;
      else await sleep(25);
    }
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
        { timeout: Math.max(1000, deadline - Date.now()), polling: 500 },
      )
      .then(() => true)
      .catch(() => false);
    const secs = Math.round((Date.now() - sentAt) / 100) / 10;
    // The usage line of the last request lands after its stream closes.
    await sleep(2500);
    const tail = await page.evaluate((k) => {
      const s = window.__pi_store().getState();
      const m = s.messages.slice(k);
      const results = new Map();
      for (const x of m) if (x.kind === 'toolResult') results.set(x.toolCallId, x);
      const calls = [];
      for (const x of m) {
        if (x.kind !== 'assistant') continue;
        for (const b of x.blocks ?? []) {
          if (b.type !== 'toolCall') continue;
          const r = results.get(b.id);
          calls.push({
            name: b.name,
            args:
              typeof b.arguments?.command === 'string'
                ? b.arguments.command
                : JSON.stringify(b.arguments ?? {}),
            error: r?.isError === true,
            result: String(r?.text ?? '').slice(0, 400),
          });
        }
      }
      const reply = m
        .filter((x) => x.kind === 'assistant')
        .flatMap((x) => (x.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text))
        .join('\n');
      return {
        calls,
        reply,
        diagramCards: document.querySelectorAll('[data-testid="presented-diagram"]').length,
        svgCards: document.querySelectorAll('[data-testid="presented-svg"]').length,
        canvasTabs: (window.__pi_canvas?.()?.getState?.().tabs ?? []).map(
          (t) => `${t.kind}:${t.title}`,
        ),
      };
    }, n);
    const req = requestsSince(diagFrom, logFrom);
    const turn = { turn: i + 1, text, ttft, secs, ended, ...tail, requests: req };
    report.turns.push(turn);
    log(
      `turn ${i + 1}: ttft ${ttft}ms, ${secs}s, ended ${ended}, calls ${tail.calls.length}, requests ${req.usage.length}`,
    );
    for (const u of req.usage)
      log(`   request: prompt ${u.prompt}, cached ${u.cached}, computed ${u.computed}`);
    for (const c of tail.calls)
      log(`   ${c.error ? 'ERR ' : ''}${c.name}: ${c.args.slice(0, 140).replace(/\n/g, '⏎')}`);
    log(`   reply: ${tail.reply.slice(0, 200).replace(/\n/g, ' ')}`);
    await page.evaluate(() => {
      const last =
        [...document.querySelectorAll('[data-testid="presented-diagram"]')].at(-1) ??
        [...document.querySelectorAll('[data-testid="message-row"], .pd-message')].at(-1);
      last?.scrollIntoView({ block: 'center' });
    });
    await sleep(600);
    await page.screenshot({ path: path.join(SHOT_DIR, `turn-${i + 1}.png`) });
    check(ended, `turn ${i + 1} ended within ${TURN_CAP_MS / 1000}s`);
  }
} finally {
  writeFileSync(path.join(SHOT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await finish();
  rmSync(home, { recursive: true, force: true });
}
