/**
 * EVERY WAY A PROMPT CAN BE SLOW, MEASURED IN ONE RUN.
 *
 * The user's bar: "no matter what order I press buttons in it's always clear to me
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
/* MODEL is no longer forced — the app activates its own (see waitForAppModel),
 * which is the path a person takes and the one worth measuring. MODEL2 is the
 * one the model-switch case deliberately moves TO. */
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
      // The text itself, so a change can be LOCATED rather than merely noticed —
      // where the two prompts part company is the whole difference between "the
      // tail moved" and "everything after token 40 is re-read".
      return { sys, sysLen: sys.length, tools };
    });

  let lastShape = null;
  const reportShapeChange = (name, shape) => {
    if (lastShape !== null) {
      const sysChanged = shape.sys !== lastShape.sys;
      const added = shape.tools.filter((t) => !lastShape.tools.includes(t));
      const removed = lastShape.tools.filter((t) => !shape.tools.includes(t));
      const reordered =
        added.length === 0 && removed.length === 0 && shape.tools.join() !== lastShape.tools.join();
      if (sysChanged || added.length > 0 || removed.length > 0 || reordered) {
        if (sysChanged) {
          let i = 0;
          while (
            i < Math.min(lastShape.sys.length, shape.sys.length) &&
            lastShape.sys[i] === shape.sys[i]
          )
            i++;
          console.log(
            `      system prompt diverges at char ${i} of ${lastShape.sysLen} ` +
              `(${Math.round((i / Math.max(1, lastShape.sysLen)) * 100)}% in)`,
          );
          console.log(`        was: ${JSON.stringify(lastShape.sys.slice(i, i + 140))}`);
          console.log(`        now: ${JSON.stringify(shape.sys.slice(i, i + 140))}`);
        }
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
    /*
     * DOES THE SCREEN SAY ANYTHING, at the moment of sending?
     *
     * The user's rule is "when I don't see anything I get an instant response", so a
     * route that is not instant has to be a route that was speaking. The two
     * that are not instant here — a first message sent into the app's opening
     * warm-up, and a send that waits out an attachment prime — are exactly the
     * ones this reads, and a silent slow route is a failure even at 100% reuse.
     */
    const atSend = await win
      .evaluate(() => ({
        pill: document.querySelector('[data-testid="composer-pill-text"]')?.textContent ?? null,
        /* What the composer's own prefill has been doing — the other thing that
         * can hold the slot while a send waits, and one the harness's warm
         * status knows nothing about. */
        prefill: (window.__prefill_log ?? []).slice(-4),
        priming: document.querySelector('[data-testid="composer-pill-text"]') !== null,
        /*
         * ...and whether the app had any way to KNOW this send would be slow.
         * The pill is for waits the app can see coming — a model still loading,
         * a prefix still warming. A turn that is slow for a reason nothing in
         * the app models (the server's weights paged out while the window sat
         * idle, say) is worth reporting, but it is not the app failing to speak.
         */
        knew:
          window.__pi_store().getState().extensionStatus['harness-prefix-warm'] === 'warming' ||
          window.__llm_store?.().getState().status.phase === 'starting',
      }))
      .catch(() => ({ pill: null, knew: false }));
    const pillAtSend = atSend.pill;
    const appKnew = atSend.knew;
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    /*
     * WHEN THE REQUEST LEFT THE RENDERER, as distinct from when the answer came
     * back. A turn whose prompt was 100% cached and still took seven seconds is
     * not a prefill problem, and without this the table cannot say which half of
     * the pipe it was in.
     */
    const dispatchedAt = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const inFlight = await win.evaluate(() => {
          const st = window.__pi_store().getState();
          return st.promptInFlight === true || st.agent.isStreaming === true;
        });
        if (inFlight) return Date.now();
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    })();
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
    const dispatchMs = dispatchedAt === null ? null : dispatchedAt - sentAt;
    const row = {
      case: name,
      note,
      ttft,
      dispatchMs,
      turn,
      pillAtSend,
      appKnew,
      prefill: atSend.prefill,
      samples: samples.length,
    };
    rows.push(row);
    const reused = turn === null ? null : turn.total - turn.processed;
    console.log(
      `  ${name.padEnd(24)} ${String(ttft ?? '?').padStart(7)}ms   ` +
        `reused ${String(reused ?? '?').padStart(6)} / ${String(turn?.total ?? '?').padStart(6)} tok` +
        `   (dispatch ${String(dispatchMs ?? '?')}ms)`,
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
      /*
       * SWITCH TO THE CHAT THAT HAS THE HISTORY, and say how long it took to
       * come back. The first cut clicked row 0 and waited a flat six seconds:
       * row 0 is the chat that was just created, so the case could be switching
       * to an EMPTY chat while claiming to measure a return to a long one — and
       * a flat wait cannot tell "the restore was instant and the send was slow"
       * from "the restore was still running when we typed".
       */
      const clickedAt = Date.now();
      let target = rowsEls[rowsEls.length - 1];
      for (const row of rowsEls) {
        const label = (await row.textContent()) ?? '';
        if (!/new chat/i.test(label)) {
          target = row;
          break;
        }
      }
      await target.click();
      let restoredMs = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const n = await win.evaluate(() => window.__pi_store().getState().messages.length);
        if (n > 0) {
          restoredMs = Date.now() - clickedAt;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      console.log(
        `  (the chat's messages came back ${restoredMs === null ? 'NOT AT ALL in 30s' : `in ${restoredMs}ms`})`,
      );
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

  /*
   * 6b. Hidden for the same length of time, with NO focus event on the way back.
   *
   * The pair is the experiment: `refocus` and this differ only by whether the
   * window announced its return, so if one is slow and the other is not, the
   * re-prime is the cause rather than the idle. Guessing at that from the code
   * cost me two rounds.
   */
  if (wants('hidden-no-refocus')) {
    await win.click('[data-testid="new-chat"]');
    await win.waitForTimeout(2000);
    await win.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    await win.waitForTimeout(30_000);
    // Restore the property but say NOTHING — no visibilitychange, no focus.
    await win.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
    await win.waitForTimeout(4000);
    await send('hidden-no-refocus', 'Name one river.', '30s hidden, no focus event');
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

  // 8. Sitting idle. The user's case was an hour; the default is short enough to run
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

/*
 * SLOW AND SILENT is the only failure left worth a headline.
 *
 * Every route above can be at 100% reuse and still take seconds, because the KV
 * is not the only thing that has to be ready. The user's rule does not say every
 * send is instant — it says "when I don't see anything I get an instant
 * response". So the thing to flag is a route that took long enough to notice
 * with nothing on screen explaining it.
 */
const SLOW_MS = 1500;
const quiet = rows.filter((r) => (r.ttft ?? 0) > SLOW_MS && (r.pillAtSend ?? '').length === 0);
const broke = quiet.filter((r) => r.appKnew === true);
const unforeseen = quiet.filter((r) => r.appKnew !== true);
if (broke.length === 0) {
  console.log(
    `\n  OK: every route over ${SLOW_MS}ms that the app could SEE coming said so on screen.`,
  );
} else {
  console.log('\n  SLOW AND SILENT — a wait the app knew about, with nothing on screen:');
  for (const r of broke) console.log(`    ${r.case.padEnd(26)}${r.ttft}ms`);
  process.exitCode = 1;
}
const spoke = rows.filter((r) => (r.ttft ?? 0) > SLOW_MS && (r.pillAtSend ?? '').length > 0);
if (spoke.length > 0) {
  console.log('\n  slow, and the screen said so:');
  for (const r of spoke) {
    console.log(`    ${r.case.padEnd(26)}${r.ttft}ms — ${JSON.stringify(r.pillAtSend)}`);
  }
}

if (unforeseen.length > 0) {
  console.log('\n  slow for a reason nothing in the app models (reported, not a failure):');
  for (const r of unforeseen) {
    const reused =
      r.turn === null ? '' : `${r.turn.total - r.turn.processed}/${r.turn.total} reused`;
    console.log(`    ${r.case.padEnd(26)}${r.ttft}ms   ${reused}`);
    for (const e of r.prefill ?? []) console.log(`        prefill ${JSON.stringify(e)}`);
  }
}
/*
 * ...AND THE SAME RULE READ BACKWARDS. "When I don't see anything I get an
 * instant response" is a promise in both directions: a route that IS instant
 * must have nothing on screen, or the label stops being information. This is
 * how a label left claimed by a chat that had nothing to warm was found —
 * "Getting ready · 6:56" on a send that took four seconds.
 */
const fastAndTalking = rows.filter(
  (r) => r.ttft !== null && r.ttft <= SLOW_MS && (r.pillAtSend ?? '').length > 0,
);
if (fastAndTalking.length === 0) {
  console.log(`  OK: every route under ${SLOW_MS}ms had a clear screen.`);
} else {
  console.log('\n  FAST BUT STILL TALKING — an instant send with a wait still on screen:');
  for (const r of fastAndTalking) {
    console.log(`    ${r.case.padEnd(26)}${r.ttft}ms — ${JSON.stringify(r.pillAtSend)}`);
  }
  process.exitCode = 1;
}
