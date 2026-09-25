/**
 * AFTER ⌘Z TAKES A MESSAGE BACK, DOES THE NEXT ONE STILL HIT THE PROMPT CACHE?
 *
 * the user's standing rule for chat work: it is not done until prefill/TTFT is
 * checked. Unsending stops a turn mid-flight and forks pi's session to before
 * the message (a new session file, a new harness wiring) — exactly the kind of
 * boundary that has silently cost a full re-prefill before (the system prompt
 * rebuilt differently, a tool block reordered). So this measures it, on a real
 * model, the way a person would do it:
 *
 *   1  colours    — a first message (cold-ish, not compared)
 *   2  fruits     — a normal follow-up: THE BASELINE
 *   3  countries  — sent, then ⌘Z about a second later (its turn is running)
 *   4  animals    — the next message after the unsend: THE QUESTION
 *   5  metals     — one more ordinary follow-up after it
 *
 * For every request it reports what the engine itself says it re-read
 * (`prompt_tokens - cached_tokens`, from the provider's PI_DIAG_PROMPTS usage
 * line) and the send→first-token time, then diffs the bodies of request 3 (the
 * one taken back) and request 4 to show where they part company — it should be
 * the last user message and nothing before it.
 *
 * THE FIRST SEND'S TIMING MATTERS, so it is a knob. The session's system prompt
 * is frozen once: by the warm-up, before the chat has a folder (the folder then
 * arrives as a note), or by a first message that beats the warm-up, after the
 * folder was pushed (the prompt then names it). A fork that rebuilds the prompt
 * breaks one or the other; run both:
 *
 *   FIRST=quick  send the first message the moment the model is up (named)
 *   FIRST=settled  (default) wait for the warm-up first (note)
 *
 * Real model, throwaway HOME, real library + cache, hidden window, focus guard.
 * It loads a model, so it runs under the HEAVY lock (which waits for the user's own
 * Bobble to have no model up):
 *
 *   MODEL=qwen3.5-4b-mtp OUT=/tmp/unsend-prefill FIRST=quick \
 *     node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/unsend-prefill-probe.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { focusComplaint, frontmostApp, probeHome } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'unsend-prefill');
mkdirSync(OUT, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const LIBRARY = process.env.PI_DESKTOP_MODELS_DIR ?? path.join(homedir(), 'Bobble', 'Models');
const DIAG = path.join(OUT, 'prompts.log');
writeFileSync(DIAG, '');
rmSync(`${DIAG}.bodies.jsonl`, { force: true });

const home = probeHome('unsend-prefill');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }),
);
const userData = mkdtempSync(path.join(tmpdir(), 'unsend-prefill-udd-'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const check = (ok, msg) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

const before = frontmostApp();
const app = await _electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: LIBRARY,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_DIAG_PROMPTS: DIAG,
    PI_DIAG_PROMPTS_FULL: '1',
  },
});

const usageLines = () =>
  readFileSync(DIAG, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('[pi-diag-usage]'))
    .map((l) => ({
      engine: /engine=(\S+)/.exec(l)?.[1],
      prompt: Number(/prompt_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
      cached: Number(/cached_tokens=(\d+)/.exec(l)?.[1] ?? Number.NaN),
    }));
const bodies = () =>
  readFileSync(`${DIAG}.bodies.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l).body);

const rows = [];
let win;
try {
  win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  await win.waitForTimeout(1500);

  log(`starting ${MODEL}…`);
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    (m) => {
      const s = window.__llm_store?.().getState().status;
      return s?.model?.id === m && s.phase === 'ready' && s.serverRunning === true;
    },
    MODEL,
    { timeout: 600_000 },
  );
  await win.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  const status = await win.evaluate(() => window.__llm_store().getState().status);
  const port = Number(/:(\d+)\/v1/.exec(status.baseUrl ?? '')?.[1] ?? 0) || null;
  log(`model ${status.model?.id} on ${status.baseUrl} (engine ${status.engine ?? '?'})`);

  /**
   * The slot is idle — nothing (a warm-up, post-turn naming or review) is on it,
   * so a send's first-token time is the send's own. llama.cpp says so on
   * `/slots`; an MLX engine has no such endpoint, and there the only honest wait
   * is past the harness's post-turn pause (2.5 s) and the work it starts.
   */
  const POST_TURN_QUIET_MS = 7000;
  const slotIdle = async (quietMs = 3000, timeoutMs = 120_000) => {
    if (port === null) {
      await win.waitForTimeout(POST_TURN_QUIET_MS);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let idleSince = Date.now();
    while (Date.now() < deadline) {
      let slots;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/slots`);
        slots = res.ok ? await res.json() : null;
      } catch {
        slots = null;
      }
      if (!Array.isArray(slots)) {
        await win.waitForTimeout(POST_TURN_QUIET_MS);
        return;
      }
      if (slots.some((s) => s.is_processing === true)) idleSince = Date.now();
      else if (Date.now() - idleSince >= quietMs) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const turnIdle = () =>
    win.waitForFunction(
      () => {
        const s = window.__pi_store().getState();
        return s.agent.isStreaming !== true && s.promptInFlight !== true;
      },
      undefined,
      { timeout: 240_000 },
    );
  /** Enter → the first token of the NEW assistant row (thinking or text). */
  const firstToken = async (assistantsBefore) => {
    const t0 = Date.now();
    await win.waitForFunction(
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
      assistantsBefore,
      { timeout: 180_000, polling: 20 },
    );
    return Date.now() - t0;
  };
  const assistants = () =>
    win.evaluate(
      () =>
        window
          .__pi_store()
          .getState()
          .messages.filter((m) => m.kind === 'assistant').length,
    );
  const type = async (text) => {
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.press('Meta+a');
    await win.keyboard.press('Backspace');
    await win.keyboard.type(text);
  };
  const turn = async (label, text, { idleFirst = true } = {}) => {
    if (idleFirst) await slotIdle();
    const usageBefore = usageLines().length;
    const n = await assistants();
    await type(text);
    await win.keyboard.press('Enter');
    const ttft = await firstToken(n);
    await turnIdle();
    await win.waitForTimeout(300);
    const usage = usageLines().slice(usageBefore);
    const first = usage[0];
    const row = {
      label,
      ttftMs: ttft,
      engine: first?.engine,
      prompt: first?.prompt,
      cached: first?.cached,
      reread: first === undefined ? undefined : first.prompt - first.cached,
      requests: usage.length,
    };
    rows.push(row);
    log(JSON.stringify(row));
    return row;
  };

  // See FIRST in the header: whether the first message beats the warm-up.
  if (process.env.FIRST !== 'quick') await slotIdle(3000, 240_000);
  await turn('1 colours (first)', 'Name three colours, one word each.', {
    idleFirst: process.env.FIRST !== 'quick',
  });
  const base = await turn('2 fruits (baseline follow-up)', 'Name three fruits, one word each.');

  /* 3. Sent, and taken back about a second into its turn. */
  await slotIdle();
  const n3 = await assistants();
  const bodies3 = bodies().length;
  await type('Name three countries, one word each.');
  await win.keyboard.press('Enter');
  const ttft3 = await firstToken(n3);
  await win.waitForTimeout(Math.max(0, 1000 - ttft3));
  const sentFile = await win.evaluate(() => window.__pi_store().getState().session?.sessionFile);
  await win.keyboard.press('Meta+z');
  await turnIdle();
  await win
    .waitForFunction((f) => window.__pi_store().getState().session?.sessionFile !== f, sentFile, {
      timeout: 20_000,
    })
    .catch(() => undefined);
  await win.waitForTimeout(800);
  const afterZ = await win.evaluate(() => ({
    users: window
      .__pi_store()
      .getState()
      .messages.filter((m) => m.kind === 'user')
      .map((m) => m.text),
    file: window.__pi_store().getState().session?.sessionFile,
    composer: document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
  }));
  log('after ⌘Z:', JSON.stringify({ ...afterZ, sentFile, ttft3 }));
  check(
    !afterZ.users.includes('Name three countries, one word each.'),
    'the message was taken back',
  );
  check(afterZ.composer === 'Name three countries, one word each.', 'its text is back in the box');
  check(
    afterZ.file !== sentFile,
    `pi moved onto the rewound branch (${sentFile} → ${afterZ.file})`,
  );
  await win.screenshot({ path: path.join(OUT, 'after-unsend.png') });

  const next = await turn('4 animals (after the unsend)', 'Name three animals, one word each.');
  await turn('5 metals (follow-up after that)', 'Name three metals, one word each.');
  await win.screenshot({ path: path.join(OUT, 'after-next.png') });

  /* Where does the request after the unsend part company with the one taken back? */
  const all = bodies();
  const unsent = all[bodies3];
  const after = all[bodies3 + 1];
  if (unsent !== undefined && after !== undefined) {
    const firstDiff = (a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
      return n;
    };
    const sysA = unsent.messages?.find((m) => m.role === 'system')?.content ?? '';
    const sysB = after.messages?.find((m) => m.role === 'system')?.content ?? '';
    const toolsSame = JSON.stringify(unsent.tools ?? []) === JSON.stringify(after.tools ?? []);
    const ma = unsent.messages ?? [];
    const mb = after.messages ?? [];
    let firstMsg = -1;
    for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
      if (JSON.stringify(ma[i]) !== JSON.stringify(mb[i])) {
        firstMsg = i;
        break;
      }
    }
    const diff = {
      systemSame: sysA === sysB,
      systemDiffAt: sysA === sysB ? null : firstDiff(sysA, sysB),
      toolsSame,
      messages: `${ma.length} → ${mb.length}`,
      firstDifferingMessage: firstMsg,
      itsRole: firstMsg >= 0 ? `${ma[firstMsg]?.role} → ${mb[firstMsg]?.role}` : null,
    };
    log('request taken back vs the next one:', JSON.stringify(diff));
    check(diff.systemSame && diff.toolsSame, 'same system prompt and tools across the unsend');
    check(
      firstMsg === ma.length - 1 || firstMsg === -1,
      `the two requests differ only at the last (user) message (first difference at #${firstMsg} of ${ma.length})`,
    );
  } else {
    log('bodies not captured for the comparison', JSON.stringify({ bodies3, total: all.length }));
  }

  if (base.reread !== undefined && next.reread !== undefined) {
    check(
      next.reread < Math.max(400, base.reread * 3),
      `the message after the unsend re-read ${next.reread} tokens (baseline follow-up ${base.reread}) of ${next.prompt} — the conversation stayed cached`,
    );
  } else {
    check(false, 'usage lines were captured for the baseline and the message after the unsend');
  }
  writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));
} finally {
  const during = frontmostApp();
  await app.close().catch(() => undefined);
  const complaint = focusComplaint(before, during);
  if (complaint !== null) check(false, complaint);
  if (process.env.PI_E2E_KEEP_HOME !== '1') {
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
  console.table(rows);
  if (failures.length > 0) {
    console.error(`unsend-prefill: ${failures.length} failure(s)`);
    process.exitCode = 1;
  } else console.log('unsend-prefill OK');
}
