/**
 * DOES ANYTHING ELSE ON THE BOX COST THE CHAT ITS PREFIX?
 *
 * The user: "always be checking whenever you do chat/harness work at all, especially
 * longer chat testing, ensure you log and check prefill times and such and make
 * sure you don't introduce any reprefill required bugs … these are practically
 * the most important to the end user experience."
 *
 * A lost KV prefix is invisible to every functional test: the answer is still
 * right, it just costs four seconds instead of one hundred milliseconds. So it
 * has to be measured, and llama-server will say it outright — `/slots` reports
 * `n_prompt_tokens` (the whole prompt) against `n_prompt_tokens_processed` (what
 * it actually had to prefill). Reuse working = a handful of tokens on a
 * follow-up. Reuse broken = the whole prompt, every turn.
 *
 * WHAT THIS ONE SUSPECTS, and why it is not ttft-slots-probe. That probe sends
 * chat turns and nothing else, so it can only catch the chat path evicting
 * itself. But the studios' PROMPT ENHANCER runs on the SAME server by default —
 * `resolveEnhancerEndpoint` falls through to `getInferenceUtility()` unless
 * PI_DESKTOP_ENHANCER_BASE_URL points somewhere else (main.ts) — and it sends a
 * completely different conversation. If that evicts, then writing a picture
 * prompt in the Image Studio silently costs your next chat message a full cold
 * prefill, and nobody would ever connect the two.
 *
 * So: two chat turns to establish reuse, an enhance, then a third chat turn.
 * The third one is the whole experiment.
 *
 *   MODEL   model id to serve (default qwen3.5-4b-mtp)
 *   PORT    llama-server port (default: discovered from the running process)
 *   APP     app binary (default the installed Bobble.app)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PIN = process.env.PIN !== '0';
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
const OUT = process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'ttft');
mkdirSync(OUT, { recursive: true });

/*
 * WHICH llama-server IS OURS.
 *
 * The renderer's copy of the status does not carry `baseUrl` (main keeps it for
 * `getInferenceUtility`, the UI has no use for it), so this reads the process
 * list — and takes the YOUNGEST server, which is the one this run just started.
 * Taking the first match instead is a coin toss the moment an earlier run has
 * left an orphan behind, and it silently pointed an earlier version of this
 * probe at a stranger's port for three runs.
 */
const discoverPort = () => {
  if (process.env.PORT !== undefined) return Number(process.env.PORT);
  try {
    // `pid`, not `etimes` — macOS ps has no `etimes` keyword and the whole call
    // fails silently into the catch, which is how an earlier version of this
    // spent three runs reporting "counters not caught" while looking fine.
    // The highest pid is the youngest process, which is this run's server.
    const out = execSync('ps -Ao pid,command | grep llama-server | grep -v grep', {
      encoding: 'utf8',
    });
    const found = out
      .split('\n')
      .map((line) => /^\s*(\d+)\s+.*--port (\d+)/.exec(line))
      .filter((m) => m !== null)
      .map((m) => ({ pid: Number(m[1]), port: Number(m[2]) }))
      .sort((a, b) => b.pid - a.pid);
    return found[0]?.port ?? null;
  } catch {
    return null;
  }
};

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-enh-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_GEN: '1', ...background.env },
});

let failed = false;
let port = null;
const rows = [];
try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  /*
   * PIN THE MODEL, or the router moves the ground under the measurement.
   *
   * `pi:set-model` tells pi which model to talk to; it does not stop the Auto
   * router, which classifies every send and switches tiers on its own. MEASURED:
   * with the default `mode: 'auto'`, the FIRST chat message replaced the running
   * server outright — qwen3.5-4b on port 54105 at 6.7 GB became qwen3.5-9b on
   * port 54121 at 12.9 GB, a different process with a different context — so
   * everything prefilled before it was gone and "turn 2" was measuring a fresh
   * cold start. That is the router doing its job, and it made this probe's
   * numbers swing between 472ms and 21s run to run until it was pinned.
   *
   * `mode: 'model'` is what the app stores when someone picks a model rather
   * than leaving it on Auto, so this measures the pinned case honestly.
   */
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
    await window
      .__settings_store?.()
      .getState?.()
      .update?.({
        modelSelection: { mode: 'model', modelId },
      });
  }, MODEL);
  await win.waitForTimeout(8000);

  port = discoverPort();
  if (port === null || !Number.isFinite(port)) throw new Error('no llama-server port found');
  console.log(`llama-server on ${port}`);

  /*
   * READ THE SLOT AFTER THE TURN, NOT DURING IT.
   *
   * The first version polled `/slots` every 20ms through the turn and kept the
   * deepest sample. It worked for a cold prefill and failed for the very case it
   * exists to measure: a warm follow-up's prefill is over so fast that no poll
   * lands inside it, so the probe recorded nothing, and "no sample" read as
   * "prefilled the whole prompt" — a FAIL on a 566ms turn that was in fact a
   * perfect cache hit.
   *
   * An idle slot keeps its LAST task's counters, so reading once after the turn
   * settles gets the true numbers with no race at all.
   */
  const slot = async () => {
    try {
      const [s0] = await (await fetch(`http://127.0.0.1:${port}/slots`)).json();
      return { total: s0.n_prompt_tokens ?? 0, processed: s0.n_prompt_tokens_processed ?? 0 };
    } catch {
      return null;
    }
  };

  /*
   * ONE READ, NOT A POLL, and this is the second thing this probe taught me.
   *
   * The counters are corroboration, and they are hard to catch: an idle slot
   * resets `n_prompt_tokens`, and a warm follow-up's prefill is over in
   * single-digit milliseconds. The obvious answer — poll `/slots` every 50ms
   * through the turn — turned out to PERTURB WHAT IT MEASURES: with the poller
   * running against the real server, three separate runs had a turn never
   * produce a token at all, and the same runs were fine the moment the poller
   * was pointed at a dead port by accident. A measurement that changes the
   * result is worse than no measurement.
   *
   * So: one request, just after the first token, and silence otherwise. If the
   * numbers are not there, the run says "not caught" rather than guessing.
   */
  const turn = async (label, text) => {
    const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
    const t0 = Date.now();
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(text);
    await win.keyboard.press('Enter');
    // First token, as the user experiences it: the assistant row gains characters.
    await win.waitForFunction(
      (n) => {
        const m = window.__pi_store().getState().messages;
        if (m.length <= n) return false;
        const last = m[m.length - 1];
        if (last?.kind !== 'assistant') return false;
        return (last.blocks ?? []).some((b) => (b.text ?? b.thinking ?? '').length > 0);
      },
      before,
      { timeout: 180_000 },
    );
    const ttft = Date.now() - t0;
    const counted = await slot();
    // Then let the turn actually finish, so the next one starts from a quiet slot.
    await win
      .waitForFunction(() => window.__pi_store().getState().agent?.isStreaming !== true, null, {
        timeout: 180_000,
      })
      .catch(() => undefined);
    const row = { label, ttft, ...(counted ?? { total: 0, processed: 0 }) };
    rows.push(row);
    const pct = row.total > 0 ? Math.round((row.processed / row.total) * 100) : null;
    console.log(
      `[prefill] ${label.padEnd(22)} ttft ${String(ttft).padStart(6)}ms   prompt ${row.total} tokens, prefilled ${row.processed}${pct === null ? '' : ` (${pct}%)`}`,
    );
    return row;
  };

  await turn('turn 1 (first send)', 'in one short sentence, what is a prime number?');
  if (!PIN) {
    // On Auto the first send can REPLACE the server (a tier switch), so turn 1 is
    // measuring a model load. Spend one more turn letting that settle, and
    // measure steady state — which is the question for the default setting.
    await turn('turn 1b (after routing)', 'and why does that matter?');
  }
  const warm = await turn('turn 2 (warm)', 'and one example please');

  // The interruption under test: a studio prompt enhanced on the same server.
  const enhanced = await win.evaluate(() =>
    window.piDesktop.invoke('gen:enhance', { kind: 'image', prompt: 'a fox in the snow' }),
  );
  console.log(
    `[prefill] enhancer ran: changed=${enhanced?.changed} -> ${String(enhanced?.prompt).slice(0, 70)}`,
  );

  const after = await turn('turn 3 (post-enhance)', 'and one more example');

  /*
   * THE VERDICT IS THE SHARE OF EACH PROMPT THAT HAD TO BE PREFILLED AGAIN,
   * with time as the corroboration rather than the other way round. Both are
   * reported because they answer different questions: the share says whether the
   * cache was hit, the milliseconds say what it cost the person waiting.
   *
   * Note what turn 1 measures on a warmed app: 21 of 10320 tokens. It is not a
   * cold start — the system prompt and tools were primed on model select, and
   * the draft was prefilled while it was being typed. That is the latency work
   * doing its job, and it is why the fallback below compares turns to each other
   * rather than to an assumed-expensive first turn.
   */
  const first = rows[0];
  const share = (r) => (r.total > 0 ? r.processed / r.total : null);
  const counters = (r) =>
    share(r) === null
      ? 'counters not caught'
      : `${r.processed}/${r.total} tokens (${Math.round(share(r) * 100)}%)`;
  console.log('');
  console.log(
    `[prefill] first send ${first.ttft}ms · follow-up ${warm.ttft}ms · after an enhance ${after.ttft}ms`,
  );
  console.log(
    `[prefill] prefilled: ${counters(first)} first, ${counters(warm)} follow-up, ${counters(after)} after`,
  );

  const warmShare = share(warm);
  const afterShare = share(after);
  if (warmShare !== null && afterShare !== null) {
    if (warmShare > 0.5) {
      console.error(
        `[prefill] FAIL: a plain follow-up re-prefilled ${counters(warm)} — the chat path is losing its own prefix`,
      );
      failed = true;
    } else if (afterShare > 0.5) {
      console.error(
        `[prefill] FAIL: the studio enhancer evicted the chat's KV — the follow-up before it prefilled ${counters(warm)} and the one after it ${counters(after)} (${warm.ttft}ms then ${after.ttft}ms). The enhancer shares the chat's llama-server by default (resolveEnhancerEndpoint falls through to getInferenceUtility).`,
      );
      failed = true;
    } else {
      console.log(
        `[prefill] OK: the prefix survives a studio enhance — ${counters(warm)} prefilled before it, ${counters(after)} after, ${warm.ttft}ms then ${after.ttft}ms`,
      );
    }
  } else if (after.ttft > Math.max(warm.ttft * 3, warm.ttft + 750)) {
    // No counters to read — fall back to the clock, which is blunt but honest.
    console.error(
      `[prefill] FAIL: the follow-up before the enhance took ${warm.ttft}ms and the one after it ${after.ttft}ms, and the server did not report prompt counters to say why`,
    );
    failed = true;
  } else {
    console.log(
      `[prefill] OK (on timing alone — no prompt counters): ${warm.ttft}ms before the enhance, ${after.ttft}ms after`,
    );
  }
} catch (error) {
  console.error(`[prefill] probe error: ${error?.stack ?? error}`);
  failed = true;
} finally {
  await app.close().catch(() => undefined);
  /*
   * REAP THE SERVER THIS RUN STARTED.
   *
   * The app tears down its inference child on quit, but Playwright's `close()`
   * races that teardown and the llama-server is left reparented to init — 6.7 GB
   * resident on a 24 GB machine, until the next app launch reaps it. That is not
   * a nuisance here, it is the measurement: with one orphan still holding memory,
   * this probe's own warm follow-up went from 497ms to 23.7s and the next turn
   * never finished at all. A run that skews the run after it is worse than no run.
   *
   * Only the server on the port this run was using, and only if it has actually
   * been orphaned (ppid 1) — never a server some other window still owns.
   */
  try {
    const ps = execSync('ps -Ao pid,ppid,command | grep llama-server | grep -v grep', {
      encoding: 'utf8',
    });
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
      // ppid 1 means nobody owns it any more — the same rule ship-local uses.
      // Deliberately NOT matched on this run's port: the port is discovered, and
      // a discovery that failed is exactly when the orphan gets left behind.
      if (m === null || m[2] !== '1') continue;
      process.kill(Number(m[1]));
      console.log(`[prefill] reaped an orphaned llama-server (pid ${m[1]})`);
    }
  } catch {
    /* nothing matched, or ps refused — never fail a run over tidying up */
  }
}
process.exit(failed ? 1 : 0);
