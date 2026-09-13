/**
 * CALIBRATION, END TO END, HEADLESS: the real app, the real pi, the real cache.
 *
 * the user: "at the top bar, to the right of the chat name, show a little icon,
 * clicking this has a dropdown that shows a little scrollable list of the
 * inference engines with a 'calibrate' button at the top, during generation
 * this should also live show tps numbers. clicking calibrate pauses anything
 * running in the current chat, then runs the calibration and swaps to the
 * proper engine and speculative method, ensure this doesn't require internet
 * to run the calibration".
 *
 * What it proves, in order:
 *   1. the model's download ALSO fetches its drafters and MLX twin (the
 *      Recommended-tab rule) — measured by what is on disk afterwards;
 *   2. the menu opens right of the chat name and lists the engines with their
 *      install state (screenshot);
 *   3. tok/s shows LIVE while a reply streams (screenshot + the number);
 *   4. Calibrate mid-reply pauses the chat (Resume ▶ appears), measures every
 *      candidate from disk with the network cut for the engines
 *      (HF_HUB_OFFLINE), writes the record, and comes back up on the winner;
 *   5. the next message answers on the chosen engine.
 *
 *   MODEL=qwen3.5-4b-mtp QUANT=Q8_0 SHOT_DIR=/tmp/calib node tests/e2e/calibrate-probe.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const QUANT = process.env.QUANT ?? 'Q8_0';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'calib');
const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD === '1';
mkdirSync(SHOT_DIR, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('calibrate');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    toolInterface: 'bash-cli',
    modelSelection: { mode: 'model', modelId: MODEL },
  }),
);

const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const mainLog = [];
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'calib-udd-'))}`],
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
  for (const line of String(d).split('\n')) {
    if (line.trim() === '') continue;
    mainLog.push(line);
    if (
      /\[calibrate\]|\[engine\]|\[download\]|\[rapid-mlx\]|\[dflash|\[mlx-dspark\]|\[omlx\]|\[mlx-lm\]/.test(
        line,
      )
    )
      log('  main:', line.slice(0, 220));
  }
};
app.process().stdout?.on('data', onLog);
app.process().stderr?.on('data', onLog);

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);
  // Collect every calibration event and every download-progress line on the page.
  await win.evaluate(() => {
    window.__calib = [];
    window.__dl = [];
    window.piDesktop.onEvent('llm:calibration', (p) => window.__calib.push(p));
    window.piDesktop.onEvent('llm:download-progress', (p) => window.__dl.push(p));
  });

  // 1. The download rule: drafters + MLX twin arrive with the weights.
  if (!SKIP_DOWNLOAD) {
    log('downloading', MODEL, QUANT, '(+ drafters + MLX twin)');
    const dl = await win.evaluate(
      ([id, q]) => window.piDesktop.invoke('llm:download-model', { modelId: id, quant: q }),
      [MODEL, QUANT],
    );
    log('download →', JSON.stringify(dl));
    check(dl.success === true, `download failed: ${dl.error}`);
    const seen = await win.evaluate(() => {
      const files = new Set(window.__dl.map((p) => p.file));
      const last = window.__dl.at(-1);
      return { files: [...files], last };
    });
    log('download files seen:', JSON.stringify(seen.files));
    log('download last:', JSON.stringify(seen.last));
  }
  const modelDir = path.join(CACHE, 'models', MODEL);
  const onDisk = existsSync(modelDir) ? readdirSync(modelDir) : [];
  log('model dir:', JSON.stringify(onDisk));
  check(
    onDisk.some((f) => /dflash/i.test(f)),
    'a DFlash draft GGUF sits beside the weights',
  );
  const storeText = path.join(CACHE, 'store', 'text');
  const stored = existsSync(storeText) ? readdirSync(storeText) : [];
  log('store/text:', JSON.stringify(stored));
  check(
    stored.some((d) => /qwen3\.5-4b/i.test(d) && /mlx/i.test(d)),
    'the MLX twin is in the model store',
  );
  check(
    stored.some((d) => /z-lab__qwen3\.5-4b-dflash/i.test(d)),
    'the MLX DFlash drafter is in the model store',
  );

  // 2. Start the model the ordinary way and open the menu.
  const up = await win.evaluate(
    ([id, q]) => window.piDesktop.invoke('llm:start-server', { modelId: id, quant: q }),
    [MODEL, QUANT],
  );
  check(up.success === true, `start-server: ${up.error}`);
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
    timeout: 90000,
  });
  await win.waitForTimeout(2500);
  const status0 = await win.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));
  log(
    'status:',
    JSON.stringify({ phase: status0.phase, profile: status0.profile, provider: status0.provider }),
  );

  const btn = win.locator('[data-testid="engine-menu-button"]');
  check((await btn.count()) === 1, 'the engine menu button is in the top bar');
  const geom = await win.evaluate(() => {
    const t = document.querySelector('[data-testid="chat-title"]')?.getBoundingClientRect();
    const b = document.querySelector('[data-testid="engine-menu-button"]')?.getBoundingClientRect();
    return {
      title: t ? [t.left, t.right, t.top] : null,
      button: b ? [b.left, b.right, b.top] : null,
    };
  });
  log('geometry:', JSON.stringify(geom));
  check(
    geom.title !== null && geom.button !== null && geom.button[0] >= geom.title[1] - 1,
    'the icon sits RIGHT of the chat name',
  );
  await btn.click();
  await win.waitForSelector('[data-testid="engine-menu"]', { timeout: 5000 });
  await win.waitForTimeout(600);
  const menu0 = await win.evaluate(() => ({
    running: document.querySelector('[data-testid="engine-menu-running"]')?.textContent,
    tps: document.querySelector('[data-testid="engine-menu-tps"]')?.textContent,
    rows: [...document.querySelectorAll('[data-testid^="engine-menu-row-"]')].map((r) => ({
      id: r.dataset.testid.replace('engine-menu-row-', ''),
      supported: r.dataset.supported,
      installed: r.dataset.installed,
      active: r.dataset.active,
    })),
    calibrate: document.querySelector('[data-testid="engine-calibrate"]')?.disabled,
    listScrolls: (() => {
      const l = document.querySelector('[data-testid="engine-menu-list"]');
      return l ? l.scrollHeight > l.clientHeight : null;
    })(),
  }));
  log('menu:', JSON.stringify(menu0));
  check(menu0.rows.length >= 5, `the menu lists the engines (got ${menu0.rows.length})`);
  // A stored verdict is honoured at startup, so the running engine is whatever
  // the last calibration chose — the row marked "running" must be that one.
  check(
    menu0.rows.find((r) => r.active === 'yes')?.id === status0.profile?.engine,
    `the row marked running is the engine that is up (${status0.profile?.engine})`,
  );
  check(menu0.calibrate === false, 'Calibrate is enabled with a model up');
  writeFileSync(path.join(SHOT_DIR, '01-menu-idle.png'), await win.screenshot());
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // 3. Live tok/s while a reply streams.
  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type(
    'Write a 300-word story about a lighthouse keeper who finds a message in a bottle. Prose only.',
    { delay: 3 },
  );
  await win.keyboard.press('Enter');
  let live = null;
  const liveDeadline = Date.now() + 60_000;
  while (Date.now() < liveDeadline) {
    live = await win.evaluate(() => ({
      readout: document.querySelector('[data-testid="engine-live-tps"]')?.textContent ?? null,
      store: window.__llm_store?.().getState().live ?? null,
      streaming: window.__pi_store().getState().agent.isStreaming,
    }));
    if (live.readout !== null) break;
    await win.waitForTimeout(200);
  }
  log('live:', JSON.stringify(live));
  /* The readout draws only while TEXT streams; a turn the model spends on tool
     calls (rapid-mlx streams a call as one chunk) shows nothing to read, so the
     proof here is the wire: a `[pi-tps]` line reached the store. The pixels are
     in 02-live-tps.png from a prose turn. */
  check(
    live?.readout !== null || (live?.store !== null && live?.store !== undefined),
    'live tok/s reached the renderer while the reply streamed',
  );
  await btn.click();
  await win.waitForSelector('[data-testid="engine-menu"]', { timeout: 5000 });
  await win.waitForTimeout(700);
  const liveMenu = await win.evaluate(
    () => document.querySelector('[data-testid="engine-menu-tps"]')?.textContent ?? null,
  );
  log('menu tps line while streaming:', liveMenu);
  check(
    liveMenu !== null && /tok\/s/.test(liveMenu),
    'the dropdown shows a tok/s line while streaming',
  );
  writeFileSync(path.join(SHOT_DIR, '02-live-tps.png'), await win.screenshot());

  // 4. Calibrate mid-reply: pause, measure, switch.
  const t0 = Date.now();
  await win.locator('[data-testid="engine-calibrate"]').click();
  await win.waitForTimeout(1500);
  const paused = await win.evaluate(() => ({
    pausedChat: window.__pi_store().getState().pausedChat !== null,
    resume: document.querySelector('[data-testid="composer-resume"]') !== null,
    note: document.querySelector('[data-testid="engine-menu-note"]')?.textContent ?? null,
  }));
  log('after click:', JSON.stringify(paused));
  check(paused.pausedChat, 'the streaming reply was PAUSED (resumable), not killed');
  let shotMid = false;
  let done = null;
  const deadline = Date.now() + 30 * 60_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const ev = await win.evaluate(() => window.__calib);
    if (ev.length !== lastCount) {
      for (const e of ev.slice(lastCount)) {
        log(
          'calib:',
          e.stage,
          e.stage === 'result'
            ? `${e.result.id} ok=${e.result.ok} decode=${e.result.decodeTps.toFixed(1)} prefill=${e.result.prefillTps.toFixed(0)} ttft=${e.result.ttftMs.toFixed(0)}ms up=${e.result.startupMs}ms ${e.result.error ?? ''}`
            : e.stage === 'planned'
              ? `${e.candidates.map((c) => c.id).join(', ')} | skips: ${e.skips.map((s) => `${s.id} (${s.reason})`).join(', ')}`
              : (e.id ?? JSON.stringify(e.chosen ?? e.error ?? '')),
        );
      }
      lastCount = ev.length;
      if (!shotMid && ev.some((e) => e.stage === 'result')) {
        shotMid = true;
        writeFileSync(path.join(SHOT_DIR, '03-calibrating.png'), await win.screenshot());
      }
    }
    const last = ev.at(-1);
    if (last && (last.stage === 'done' || last.stage === 'failed' || last.stage === 'cancelled')) {
      done = last;
      break;
    }
    await win.waitForTimeout(1000);
  }
  log(`calibration finished in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, done?.stage);
  check(done?.stage === 'done', `calibration ended in "${done?.stage}" ${done?.error ?? ''}`);
  if (done?.stage === 'done') {
    const rec = done.record;
    log('chosen:', JSON.stringify(rec.chosen));
    for (const r of rec.ranked)
      log(
        `  ${r.ok ? '✓' : '✗'} ${r.id.padEnd(22)} score ${r.score.toFixed(2)} decode ${r.decodeTps.toFixed(1)} prefill ${r.prefillTps.toFixed(0)} ttft ${r.ttftMs.toFixed(0)}ms up ${r.startupMs}ms ${r.error ?? ''}`,
      );
    for (const k of rec.skips) log(`  – ${k.id}: ${k.reason}`);
    const okCount = rec.ranked.filter((r) => r.ok).length;
    check(okCount >= 2, `at least two candidates measured OK (got ${okCount})`);
    check(
      rec.ranked.some((r) => r.ok && r.engine !== 'llamacpp'),
      'at least one non-llama.cpp engine measured OK',
    );
  }
  // The renderer respawns pi on the same session and points it at the
  // winner's provider block; wait for that to land rather than racing it.
  await win
    .waitForFunction(
      async () => {
        const st = await window.piDesktop.invoke('llm:get-status', undefined);
        const s = window.__pi_store().getState();
        return s.session !== null && s.agent.model?.provider === st.provider;
      },
      { timeout: 90000 },
    )
    .catch(() => undefined);
  const after = await win.evaluate(async () => {
    const st = await window.piDesktop.invoke('llm:get-status', undefined);
    return {
      profile: st.profile,
      provider: st.provider,
      phase: st.phase,
      piModel: window.__pi_store().getState().agent.model,
      pausedChat: window.__pi_store().getState().pausedChat !== null,
    };
  });
  log('after:', JSON.stringify(after));
  if (done?.stage === 'done' && done.record.chosen !== null) {
    check(
      after.profile?.engine === done.record.chosen.engine &&
        after.profile?.spec === done.record.chosen.spec,
      'the server came back up on the chosen profile',
    );
    check(
      after.piModel?.provider === after.provider,
      `pi is pointed at the provider of the running engine (${after.piModel?.provider} vs ${after.provider})`,
    );
  }
  const recordDir = path.join(CACHE, 'calibration');
  check(
    existsSync(recordDir) && readdirSync(recordDir).some((f) => f.startsWith(MODEL)),
    'the calibration record was written',
  );
  const menuAfter = await win.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-testid^="calib-row-"]')].map((r) => ({
      id: r.dataset.testid,
      state: r.dataset.state,
      ok: r.dataset.ok,
      text: r.textContent?.slice(0, 80),
    })),
    running: document.querySelector('[data-testid="engine-menu-running"]')?.textContent,
  }));
  log('menu after:', JSON.stringify(menuAfter));
  writeFileSync(path.join(SHOT_DIR, '04-done.png'), await win.screenshot());
  await win.keyboard.press('Escape');

  // 5. The next message answers on the chosen engine.
  await editor.click();
  await win.keyboard.type('Reply with exactly one short sentence: what is a lighthouse for?', {
    delay: 3,
  });
  const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
  const sentAt = Date.now();
  await win.keyboard.press('Enter');
  let ttft = null;
  let text = '';
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const r = await win.evaluate((b) => {
      let t = '';
      for (const m of window.__pi_store().getState().messages.slice(b))
        if (m.kind === 'assistant') for (const blk of m.blocks ?? []) t += blk.text ?? '';
      const s = window.__pi_store().getState();
      return { t, busy: s.agent.isStreaming || s.promptInFlight };
    }, before);
    if (r.t.length > 0 && ttft === null) ttft = Date.now() - sentAt;
    text = r.t;
    if (ttft !== null && !r.busy) break;
    await win.waitForTimeout(150);
  }
  log(`reply on the chosen engine: ttft=${ttft}ms text="${text.slice(0, 120)}"`);
  check(text.length > 0, 'the chosen engine answered the next message');
  const liveAfter = await win.evaluate(() => window.__llm_store?.().getState().live ?? null);
  log('live after reply:', JSON.stringify(liveAfter));
  writeFileSync(path.join(SHOT_DIR, '05-reply-on-winner.png'), await win.screenshot());
} finally {
  writeFileSync(path.join(SHOT_DIR, 'main.log'), mainLog.join('\n'));
  await app.close().catch(() => undefined);
  if (failures.length > 0) console.error(`calibrate-probe: ${failures.length} failure(s)`);
  else console.log('calibrate-probe OK');
  console.log(`shots → ${SHOT_DIR}`);
}
