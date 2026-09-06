/**
 * DOES ANYTHING ELSE ON THE BOX COST THE CHAT ITS PREFIX?
 *
 * the user: "always be checking whenever you do chat/harness work at all, especially
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
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
const OUT = process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'ttft');
mkdirSync(OUT, { recursive: true });

const discoverPort = () => {
  if (process.env.PORT !== undefined) return Number(process.env.PORT);
  try {
    const ps = execSync('ps aux | grep llama-server | grep -v grep', { encoding: 'utf8' });
    const m = /--port (\d+)/.exec(ps);
    return m === null ? null : Number(m[1]);
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
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  await win.waitForTimeout(8000);

  const port = discoverPort();
  if (port === null) throw new Error('no llama-server port found');
  console.log(`llama-server on ${port}`);

  /*
   * Poll HARD. A follow-up's prefill is over in well under a second when reuse
   * works, so a lazy poll misses the one sample that answers the question.
   */
  const watch = async (ms, sink) => {
    const until = Date.now() + ms;
    let last = '';
    while (Date.now() < until) {
      try {
        const [slot] = await (await fetch(`http://127.0.0.1:${port}/slots`)).json();
        const key = `${slot.id_task}|${slot.n_prompt_tokens}|${slot.n_prompt_tokens_processed}`;
        if (key !== last && slot.n_prompt_tokens > 0) {
          last = key;
          sink.push({ total: slot.n_prompt_tokens, processed: slot.n_prompt_tokens_processed });
        }
      } catch {
        /* busy — keep polling */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const turn = async (label, text) => {
    const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
    const samples = [];
    const watching = watch(60_000, samples);
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
      { timeout: 120_000 },
    );
    const ttft = Date.now() - t0;
    await win.waitForTimeout(1500);
    await watching;
    // The deepest sample is the one that saw the whole prompt.
    const deepest = samples.reduce((a, b) => (b.total > (a?.total ?? 0) ? b : a), null);
    const row = { label, ttft, ...(deepest ?? { total: 0, processed: 0 }) };
    rows.push(row);
    const pct = row.total > 0 ? Math.round((row.processed / row.total) * 100) : 0;
    console.log(
      `[prefill] ${label.padEnd(22)} ttft ${String(ttft).padStart(6)}ms   prompt ${row.total} tokens, prefilled ${row.processed} (${pct}%)`,
    );
    return row;
  };

  await turn('turn 1 (cold)', 'in one short sentence, what is a prime number?');
  const warm = await turn('turn 2 (warm)', 'and one example please');

  // The interruption under test: a studio prompt enhanced on the same server.
  const enhanced = await win.evaluate(() =>
    window.piDesktop.invoke('gen:enhance', { kind: 'image', prompt: 'a fox in the snow' }),
  );
  console.log(
    `[prefill] enhancer ran: changed=${enhanced?.changed} -> ${String(enhanced?.prompt).slice(0, 70)}`,
  );

  const after = await turn('turn 3 (post-enhance)', 'and one more example');

  const share = (r) => (r.total > 0 ? r.processed / r.total : 1);
  console.log('');
  if (share(warm) > 0.5) {
    console.error(
      `[prefill] FAIL: even a plain follow-up re-prefilled ${Math.round(share(warm) * 100)}% of its prompt — the chat path is losing its own prefix`,
    );
    failed = true;
  } else if (share(after) > 0.5) {
    console.error(
      `[prefill] FAIL: the enhancer evicted the chat's KV — the follow-up before it prefilled ${warm.processed}/${warm.total} tokens, the one after it ${after.processed}/${after.total} (${after.ttft}ms vs ${warm.ttft}ms)`,
    );
    failed = true;
  } else {
    console.log(
      `[prefill] OK: the prefix survives a studio enhance — follow-up prefilled ${warm.processed}/${warm.total} tokens before it and ${after.processed}/${after.total} after (${warm.ttft}ms -> ${after.ttft}ms)`,
    );
  }
} catch (error) {
  console.error(`[prefill] probe error: ${error?.stack ?? error}`);
  failed = true;
} finally {
  await app.close().catch(() => undefined);
}
process.exit(failed ? 1 : 0);
