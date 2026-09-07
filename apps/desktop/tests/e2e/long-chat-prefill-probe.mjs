/**
 * DOES A LONG CONVERSATION STAY CACHED?
 *
 * the user: "tell me why context is being re prefilled at each turn fully, is the
 * conversation not prefix cached in its entirety, when I type something else
 * into a follow up on a long conversation I just want to have it instantly
 * work."
 *
 * Every latency probe here so far has measured a nearly-empty chat, where the
 * prompt is ~9.7k tokens of system + tools and the conversation itself is a
 * rounding error. That cannot answer his question: a prefix can be perfectly
 * reused up to the end of the tool block and still re-read every token of the
 * conversation, and the two look identical on a short chat.
 *
 * So this builds a real conversation, turn by turn, and reports for EACH turn
 * how much of its prompt the server had to read. If the reused count stays flat
 * near the system+tools size while the prompt grows, the conversation is not
 * being cached at all — and the cost of that grows with every message.
 *
 *   TURNS=12   how many turns to build
 *   node apps/desktop/tests/e2e/long-chat-prefill-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TURNS = Number(process.env.TURNS ?? '12');
/**
 * GROW THE TRANSCRIPT FAST.
 *
 * A dozen one-line answers add ~400 tokens, which is nothing next to a ~9.7k
 * system+tools prefix — so a run like that can show a perfectly cached
 * conversation and still say nothing about the case being complained about.
 * With BIG set, each turn also carries a paste of roughly this many tokens, so
 * the transcript passes the sizes where a context policy starts making
 * decisions (compaction, truncation, a context cap) within a few turns.
 */
const BIG = Number(process.env.BIG ?? '0');
const bigBlock = (turn) =>
  Array.from(
    { length: Math.max(1, Math.round(BIG / 16)) },
    (_, i) => `Note ${turn}.${i}: the quantity surveyor logged a reading on the west manifold.`,
  ).join('\n');
const OUT = process.env.OUT ?? path.resolve(here, '../../../..', '.corp-runs', 'long-chat-prefill');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
mkdirSync(OUT, { recursive: true });

/* Prompts that produce a few sentences each — enough to grow the transcript
 * without spending a minute per turn. */
const ASKS = [
  'Name three colours, one word each.',
  'Name three fruits, one word each.',
  'Name three countries, one word each.',
  'Name three animals, one word each.',
  'Name three metals, one word each.',
  'Name three rivers, one word each.',
  'Name three instruments, one word each.',
  'Name three planets, one word each.',
  'Name three vegetables, one word each.',
  'Name three languages, one word each.',
  'Name three trees, one word each.',
  'Name three birds, one word each.',
  'Name three cities, one word each.',
  'Name three gemstones, one word each.',
  'Name three cheeses, one word each.',
  'Name three sports, one word each.',
];

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'long-chat-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', ...background.env },
});

const rows = [];
try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 90_000 });
  await win
    .waitForFunction(
      () => window.__llm_store?.().getState().status.serverRunning === true,
      undefined,
      {
        timeout: 600_000,
      },
    )
    .catch(() => undefined);
  const status = await win.evaluate(() => window.__llm_store().getState().status);
  const port = Number(/:(\d+)\/v1/.exec(status.baseUrl ?? '')?.[1] ?? 0) || null;
  console.log(`model ${status.model?.id ?? '?'} on ${port}\n`);
  if (port === null) throw new Error('no llama-server port');
  /*
   * HOW MUCH ROOM IS THERE, REALLY. A conversation that stops being cached at a
   * particular size is meeting a ceiling, and the ceiling is per-SLOT:
   * `--parallel K` divides `-c` by K, so a server started with `-c 32768` and
   * three slots gives each conversation 10,922 tokens, not 32,768.
   */
  {
    const all = await (await fetch(`http://127.0.0.1:${port}/slots`)).json();
    console.log(`  ${all.length} slot(s), n_ctx ${all[0]?.n_ctx ?? '?'} each\n`);
  }

  const slot = async () => {
    try {
      const [s] = await (await fetch(`http://127.0.0.1:${port}/slots`)).json();
      return {
        busy: s.is_processing === true,
        total: s.n_prompt_tokens ?? 0,
        processed: s.n_prompt_tokens_processed ?? 0,
      };
    } catch {
      return null;
    }
  };

  /* Let the app's opening warm-up finish before turn 1, so the first row is a
   * turn and not a queue. */
  {
    let sawBusy = false;
    let idleSince = Date.now();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const s = await slot();
      if (s !== null) {
        if (s.busy) {
          sawBusy = true;
          idleSince = Date.now();
        }
        if (!s.busy && Date.now() - idleSince > 3000) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`  (opening warm-up ${sawBusy ? 'seen and settled' : 'never seen'})\n`);
  }

  const chars = () =>
    win.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      let n = 0;
      for (const row of m) {
        if (row.kind !== 'assistant') continue;
        for (const b of row.blocks ?? []) n += (b.text ?? b.thinking ?? '').length;
      }
      return n;
    });

  const idle = () =>
    win
      .waitForFunction(
        () => {
          const s = window.__pi_store().getState();
          return s.agent.isStreaming !== true && s.promptInFlight !== true;
        },
        undefined,
        { timeout: 240_000 },
      )
      .catch(() => undefined);

  console.log('  turn   ttft      prompt    read    reused   thinking?');
  for (let i = 0; i < TURNS; i += 1) {
    const before = await chars();
    if (BIG > 0) {
      await win.evaluate(
        (text) => {
          const el = document.querySelector('[data-testid="composer-input"]');
          el?.focus();
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          el?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        },
        bigBlock(i + 1),
      );
      await win.waitForTimeout(400);
    }
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(ASKS[i % ASKS.length]);
    /* A beat, so any predictive prime for this turn can finish first — the
     * question is about the conversation's cache, not about racing our own
     * prefill. */
    await win.waitForTimeout(1500);
    const samples = [];
    let watching = true;
    const poll = (async () => {
      let last = '';
      while (watching) {
        const s = await slot();
        if (s !== null && s.total > 0) {
          const key = `${s.total}|${s.processed}`;
          if (key !== last) {
            last = key;
            samples.push({ at: Date.now(), ...s });
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    let ttft = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if ((await chars()) > before) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    watching = false;
    await poll;
    const mine = samples.filter((s) => s.at >= sentAt);
    const turn = mine.reduce(
      (a, b) => (b.total > (a?.total ?? -1) || b.processed > (a?.processed ?? -1) ? b : a),
      null,
    );
    await idle();
    /* What the composer's prefill did for THIS turn — the only way to tell
     * "the turn re-read it" from "our own prime re-read it first". */
    const prefill = await win.evaluate(() => {
      const l = window.__prefill_log ?? [];
      const out = l.slice(-3);
      window.__prefill_log = [];
      return out;
    });
    const thinking = await win.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      return m.some(
        (row) =>
          row.kind === 'assistant' &&
          (row.blocks ?? []).some((b) => b.type === 'thinking' && (b.thinking ?? '').length > 0),
      );
    });
    const reused = turn === null ? null : turn.total - turn.processed;
    rows.push({
      turn: i + 1,
      ttft,
      total: turn?.total ?? null,
      processed: turn?.processed ?? null,
      reused,
      thinking,
      prefill,
    });
    console.log(
      `  ${String(i + 1).padStart(4)}  ${String(ttft ?? '?').padStart(6)}ms  ` +
        `${String(turn?.total ?? '?').padStart(7)}  ${String(turn?.processed ?? '?').padStart(6)}  ` +
        `${String(reused ?? '?').padStart(7)}   ${thinking ? 'yes' : 'no'}`,
    );
    for (const e of prefill) console.log(`          ${JSON.stringify(e)}`);
  }

  /* ── What the numbers mean ──────────────────────────────────────────────── */
  console.log('\n──────── is the conversation cached? ────────');
  const later = rows.filter((r) => r.turn >= 3 && r.processed !== null);
  const growth = later.length >= 2 ? later[later.length - 1].total - later[0].total : 0;
  const reusedGrowth = later.length >= 2 ? later[later.length - 1].reused - later[0].reused : 0;
  console.log(`  the prompt grew by ${growth} tokens between turn 3 and turn ${rows.length}`);
  console.log(`  the REUSED part grew by ${reusedGrowth} tokens over the same stretch`);
  if (later.length >= 2) {
    const keepsUp = reusedGrowth >= growth * 0.8;
    console.log(
      keepsUp
        ? '\n  OK: the conversation is being cached — reuse grows with the transcript.'
        : `\n  THE CONVERSATION IS NOT CACHED: every turn re-reads what came before.\n` +
            `  Each turn reads ~${Math.round(later.reduce((a, r) => a + r.processed, 0) / later.length)} tokens,` +
            ' and that number grows with the conversation.',
    );
    if (!keepsUp) process.exitCode = 1;
  }
  /*
   * WHERE IT BREAKS, if it breaks. A single turn that suddenly reads most of
   * its own prompt is the signature of the prefix being rewritten underneath
   * the conversation — a compaction, a truncation, a changed tool set — and the
   * turn number tells you at what size it started happening.
   */
  const collapses = rows.filter(
    (r) => r.processed !== null && r.total > 0 && r.processed > r.total * 0.5,
  );
  if (collapses.length > 0) {
    console.log('\n  turns that re-read MOST of their own prompt:');
    for (const r of collapses) {
      console.log(
        `    turn ${String(r.turn).padStart(2)}  read ${r.processed} of ${r.total}` +
          `  (${Math.round((r.processed / r.total) * 100)}%)  ${r.ttft}ms`,
      );
    }
  }
  writeFileSync(path.join(OUT, 'long-chat.json'), JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(`long-chat-prefill-probe: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}
