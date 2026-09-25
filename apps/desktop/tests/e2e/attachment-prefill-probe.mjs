/**
 * IS THE ATTACHMENT PREFILL ACTUALLY FIRING?
 *
 * The machinery is documented as measured (~3747ms → ~290ms on a ~5k-token
 * paste), but three separate features tonight turned out to exist and never run
 * — the warm-up could not start, timed out, and warmed the wrong prefix — so
 * this assumes nothing and measures an A/B the implementation cannot fake:
 * the SAME paste and the SAME question, sent once after an idle (the prefill has
 * time to prime) and once immediately (it does not).
 *
 *   IDLE_MS=12000 → 400ms
 *   IDLE_MS=0     → 4807ms
 *
 * 12x on the identical input, and the slow case matches a ~5k-token cold prefill
 * measured directly against llama-server (5416 tokens = 4.0s). That is the proof.
 *
 * WHAT THE ENGINE RE-READ, not only how long it took (2026-09-24). Every send
 * also reports the engine's own count from the provider's usage line
 * (`PI_DIAG_PROMPTS`): the prompt's tokens, how many its prefix cache served,
 * and the difference — the tokens actually computed on Enter. A prime that
 * covered the attachment leaves only the typed question to compute.
 *
 * TWO SCENARIOS, each in a fresh chat:
 *
 *   paste         the big paste alone (the original measurement)
 *   paste+files   the same paste plus a PDF and a folder pasted from Finder —
 *                 on a build that attaches files by path, their `Attached …:`
 *                 lines ride at the start of the message, so the prime must
 *                 cover them too or Enter re-reads the whole attachment
 *
 * HIDDEN, on a throwaway HOME (the real model library and cache, read only),
 * with the focus guard — it used to open a visible window on the person's own
 * home. It loads a model, so it runs under the HEAVY lock:
 *
 *   OUT=/tmp/attach-prefill node scripts/with-lock.mjs heavy -- \
 *     node apps/desktop/tests/e2e/attachment-prefill-probe.mjs
 *
 *   MODEL=<id>          default qwen3.5-4b-mtp
 *   PASTE_CHARS=20000   size of the paste
 *   IDLE_MS=12000       0 sends before the prime can have run (the contrast)
 *   SCENARIOS=paste     run one scenario
 *   ENGINE=llamacpp     pin llama.cpp (the engine the prime is built for — it
 *                       primes over /apply-template + /completion); unset, the
 *                       model runs on whatever calibration chose on this Mac
 *                       (rapid-mlx for qwen3.5-4b-mtp, where no prime lands)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PASTE_CHARS = Number(process.env.PASTE_CHARS ?? 20000);
const IDLE_MS = Number(process.env.IDLE_MS ?? 12_000);
const OUT = process.env.OUT ?? path.join(tmpdir(), 'attach-prefill');
const SCENARIOS = (process.env.SCENARIOS ?? 'paste,paste+files').split(',');
mkdirSync(OUT, { recursive: true });
const DIAG = path.join(OUT, 'prompts.log');
writeFileSync(DIAG, '');
rmSync(`${DIAG}.bodies.jsonl`, { force: true });

const home = probeHome('attachment-prefill');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: MODEL },
    // The user's own speculative choice outranks the calibrated engine, and
    // every choice but `auto` is a llama.cpp launch (supervisor userProfileFor).
    ...(process.env.ENGINE === 'llamacpp' ? { modelSpec: { [MODEL]: { method: 'mtp' } } } : {}),
  }),
);
/* The files a person would paste from Finder: outside every served folder. */
const DESK = path.join(home, 'Desktop');
const PDF = path.join(DESK, 'wall survey.pdf');
const FOLDER = path.join(DESK, 'climbing-wall');
mkdirSync(FOLDER, { recursive: true });
writeFileSync(path.join(FOLDER, 'README.md'), '# Wall\n\nTwelve metres, slight overhang.\n');
writeFileSync(PDF, `%PDF-1.4\n% ${'survey '.repeat(20000)}\n%%EOF\n`);

const { page, check, finish } = await launchApp('attachment-prefill', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    PI_DIAG_PROMPTS: DIAG,
    PI_DIAG_PROMPTS_FULL: '1',
  },
  waitFor: '[data-testid="composer-input"]',
  timeout: 120_000,
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const usageLines = () =>
  readFileSync(DIAG, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('[pi-diag-usage]'))
    .map((l) => ({
      engine: /engine=(\S+)/.exec(l)?.[1],
      prompt: Number(/prompt_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
      cached: Number(/cached_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
    }));

const rows = [];
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 60_000,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  log(`starting ${MODEL}…`);
  await page.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await page.waitForFunction(
    (m) => {
      const s = window.__llm_store?.().getState().status;
      return s?.model?.id === m && s.phase === 'ready' && s.serverRunning === true;
    },
    MODEL,
    { timeout: 600_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  const status = await page.evaluate(() => window.__llm_store().getState().status);
  const port = Number(/:(\d+)\/v1/.exec(status.baseUrl ?? '')?.[1] ?? 0) || null;
  log(`model ${status.model?.id} on ${status.baseUrl} (engine ${status.engine ?? '?'})`);

  /** Nothing on the slot for `quietMs` — llama.cpp says so on `/slots`. */
  const slotIdle = async (quietMs = 3000, timeoutMs = 240_000) => {
    if (port === null) return sleep(7000);
    const deadline = Date.now() + timeoutMs;
    let idleSince = Date.now();
    while (Date.now() < deadline) {
      let slots = null;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/slots`);
        slots = res.ok ? await res.json() : null;
      } catch {
        slots = null;
      }
      if (!Array.isArray(slots)) return sleep(7000);
      if (slots.some((s) => s.is_processing === true)) idleSince = Date.now();
      else if (Date.now() - idleSince >= quietMs) return;
      await sleep(100);
    }
  };
  const turnIdle = () =>
    page.waitForFunction(
      () => {
        const s = window.__pi_store().getState();
        return s.agent.isStreaming !== true && s.promptInFlight !== true;
      },
      undefined,
      { timeout: 240_000 },
    );
  const assistants = () =>
    page.evaluate(
      () =>
        window
          .__pi_store()
          .getState()
          .messages.filter((m) => m.kind === 'assistant').length,
    );
  /** Enter → the first token of the NEW assistant row (thinking or text). */
  const firstToken = async (before, t0) => {
    await page.waitForFunction(
      (n) => {
        const rows = window
          .__pi_store()
          .getState()
          .messages.filter((m) => m.kind === 'assistant');
        if (rows.length <= n) return false;
        const last = rows[rows.length - 1];
        return (last.blocks ?? []).some((b) =>
          b.type === 'text'
            ? (b.text ?? '').length > 0
            : b.type === 'thinking'
              ? (b.thinking ?? '').length > 0
              : true,
        );
      },
      before,
      { timeout: 180_000, polling: 20 },
    );
    return Date.now() - t0;
  };

  /* Path-backed Files, as Chromium makes them from a Finder copy. */
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'probe-files';
    input.style.display = 'none';
    document.body.appendChild(input);
  });
  const pasteFinder = async (paths) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#probe-files',
    });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: paths });
    await page.click('[data-testid="composer-input"]');
    await page.evaluate(() => {
      const input = document.getElementById('probe-files');
      const data = new DataTransfer();
      for (const f of input.files) data.items.add(f);
      data.setData('text/plain', [...input.files].map((f) => f.name).join('\r'));
      document
        .querySelector('[data-testid="composer-input"]')
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
    });
    await sleep(800);
  };
  const pasteText = async (text) => {
    await page.click('[data-testid="composer-input"]');
    await page.evaluate((t) => {
      const data = new DataTransfer();
      data.setData('text/plain', t);
      document
        .querySelector('[data-testid="composer-input"]')
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
    }, text);
    await sleep(300);
  };

  const filler =
    `Reference notes.\n${'The wall is twelve metres wide with a slight overhang. '.repeat(
      Math.ceil(PASTE_CHARS / 55),
    )}`.slice(0, PASTE_CHARS);

  for (const scenario of SCENARIOS) {
    // A fresh chat, so each scenario primes and sends against the same history.
    if (rows.length > 0) {
      await page.click('[data-testid="composer-input"]');
      await page.keyboard.type('/new');
      await sleep(250);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.__pi_store().getState().messages.length === 0,
        undefined,
        { timeout: 20_000 },
      );
      await sleep(1500);
    }
    await slotIdle(3000);
    await page.evaluate(() => {
      window.__prefill_log = [];
    });

    await pasteText(filler);
    if (scenario === 'paste+files') await pasteFinder([PDF, FOLDER]);
    const held = await page.evaluate(
      () => document.querySelectorAll('[data-testid="composer-attachments"] > *').length,
    );
    log(`${scenario}: ${held} attachment(s) in the composer`);

    await sleep(IDLE_MS);
    if (IDLE_MS > 0) await slotIdle(1500);
    await page.screenshot({ path: path.join(OUT, `${scenario}-01-attached.png`) });

    // What the prime did between the paste and Enter — read NOW: the app keeps
    // fifty entries, and a streaming turn fills them with "slot busy".
    const primes = await page.evaluate(() => window.__prefill_log ?? []);
    const usageBefore = usageLines().length;
    const n = await assistants();
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type('In one sentence, how wide is the wall?');
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    const ttft = await firstToken(n, t0).catch(() => null);
    await turnIdle().catch(() => undefined);
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, `${scenario}-02-answer.png`) });

    const usage = usageLines().slice(usageBefore);
    const first = usage[0];
    const body = await page.evaluate(
      () =>
        window
          .__pi_store()
          .getState()
          .messages.find((m) => m.kind === 'user')?.agentText ?? '',
    );
    const row = {
      scenario,
      engine: first?.engine,
      promptTokens: first?.prompt,
      cachedTokens: first?.cached,
      computed: first === undefined ? undefined : first.prompt - first.cached,
      ttftMs: ttft,
      pathLines: body.split('\n').filter((l) => /^Attached (file|folder|image): \//.test(l)),
      // What the composer's prime did between the paste and Enter.
      prefill: primes
        .map((p) =>
          p.what === 'prime'
            ? `prime ${p.prefixChars} chars (${p.historyTurns} turns)`
            : p.what === 'primed'
              ? `primed ${p.success === false ? `FAILED ${p.error ?? ''}` : `processed=${p.processedN ?? '?'} of ${p.promptN ?? '?'}`}`
              : p.what === 'skipped'
                ? `skipped: ${p.because}${p.prefixChars !== undefined ? ` (${p.prefixChars} chars)` : ''}`
                : String(p.what),
        )
        .reduce((out, line) => {
          // Consecutive repeats collapse: the gate runs on every render.
          const last = out[out.length - 1];
          if (last !== undefined && last.line === line) last.n += 1;
          else out.push({ line, n: 1 });
          return out;
        }, [])
        .map((e) => (e.n > 1 ? `${e.line} ×${e.n}` : e.line)),
    };
    rows.push(row);
    log(JSON.stringify(row));
  }

  writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));
  console.log('\nscenario       prompt  cached  computed  TTFT');
  for (const r of rows) {
    console.log(
      `${r.scenario.padEnd(14)} ${String(r.promptTokens).padStart(6)}  ${String(r.cachedTokens).padStart(6)}  ${String(r.computed).padStart(8)}  ${r.ttftMs}ms`,
    );
  }
  /*
   * Judged on the engine's own count, and only after an idle: a prime that
   * covered everything fixed leaves the typed question — a few dozen tokens —
   * to compute. With IDLE_MS=0 a big number is the expected contrast.
   */
  if (IDLE_MS > 0) {
    for (const r of rows) {
      check(
        r.computed !== undefined && r.computed < 400,
        `${r.scenario}: Enter computed ${r.computed} of ${r.promptTokens} prompt tokens — the prime did not cover the attachment`,
      );
    }
  }
} catch (error) {
  check(false, `probe crashed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await finish();
}
