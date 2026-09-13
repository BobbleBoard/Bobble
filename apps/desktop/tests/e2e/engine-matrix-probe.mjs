/**
 * EVERY ENGINE × METHOD, THROUGH THE REAL CHAT — does it answer, does it call
 * a tool, does it error, and does the follow-up reuse the prefix?
 *
 * the user (2026-09-13): "i'm having errors with different engines eg. rapidmlx
 * says dflash can't work with it, but also the non dflash version is
 * returning errors and doesn't have the prefill caching work at all or as
 * well as llamacpp? test through each and make sure all engines work with
 * recommended models."
 *
 * Calibration measures a bench prompt; this drives the app's own chat path
 * (pi → provider → engine) on each candidate the live plan names for the
 * model, with a four-turn script: a one-word reply, an arithmetic answer, a
 * bash tool call, and a follow-up that should hit the prompt cache. For every
 * turn it records the first-token time, the text, the RAW provider error (the
 * chat only shows a cleaned sentence), and the engine's own log lines about
 * prefix-cache hits — the ground truth behind "prefill caching works".
 *
 * Real cache, throwaway HOME, headless. Nothing is downloaded.
 *
 *   MODEL=qwen3.5-4b-mtp ONLY=rapid-mlx/mtp,llamacpp/none \
 *     OUT=/tmp/engine-matrix node apps/desktop/tests/e2e/engine-matrix-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const SKIP = (process.env.SKIP ?? '').split(',').filter(Boolean);
const OUT = process.env.OUT ?? path.join(tmpdir(), 'engine-matrix');
mkdirSync(OUT, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('engine-matrix');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: MODEL },
    ...(process.env.TOOL_INTERFACE === undefined
      ? {}
      : { toolInterface: process.env.TOOL_INTERFACE }),
  }),
);
const TURNS = [
  { id: 'word', text: 'Reply with exactly one word: ready.' },
  { id: 'math', text: 'What is 17 times 23? Reply with the number only.' },
  {
    id: 'tool',
    text: 'Use your bash tool to run this exact command: echo hello-from-tool — then tell me exactly what it printed.',
  },
  { id: 'follow', text: 'What did that command print? Answer in one short line.' },
];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mainLog = [];
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'engmx-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const onLog = (d) => {
  for (const line of String(d).split('\n')) if (line.trim() !== '') mainLog.push(line);
};
app.process().stdout?.on('data', onLog);
app.process().stderr?.on('data', onLog);
const results = [];
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
  await win.waitForTimeout(1500);
  const status = () => win.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));

  log(`starting ${MODEL} on llama.cpp…`);
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  // The app repoints pi at the server it started (a second restart from here
  // used to race that one — see pi-sessions' restart lock — and is not needed).
  await win.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 60_000 },
  );
  await win.waitForTimeout(2000);

  const plan = await win.evaluate(
    (m) => window.piDesktop.invoke('llm:calibration-plan', { modelId: m }),
    MODEL,
  );
  let candidates = plan.candidates.map((c) => c.id);
  if (ONLY.length > 0) candidates = candidates.filter((id) => ONLY.includes(id));
  candidates = candidates.filter((id) => !SKIP.includes(id));
  log('candidates:', candidates.join(', '));
  log('skips:', plan.skips.map((k) => `${k.id} (${k.reason})`).join('; '));

  const messages = () =>
    win.evaluate(() => {
      const rows = window.__pi_store().getState().messages;
      return rows.map((m) => ({
        kind: m.kind,
        text: (m.blocks ?? [])
          .map((b) => b.text ?? '')
          .join('')
          .slice(0, 200),
        tools: (m.blocks ?? []).filter((b) => b.kind === 'toolCall' || b.type === 'toolCall')
          .length,
        error: m.errorMessage ?? null,
      }));
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
      .then(() => true)
      .catch(() => false);

  /* llama-server's own account of a request: `n_prompt_tokens` (the whole
     prompt) vs `n_prompt_tokens_processed` (what it had to read) — polled off
     /slots during a turn, so "did the prefix get reused" is a number, not a
     feeling. External engines say it in their own logs (rapid-mlx: cache_fetch). */
  const slotsOf = (baseUrl) => {
    const m = /:(\d+)\/v1/.exec(baseUrl ?? '');
    return m === null ? null : `http://127.0.0.1:${m[1]}/slots`;
  };
  const watchSlots = (url, sink, stop) =>
    (async () => {
      let last = '';
      while (!stop.done) {
        try {
          const res = await fetch(url);
          const slots = await res.json();
          for (const slot of slots) {
            const key = `${slot.id}|${slot.id_task}|${slot.n_prompt_tokens}|${slot.n_prompt_tokens_processed}`;
            if (key !== last && slot.n_prompt_tokens > 0) {
              last = key;
              sink.push({ total: slot.n_prompt_tokens, processed: slot.n_prompt_tokens_processed });
            }
          }
        } catch {
          /* between requests */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

  for (const id of candidates) {
    const [engine, spec] = id.split('/');
    const row = { id, engine, spec, started: false, startMs: null, turns: [], logs: [] };
    results.push(row);
    log(`\n=== ${id} ===`);
    // Fresh chat per candidate so every engine sees the same prompt from zero.
    await win.click('[data-testid="new-chat"]').catch(() => {});
    await win.waitForTimeout(1200);
    const t0 = Date.now();
    const logStart = mainLog.length;
    // Through the store, as the engine menu does: `switchProfile` relaunches
    // the server AND repoints pi at it (the bare IPC does only the first).
    const res = await win.evaluate(
      ({ engine, spec }) => window.__llm_store().getState().switchProfile(engine, spec),
      { engine, spec },
    );
    if (res.success !== true) {
      row.error = res.error ?? 'use-profile failed';
      log(`  could not start: ${row.error}`);
      row.logs = mainLog
        .slice(logStart)
        .filter((l) => /error|Error|rror:|refused|failed/i.test(l))
        .slice(-6);
      continue;
    }
    const ready = await win
      .waitForFunction(
        ({ engine, spec }) => {
          const s = window.__llm_store().getState().status;
          return (
            s.phase === 'ready' &&
            s.serverRunning === true &&
            s.profile?.engine === engine &&
            s.profile?.spec === spec
          );
        },
        { engine, spec },
        { timeout: 240_000 },
      )
      .then(() => true)
      .catch(() => false);
    const st = await status();
    row.started = ready;
    row.startMs = Date.now() - t0;
    if (!ready) {
      row.error = st.lastError ?? `not ready (phase ${st.phase})`;
      log(`  did not come up in ${row.startMs}ms: ${row.error}`);
      row.logs = mainLog
        .slice(logStart)
        .filter((l) => /error|Error|rror:|refused|failed/i.test(l))
        .slice(-8);
      continue;
    }
    log(`  up in ${(row.startMs / 1000).toFixed(1)}s (${st.profile?.engine}/${st.profile?.spec})`);
    // pi is repointed by the app; wait until its model names this engine.
    const want = engine === 'llamacpp' ? MODEL : `${MODEL}@${engine}`;
    const repointed = await win
      .waitForFunction((w) => window.__pi_store().getState().agent.model?.id === w, want, {
        timeout: 60_000,
      })
      .then(() => true)
      .catch(() => false);
    row.piModel = await win.evaluate(() => window.__pi_store().getState().agent.model?.id ?? null);
    if (!repointed) log(`  pi did not repoint (model is ${row.piModel}); continuing anyway`);
    // Let the warm-up settle.
    await win.waitForTimeout(6000);

    const slotsUrl = engine === 'llamacpp' ? slotsOf(st.baseUrl) : null;
    for (const turn of TURNS) {
      const before = await messages();
      const beforeLog = mainLog.length;
      const slotSink = [];
      const stop = { done: false };
      const watcher = slotsUrl === null ? null : watchSlots(slotsUrl, slotSink, stop);
      await win.click('[data-testid="composer-input"]');
      await win.keyboard.type(turn.text);
      const sentAt = Date.now();
      await win.keyboard.press('Enter');
      let ttft = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const now = await messages();
        const last = now[now.length - 1];
        if (
          now.length > before.length &&
          last !== undefined &&
          last.kind === 'assistant' &&
          (last.text.length > 0 || last.tools > 0 || last.error !== null)
        ) {
          ttft = Date.now() - sentAt;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const finished = await idle();
      const total = Date.now() - sentAt;
      stop.done = true;
      if (watcher !== null) await watcher;
      // The biggest prompt this turn sent, and how much of it was already there.
      const biggest = slotSink.reduce((a, b) => (b.total > (a?.total ?? 0) ? b : a), null);
      const reuse =
        biggest === null
          ? null
          : { total: biggest.total, reused: biggest.total - biggest.processed };
      const after = await messages();
      const fresh = after.slice(before.length);
      const assistant = fresh.filter((m) => m.kind === 'assistant');
      const text = assistant
        .map((m) => m.text)
        .join(' ⏎ ')
        .trim();
      const error = fresh.map((m) => m.error).find((e) => e !== null) ?? null;
      const tools = fresh.reduce((n, m) => n + m.tools, 0);
      const lines = mainLog
        .slice(beforeLog)
        .filter((l) =>
          /cache_fetch|prefix.?cache|HIT|MISS|prompt_tokens|n_prompt|HTTP \d{3}|422|400|Error|error|WITHOUT ANY EXTENSIONS|exited at startup/.test(
            l,
          ),
        )
        .slice(-12);
      // rapid-mlx says it in its scheduler line: cached=N remaining=M.
      const cacheLine = lines
        .map((l) => /cache_fetch.*?(HIT|MISS).*?prompt_tokens=(\d+)(?:.*?cached=(\d+))?/.exec(l))
        .find(Boolean);
      const engineReuse =
        cacheLine === undefined
          ? null
          : {
              total: Number(cacheLine[2]),
              reused: cacheLine[1] === 'HIT' ? Number(cacheLine[3] ?? 0) : 0,
            };
      const t = {
        id: turn.id,
        ttft,
        total,
        finished,
        text: text.slice(0, 160),
        error,
        tools,
        reuse: reuse ?? engineReuse,
        lines,
      };
      row.turns.push(t);
      const rr = t.reuse;
      log(
        `  ${turn.id.padEnd(6)} ttft=${ttft === null ? 'NONE' : `${ttft}ms`} total=${total}ms tools=${tools}${
          rr === null ? '' : ` prompt=${rr.total} reused=${rr.reused}`
        } ${
          error !== null
            ? `ERROR: ${String(error).slice(0, 140)}`
            : `→ ${text.slice(0, 80).replace(/\n/g, ' ')}`
        }`,
      );
      for (const l of lines) log(`      · ${l.slice(0, 160)}`);
      if (!finished) {
        log('  (turn did not finish — moving on)');
        break;
      }
      await win.waitForTimeout(1500);
    }
  }
} finally {
  writeFileSync(path.join(OUT, 'engine-matrix.json'), JSON.stringify(results, null, 2));
  writeFileSync(path.join(OUT, 'main.log'), mainLog.join('\n'));
  await app.close().catch(() => {});
}
console.log('\n=== SUMMARY ===');
for (const r of results) {
  const turns = r.turns
    .map(
      (t) =>
        `${t.id}:${t.error !== null ? 'ERR' : t.ttft === null ? 'none' : `${t.ttft}ms`}${t.tools > 0 ? '+tool' : ''}${
          t.reuse ? `(${t.reuse.reused}/${t.reuse.total})` : ''
        }`,
    )
    .join(' ');
  console.log(
    `${r.id.padEnd(20)} ${r.started ? 'up' : 'DOWN'} ${turns}${r.error ? ` | ${r.error.slice(0, 100)}` : ''}`,
  );
}
console.log(`json: ${path.join(OUT, 'engine-matrix.json')}`);
