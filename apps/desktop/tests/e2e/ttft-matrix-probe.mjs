/**
 * EVERY WAY A PROMPT CAN BE SLOW, MEASURED IN ONE RUN.
 *
 * the user's bar: "no matter what order I press buttons in it's always clear to me
 * when prefill still needs to happen and when I don't see anything I get an
 * instant response … if there's been enough time to prefill for my computer
 * since the text to be prefilled has existed 100% of the time I can be sure that
 * it has been proactively prefilled."
 *
 * That is not one number, it is a matrix — and the reason TTFT keeps coming back
 * is that each fix was measured on the one path it fixed. So this drives the
 * REAL app against the REAL model through every route to a first token and
 * reports the same two facts for each:
 *
 *   ttft      wall time from Enter to the first character on screen
 *   reuse     llama-server's own account: `n_prompt_tokens` (the whole prompt)
 *             minus `n_prompt_tokens_processed` (what it actually had to read).
 *             This is the ground truth; a fast TTFT on a short prompt proves
 *             nothing, and reuse is what says whether the work was done ahead.
 *
 * (`n_prompt_tokens_cache` reads 0 regardless — do not trust it.)
 *
 * Env:
 *   MODEL       model id (default qwen3.5-4b-mtp)
 *   MODEL2      the model to switch to for the model-switch case
 *   ONLY        comma-separated case names to run
 *   IDLE_MIN    minutes for the idle case (default 6; set 60 for the user's hour)
 *   OUT         where the JSON lands
 *
 *   node apps/desktop/tests/e2e/ttft-matrix-probe.mjs
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MODEL2 = process.env.MODEL2 ?? 'gemma-4-e2b-it';
const IDLE_MIN = Number(process.env.IDLE_MIN ?? '6');
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const OUT = process.env.OUT ?? path.resolve(here, '../../../..', '.corp-runs', 'ttft-matrix');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
mkdirSync(OUT, { recursive: true });

const port = (() => {
  if (process.env.PORT !== undefined) return Number(process.env.PORT);
  try {
    const ps = execSync('ps aux | grep llama-server | grep -v grep', { encoding: 'utf8' });
    const m = /--port (\d+)/.exec(ps);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
})();

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'ttft-matrix-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', ...background.env },
});

const rows = [];
let livePort = port;

try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 90_000 });

  /*
   * LET THE APP BRING ITS OWN MODEL UP.
   *
   * The probe used to drive `pi:start` → `llm:start-server` → `pi:set-model`
   * itself, which skips the step the app does and the IPC does not: pi captures
   * the server's base URL from its ENVIRONMENT at spawn, so a child started
   * before the server has no endpoint and every turn comes back "fetch failed"
   * with four empty assistant messages. `activateLocalModel` restarts pi for
   * exactly this reason.
   *
   * Rather than reimplement that, the first model is simply the one the app
   * activates on its own — which is also the path being measured, since it is
   * the one a person takes. A SWITCH still has to be driven, and then it does
   * all three steps in the app's order.
   */
  const waitForAppModel = async () => {
    await win
      .waitForFunction(
        () => window.__llm_store?.().getState().status.serverRunning === true,
        undefined,
        { timeout: 600_000 },
      )
      .catch(() => undefined);
    const st = await win.evaluate(() => window.__llm_store().getState().status);
    console.log(`  app activated: ${st.model?.id ?? '(none)'} on ${st.baseUrl ?? '?'}`);
    if (livePort === null) {
      const m = /:(\d+)\/v1/.exec(st.baseUrl ?? '');
      livePort = m === null ? null : Number(m[1]);
    }
    return st.model?.id ?? null;
  };

  /** Switch to a DIFFERENT model, in the order the app itself uses. */
  const switchModel = async (modelId) => {
    await win.evaluate(async (id) => {
      await window.piDesktop.invoke('llm:start-server', { modelId: id });
    }, modelId);
    await win.waitForFunction(
      () => window.__llm_store?.().getState().status.serverRunning === true,
      undefined,
      { timeout: 600_000 },
    );
    await win.evaluate(async (id) => {
      // The restart is the load-bearing half — see the note above.
      await window.piDesktop.invoke('pi:restart', {});
      await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId: id });
    }, modelId);
    await win.waitForTimeout(4000);
    const st = await win.evaluate(() => window.__llm_store().getState().status);
    const m = /:(\d+)\/v1/.exec(st.baseUrl ?? '');
    if (m !== null) livePort = Number(m[1]);
  };

  /** Poll /slots and keep every distinct processing state. */
  const watch = async (ms, sink) => {
    const until = Date.now() + ms;
    let last = '';
    while (Date.now() < until) {
      try {
        const res = await fetch(`http://127.0.0.1:${livePort}/slots`);
        const slots = await res.json();
        for (const slot of slots) {
          const key = `${slot.id}|${slot.id_task}|${slot.n_prompt_tokens}|${slot.n_prompt_tokens_processed}`;
          if (key !== last && slot.n_prompt_tokens > 0) {
            last = key;
            sink.push({
              at: Date.now(),
              task: slot.id_task,
              total: slot.n_prompt_tokens,
              processed: slot.n_prompt_tokens_processed,
            });
          }
        }
      } catch {
        /* busy — keep polling */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /*
   * ALL the assistant text in the thread, not the last message's.
   *
   * The first cut read only the LAST row, so a turn that opened with a tool call
   * left a toolResult at the end and the probe reported "no first token" on a
   * turn that had answered perfectly well. Counting the whole thread means the
   * first character is the first moment the total grows, whatever else is in the
   * way.
   */
  const shape = () =>
    win.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      let chars = 0;
      for (const row of m) {
        if (row.kind !== 'assistant') continue;
        for (const b of row.blocks ?? []) chars += (b.text ?? b.thinking ?? '').length;
      }
      return { rows: m.length, chars };
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

  /*
   * WHAT THE PREFIX IS MADE OF, so a re-prefill can be attributed instead of
   * guessed at. The harness publishes the exact system prompt and tool list it
   * renders; a turn that re-reads everything did so because one of these two
   * changed, and this is the only way to see WHICH.
   */
  const prefixShape = () =>
    win.evaluate(() => {
      const st = window.__pi_store().getState().extensionStatus;
      const sys = st['harness-prefill-system'] ?? '';
      let tools = [];
      try {
        tools = JSON.parse(st['harness-prefill-tools'] ?? '[]').map((t) => t.name);
      } catch {
        tools = ['<unparseable>'];
      }
      // A cheap stable hash, enough to say "the same text" or "not".
      let h = 0;
      for (let i = 0; i < sys.length; i++) h = (h * 31 + sys.charCodeAt(i)) | 0;
      return { sysLen: sys.length, sysHash: h, tools };
    });

  let lastShape = null;
  const reportShapeChange = (name, shape) => {
    if (lastShape !== null) {
      const sysChanged = shape.sysHash !== lastShape.sysHash || shape.sysLen !== lastShape.sysLen;
      const added = shape.tools.filter((t) => !lastShape.tools.includes(t));
      const removed = lastShape.tools.filter((t) => !shape.tools.includes(t));
      const reordered =
        added.length === 0 && removed.length === 0 && shape.tools.join() !== lastShape.tools.join();
      if (sysChanged || added.length > 0 || removed.length > 0 || reordered) {
        console.log(
          `      PREFIX CHANGED before ${name}:` +
            (sysChanged ? ` system prompt (${lastShape.sysLen}→${shape.sysLen} chars)` : '') +
            (added.length > 0 ? ` +tools[${added.join(',')}]` : '') +
            (removed.length > 0 ? ` -tools[${removed.join(',')}]` : '') +
            (reordered ? ' tools reordered' : ''),
        );
      }
    }
    lastShape = shape;
  };

  /** Type a message, press Enter, and time the first character back. */
  const send = async (name, message, note) => {
    const before = await shape();
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(message);
    // The text has to actually be IN the box. A first cut measured nothing at
    // all for two cases because the keystrokes went nowhere and the numbers on
    // screen were background warm-up traffic, not turns.
    const typed = await win.evaluate(
      () => document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
    );
    if (!typed.includes(message.slice(0, 12))) {
      console.log(`  ${name.padEnd(24)} SKIPPED — the composer never received the text`);
      rows.push({ case: name, note: 'composer never received the text', ttft: null, turn: null });
      return null;
    }
    reportShapeChange(name, await prefixShape());
    // A beat so any prefill triggered by typing can start — the point of the
    // whole exercise is that this beat is when the work happens. SETTLE_MS lets
    // a run ask the question the user asks: "if I take longer to type than the model
    // takes to get ready, is it instant?"
    await win.waitForTimeout(Number(process.env.SETTLE_MS ?? '1200'));
    const samples = [];
    let watchUntil = Date.now() + 45_000;
    const watching = (async () => {
      while (Date.now() < watchUntil) await watch(200, samples);
    })();
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    let ttft = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const now = await shape();
      if (now.chars > before.chars) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    // Three more seconds of slot samples after the first token, then stop —
    // waiting out a fixed 45s per case turned a ten-case matrix into an hour.
    watchUntil = Math.min(watchUntil, Date.now() + 3000);
    await watching;
    /*
     * AN ERRORED TURN IS NOT A SLOW ONE. Without this, "fetch failed" four times
     * over reads as `?ms` in the table — indistinguishable from a model that is
     * merely taking its time, which is how a broken run got most of the way
     * through looking like a latency measurement.
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
    if (failure !== null) {
      console.log(`  ${name.padEnd(24)} ERRORED — ${failure}`);
      rows.push({ case: name, note: `errored: ${failure}`, ttft: null, turn: null });
      await idle();
      return null;
    }
    if (ttft === null) {
      const now = await shape();
      const st = await win.evaluate(() => {
        const s = window.__pi_store().getState();
        return {
          streaming: s.agent.isStreaming,
          inFlight: s.promptInFlight,
          rows: s.messages.length,
          // What the rows actually ARE — a probe that says "no first token"
          // without saying what came back instead is a probe that cannot be
          // debugged. (Costly lesson: five rows of "nothing" turned out to be
          // a shape this reducer did not know how to read.)
          shape: s.messages.map((m) =>
            m.kind === 'assistant'
              ? `assistant[${(m.blocks ?? []).map((b) => `${b.type}:${JSON.stringify(b).length}b`).join(' ')}]`
              : `${m.kind}:${JSON.stringify(m).slice(0, 60)}`,
          ),
        };
      });
      console.log(`      (no first token: ${JSON.stringify({ before, now, st })})`);
    }
    /*
     * THE TURN'S OWN SAMPLE, and its FINAL processed count.
     *
     * Two traps, both hit before this was right. The warm-up primes
     * [system][tools] — within a few dozen tokens of a short turn's whole prompt
     * — so "the biggest total" picked the warm-up half the time and reported its
     * full prefill as the turn's; only samples after Enter can belong to this
     * turn. And `n_prompt_tokens_processed` CLIMBS from zero during the ingest,
     * so a single sample can catch it at 0 and read as "reused everything" on a
     * turn that reused nothing. The answer is the LARGEST processed seen for
     * that turn's task.
     */
    const mine = samples.filter((x) => x.at >= sentAt);
    const byTask = new Map();
    for (const x of mine) {
      const prev = byTask.get(x.task);
      byTask.set(x.task, {
        task: x.task,
        total: Math.max(prev?.total ?? 0, x.total),
        processed: Math.max(prev?.processed ?? 0, x.processed),
      });
    }
    const turn = [...byTask.values()].reduce((a, b) => (b.total > (a?.total ?? -1) ? b : a), null);
    const row = { case: name, note, ttft, turn, samples: samples.length };
    rows.push(row);
    const reused = turn === null ? null : turn.total - turn.processed;
    console.log(
      `  ${name.padEnd(24)} ${String(ttft ?? '?').padStart(7)}ms   ` +
        `reused ${String(reused ?? '?').padStart(6)} / ${String(turn?.total ?? '?').padStart(6)} tok`,
    );
    await idle();
    return row;
  };

  const wants = (n) => ONLY.length === 0 || ONLY.includes(n);

  console.log('\nwaiting for the app to bring its own model up…\n');
  await waitForAppModel();
  if (livePort === null) throw new Error('no llama-server port found');
  console.log(`llama-server on ${livePort}\n`);

  // 1. The very first message after the app opened and the model loaded.
  if (wants('cold-open')) await send('cold-open', 'Say hi in three words.');

  // 2. A follow-up sent straight away — the case the user screenshotted.
  if (wants('follow-up')) await send('follow-up', 'And again, three more words.');

  // 3. A follow-up sent AFTER the post-turn work (naming/review) has had its
  //    window. If background work evicts the slot, this is where it shows.
  if (wants('follow-up-after-postturn')) {
    await win.waitForTimeout(20_000);
    await send('follow-up-after-postturn', 'Once more, three words.', 'after 20s of quiet');
  }

  // 4. Build some history, then leave and come back to it.
  if (wants('chat-switch-back')) {
    await win.evaluate(() => window.__pi_store().getState());
    await win.click('[data-testid="new-chat"]');
    await win.waitForTimeout(2500);
    const rowsEls = await win.$$('[data-testid^="chat-row-"]');
    if (rowsEls.length > 0) {
      await rowsEls[0].click();
      await win.waitForTimeout(6000); // as if reading before typing
      await send('chat-switch-back', 'Summarise this chat in one line.');
    } else {
      console.log('  chat-switch-back        (no sidebar rows — skipped)');
    }
  }

  // 5. A brand-new chat's first message.
  if (wants('new-chat')) {
    await win.click('[data-testid="new-chat"]');
    await win.waitForTimeout(3000);
    await send('new-chat', 'Name one colour.');
  }

  // 6. An attachment pasted in, then a beat, then send.
  if (wants('attachment')) {
    const blob = Array.from({ length: 400 }, (_, i) => `line ${i}: some filler prose here.`).join(
      '\n',
    );
    await win.evaluate((text) => {
      const el = document.querySelector('[data-testid="composer-input"]');
      el?.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, blob);
    await win.waitForTimeout(8000); // the prefill's window
    await send('attachment', 'How many lines was that?', 'after an 8s prefill window');
  }

  // 7. Blur the window, wait, come back — the re-prime path.
  if (wants('refocus')) {
    await win.click('[data-testid="new-chat"]');
    await win.waitForTimeout(2000);
    await win.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    await win.waitForTimeout(30_000);
    await win.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await win.waitForTimeout(4000);
    await send('refocus', 'Name one animal.', 'after 30s hidden + a 4s re-prime window');
  }

  // 8. Sitting idle. the user's case was an hour; the default is short enough to run
  //    in a normal cycle and long enough to catch anything on a timer.
  if (wants('idle')) {
    console.log(`  (idling ${IDLE_MIN} min…)`);
    await win.waitForTimeout(IDLE_MIN * 60_000);
    await send('idle', 'Name one country.', `after ${IDLE_MIN} min idle`);
  }

  // 9. Switching models — the case that CANNOT be free, and so must be warned about.
  if (wants('model-switch')) {
    await switchModel(MODEL2);
    await send('model-switch', 'Name one fruit.', `switched to ${MODEL2}`);
  }

  writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(`ttft-matrix-probe: ${err.message}\n${err.stack}`);
} finally {
  await app.close().catch(() => undefined);
}

console.log('\n──────────────── TTFT matrix ────────────────');
console.log('  case                        ttft      reused / prompt   verdict');
for (const r of rows) {
  const reused = r.turn === null ? null : r.turn.total - r.turn.processed;
  const pct =
    r.turn === null || r.turn.total === 0 ? null : Math.round((reused / r.turn.total) * 100);
  const verdict =
    pct === null ? '?' : pct >= 95 ? 'reused' : pct >= 50 ? 'PARTIAL' : 'FULL RE-PREFILL';
  console.log(
    `  ${r.case.padEnd(26)}${String(r.ttft ?? '?').padStart(6)}ms   ` +
      `${String(reused ?? '?').padStart(6)} / ${String(r.turn?.total ?? '?').padStart(6)}` +
      `  ${String(pct ?? '?').padStart(3)}%  ${verdict}${r.note ? `  (${r.note})` : ''}`,
  );
}
