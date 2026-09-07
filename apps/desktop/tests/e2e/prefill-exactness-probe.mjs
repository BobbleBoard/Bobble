/**
 * YOU WAIT FOR WHAT IS LEFT, AND NOTHING MORE.
 *
 * the user's rule for an attachment: "if the user puts in an attachment that takes
 * 20 seconds to prefill and then types for 10s, then sends, they should be
 * waiting 10 seconds for the attachment + however much else they typed, and no
 * more … if they wait more time than their message takes to prefill, they get it
 * instantly."
 *
 * That is a claim about PARTIAL work: the prime's progress has to survive the
 * send. It cannot be checked by looking at a fast case, because a fast case is
 * also what you get if the prime is thrown away and the whole prompt happens to
 * be small. So this attaches something big enough to take real seconds and sends
 * at three different points on that curve, reading llama-server's own count of
 * how many tokens it actually had to process each time.
 *
 *   TOKENS   rough size of the attachment (default 9000)
 *   node apps/desktop/tests/e2e/prefill-exactness-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = Number(process.env.TOKENS ?? '4500');
const OUT = process.env.OUT ?? path.resolve(here, '../../../..', '.corp-runs', 'prefill-exactness');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
mkdirSync(OUT, { recursive: true });

/*
 * One of these prose lines is ~16 tokens (MEASURED against the server, not
 * guessed — the first cut assumed ~9 and produced a blob that pinned the prompt
 * to the very last token of the context, so every number after it was about
 * truncation rather than about prefill). The default size leaves real headroom
 * under n_ctx, and the check below refuses to report if it does not.
 */
const PER_LINE = 16;
/*
 * A DIFFERENT BLOB PER CASE, and this is not cosmetic. The first cut sent the
 * same text three times, so by the third case the slot already held the
 * previous case's finished turn — the "no prime window" baseline came back 105ms
 * at 99.97% reuse and every comparison against it was meaningless. Each case
 * gets its own text so its baseline is genuinely cold.
 */
const blobFor = (tag) =>
  Array.from(
    { length: Math.max(20, Math.round(TOKENS / PER_LINE)) },
    (_, i) =>
      `Paragraph ${i} (${tag}): the quantity surveyor logged an unusual reading on the west manifold.`,
  ).join('\n');
const BLOB = blobFor('a');

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'prefill-exact-'))}`],
  env: {
    ...process.env,
    HOME: homedir(),
    PI_E2E: '1',
    /* Every background write to the single slot, timestamped — the only way to
     * see who landed on it between a prime and the send it was meant to serve. */
    PI_ADV_DEBUG_WARM: path.join(OUT, 'warm.log'),
    ...background.env,
  },
});

let port = null;
const rows = [];
const failures = [];
const check = (cond, msg) => {
  if (cond) {
    console.log(`  OK: ${msg}`);
    return true;
  }
  failures.push(msg);
  console.error(`  FAILED: ${msg}`);
  process.exitCode = 1;
  return false;
};

try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 90_000 });
  await win
    .waitForFunction(
      () => window.__llm_store?.().getState().status.serverRunning === true,
      undefined,
      { timeout: 600_000 },
    )
    .catch(() => undefined);
  const status = await win.evaluate(() => window.__llm_store().getState().status);
  port = Number(/:(\d+)\/v1/.exec(status.baseUrl ?? '')?.[1] ?? 0) || null;
  console.log(`model ${status.model?.id ?? '?'} on ${port}\n`);
  if (port === null) throw new Error('no llama-server port');

  const slot = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/slots`);
      const [s] = await res.json();
      return {
        busy: s.is_processing === true,
        total: s.n_prompt_tokens ?? 0,
        processed: s.n_prompt_tokens_processed ?? 0,
      };
    } catch {
      return null;
    }
  };

  /** The server's own context size — the ceiling this probe must stay under. */
  const nCtx = await (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/props`);
      const j = await res.json();
      return Number(j?.default_generation_settings?.n_ctx ?? j?.n_ctx ?? 0) || null;
    } catch {
      return null;
    }
  })();

  const paste = (text) =>
    win.evaluate((t) => {
      const el = document.querySelector('[data-testid="composer-input"]');
      el?.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, text);

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

  /** Paste the blob in as an attachment and watch the prime run to completion. */
  const attachAndTime = async () => {
    await paste(BLOB);
    const started = Date.now();
    /*
     * WAIT FOR THE SLOT TO GO QUIET AND STAY QUIET.
     *
     * At app open the harness's own warm-up is usually still running, so the
     * first busy→idle edge after a paste is ITS edge, not the prime's — and
     * "waited for the prime" then measures a send that was still queued behind
     * one. A couple of seconds of continuous quiet is the difference between
     * this case and the mid-prime case below.
     */
    let sawBusy = false;
    let peak = null;
    let idleSince = Date.now();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const s = await slot();
      if (s !== null) {
        if (s.busy) {
          sawBusy = true;
          idleSince = Date.now();
          if (s.total > (peak?.total ?? -1)) peak = s;
        }
        if (sawBusy && !s.busy && Date.now() - idleSince > 2500) break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    return { ms: Date.now() - started, sawBusy, primed: peak };
  };

  /** Type, send, and report the turn's own prefill. */
  const sendAndMeasure = async (label, note) => {
    const before = await chars();
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type('In one short sentence, what is this about?');
    /*
     * WHAT THE SLOT ALREADY SAID, before this turn asked it anything. Without
     * this the first poll after Enter records the PRIME's leftover counters and
     * the turn looks like it reused everything when it may not have run at all.
     */
    const stale = await slot();
    const staleKey = stale === null ? '' : `${stale.total}|${stale.processed}`;
    const samples = [];
    let watching = true;
    const poll = (async () => {
      let last = staleKey;
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
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if ((await chars()) > before) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    watching = false;
    await poll;

    /*
     * A TURN THAT FAILED IS NOT A SLOW TURN. Saying "?ms" for an errored send
     * is how a broken run gets read as a latency result, so name the error.
     */
    const failure = await win.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      for (let i = m.length - 1; i >= 0; i--) {
        const row = m[i];
        if (row.kind === 'assistant' && row.stopReason === 'error')
          return row.errorMessage ?? 'error';
      }
      return null;
    });
    if (ttft === null) {
      const st = await win.evaluate(() => {
        const s = window.__pi_store().getState();
        return {
          streaming: s.agent.isStreaming,
          inFlight: s.promptInFlight,
          shape: s.messages.map((m) =>
            m.kind === 'assistant'
              ? `assistant[${(m.blocks ?? []).map((b) => `${b.type}:${JSON.stringify(b).length}b`).join(' ')}]`
              : `${m.kind}:${JSON.stringify(m).slice(0, 80)}`,
          ),
        };
      });
      console.log(`      (no first token: ${JSON.stringify(st)})`);
    }

    const mine = samples.filter((s) => s.at >= sentAt);
    for (const x of mine.slice(0, 12)) {
      console.log(`      slot +${x.at - sentAt}ms  busy=${x.busy} ${x.processed}/${x.total}`);
    }
    const turn = mine.reduce(
      (a, b) => (b.total > (a?.total ?? -1) || b.processed > (a?.processed ?? -1) ? b : a),
      null,
    );
    const row = {
      label,
      note,
      ttft,
      failure,
      total: turn?.total ?? null,
      processed: turn?.processed ?? null,
    };
    rows.push(row);
    console.log(
      `  ${label.padEnd(22)} ${String(ttft ?? '?').padStart(7)}ms   processed ` +
        `${String(row.processed ?? '?').padStart(6)} of ${String(row.total ?? '?').padStart(6)}` +
        (failure === null ? '' : `   ERRORED — ${failure}`),
    );
    check(failure === null, `${label}: the turn did not error`);
    /*
     * WHAT THE COMPOSER'S PREFILL DID, in its own words. A slot number alone
     * cannot tell "we primed the wrong thing" from "we primed and something
     * overwrote it" from "we cancelled our own work on send", and those want
     * three different fixes.
     */
    const plog = await win.evaluate(() => {
      const l = window.__prefill_log ?? [];
      const out = l.slice(-20);
      window.__prefill_log = [];
      return out;
    });
    for (const e of plog) console.log(`      ${JSON.stringify(e)}`);
    await win
      .waitForFunction(
        () => {
          const s = window.__pi_store().getState();
          return s.agent.isStreaming !== true && s.promptInFlight !== true;
        },
        undefined,
        { timeout: 240_000 },
      )
      .catch(() => undefined);
    return row;
  };

  const freshChat = async () => {
    await win.click('[data-testid="new-chat"]');
    await win.waitForTimeout(2500);
  };

  /* ── How long the prime actually takes on this machine ─────────────────── */
  console.log(`measuring the prime… (~${TOKENS} tokens, ${BLOB.length} chars)`);
  const prime = await attachAndTime();
  console.log(
    `  the attachment primes in ${prime.ms}ms (busy: ${prime.sawBusy}, ` +
      `prompt ${prime.primed?.total ?? '?'} tok)\n`,
  );
  check(prime.sawBusy, 'the attachment is actually primed in the background at all');
  /*
   * A PROMPT THAT FILLS THE CONTEXT IS NOT MEASURING PREFILL. At n_ctx the
   * server starts shifting and the turn's numbers stop being about cache reuse
   * at all, so refuse to draw conclusions from a blob that big.
   */
  check(
    nCtx === null || (prime.primed?.total ?? 0) < nCtx - 1000,
    `the primed prompt leaves room under the context (${prime.primed?.total ?? '?'} of ${nCtx ?? '?'})`,
  );
  const waited = await sendAndMeasure('waited-for-prime', `after the full ${prime.ms}ms prime`);

  /* ── Sent halfway through the prime ────────────────────────────────────── */
  await freshChat();
  await paste(blobFor('b'));
  /*
   * SEND WHILE THE PRIME IS STILL RUNNING — the case the user's rule is actually
   * about. A fixed "half the first prime's duration" wait does not do it: the
   * first prime pays for the system prompt too, so the second one finishes well
   * inside that window and the case quietly becomes a second copy of
   * waited-for-prime. Watch the slot instead and press Enter while it is busy.
   */
  let sentWhileBusy = false;
  {
    const deadline = Date.now() + 60_000;
    let busySince = null;
    while (Date.now() < deadline) {
      const x = await slot();
      if (x?.busy === true) {
        busySince ??= Date.now();
        if (Date.now() - busySince > 1200) {
          sentWhileBusy = true;
          break;
        }
      } else if (busySince !== null) break; // it finished before we could
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  const half = await sendAndMeasure(
    'sent-mid-prime',
    sentWhileBusy ? 'pressed enter with the prime still running' : 'the prime finished first',
  );
  check(sentWhileBusy, 'the mid-prime case really did send while the prime was in flight');

  /* ── Sent with no prime window at all ──────────────────────────────────── */
  await freshChat();
  await paste(blobFor('c'));
  const cold = await sendAndMeasure('sent-immediately', 'no prime window');

  console.log('\n──────── does waiting buy anything? ────────');
  /*
   * The whole rule, in three comparisons. `processed` is llama-server's own
   * count of tokens it had to read — the only number that cannot be explained
   * away by a fast machine or a small prompt.
   */
  check(
    waited.processed !== null && cold.processed !== null && waited.processed < cold.processed / 2,
    `waiting for the prime more than halves the work at send (${waited.processed} vs ${cold.processed})`,
  );
  check(
    waited.ttft !== null && waited.ttft < 1500,
    `a fully primed attachment sends near-instantly (${waited.ttft}ms)`,
  );
  check(
    half.processed !== null && cold.processed !== null && half.processed < cold.processed,
    `sending mid-prime still keeps what the prime got done (${half.processed} vs ${cold.processed})`,
  );
  check(
    half.ttft !== null && cold.ttft !== null && half.ttft <= cold.ttft + 500,
    `and is no slower than not priming at all (${half.ttft}ms vs ${cold.ttft}ms)`,
  );
  writeFileSync(path.join(OUT, 'exactness.json'), JSON.stringify({ prime, rows }, null, 2));
} catch (err) {
  console.error(`prefill-exactness-probe: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}

console.log(
  failures.length === 0
    ? '\nprefill-exactness-probe OK'
    : `\nprefill-exactness-probe: ${failures.length} failure(s)`,
);
