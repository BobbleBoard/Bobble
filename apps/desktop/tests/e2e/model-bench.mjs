/**
 * model-bench.mjs — the same ten jobs, twice, through the real app.
 *
 * the user: "attempt to run a bunch of stuff with it (no corp) and see how it does
 * relative to running the exact same things right after (reasonably complex,
 * step up little by little, maybe 10 test suite same on each) … nothing
 * extremely simple, eg. each task minimum difficulty would be something like
 * making a presentation, or html visualization of something that had to be
 * researched and some specific information pulled."
 *
 * WHY THROUGH THE APP AND NOT llama-server DIRECTLY. The question is not which
 * model emits better tokens; it is which one gets a job DONE — which needs the
 * harness, the tools, the file system and the system prompt the app actually
 * ships. A raw completion benchmark would measure something nobody experiences.
 *
 * WHAT IS MEASURED, per task: wall time, first paint, first text, tool calls,
 * token usage, whether the turn ended in an error, and — the part that decides
 * pass/fail — the FILES it left behind and whether they contain the specifics
 * the prompt demanded. A model that writes a confident paragraph and no file
 * has failed the task, and only the last of those numbers can tell you.
 *
 * ONE CHAT PER TASK, so a run that goes badly cannot poison the next task's
 * context, and so each task gets its own working folder to be graded from.
 *
 *   MODEL   catalog id to pin           (required)
 *   TASKS   path to the task JSON       (default ./bench-tasks.json)
 *   OUT     results dir                 (required)
 *   CAP_MS  per-task ceiling            (default 480000 — 8 minutes)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MODEL = process.env.MODEL;
const OUT = process.env.OUT;
const CAP_MS = Number(process.env.CAP_MS ?? 480_000);
const ALL_TASKS = JSON.parse(
  readFileSync(process.env.TASKS ?? path.join(appRoot, 'tests/e2e/bench-tasks.json'), 'utf8'),
);
/*
 * START lets a run pick up where a dead one stopped. MEASURED: the app died
 * outright partway through a ten-task run — once, not reproducibly — and
 * without this the only options were re-running eight completed tasks or
 * throwing the run away.
 */
const TASKS = ALL_TASKS.slice(Number(process.env.START ?? 0));
if (MODEL === undefined || OUT === undefined) {
  console.error('model-bench: MODEL and OUT are required');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

/*
 * PIN THE MODEL WHERE THE APP READS IT. Model selection is NOT in Electron's
 * userData — it lives in ~/.pi/desktop/settings.json and is shared by every
 * launch regardless of --user-data-dir, which is why a probe with a fresh
 * profile still runs whatever was last chosen by hand.
 */
const settingsPath = path.join(homedir(), '.pi/desktop/settings.json');
const settingsBackup = readFileSync(settingsPath, 'utf8');
const settings = JSON.parse(settingsBackup);
settings.modelSelection = { mode: 'model', modelId: MODEL };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(`[bench] pinned ${MODEL}`);

const workRoot = path.join(homedir(), 'Bobble');
const listWork = () => {
  try {
    return execFileSync(
      '/bin/sh',
      ['-c', `find ${JSON.stringify(workRoot)} -type f -newermt '-1 second' 2>/dev/null | head -1`],
      { encoding: 'utf8' },
    );
  } catch {
    return '';
  }
};
listWork();

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-bench-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const mainLog = [];
app.process().on('exit', (code, sig) => console.log(`[bench] ELECTRON EXITED code=${code} signal=${sig}`));
for (const s of [app.process().stdout, app.process().stderr]) {
  s?.on('data', (d) => {
    for (const line of String(d).split('\n'))
      if (line.trim() !== '') mainLog.push(line.slice(0, 400));
  });
}

const results = [];
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20000 });
  await page.evaluate(() => {
    const st = window.__settings_store?.();
    st?.getState().update({ effort: 'max', effortMode: 'level' });
  });

  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i];
    // A fresh chat per task: its own context and its own working folder.
    if (i > 0) {
      /*
       * WAIT FOR THE NEW CHAT TO EXIST, don't sleep at it. MEASURED on the
       * first Ling run: a fixed 2.5s wait raced the session reset, the typed
       * prompt went nowhere, and the task sat until the 7-minute cap with the
       * server at 0% CPU — a harness failure that reads exactly like a model
       * that cannot answer.
       */
      await page.click('[data-testid="new-chat"]').catch(() => undefined);
      await page
        .waitForFunction(
          () => (window.__pi_store?.().getState?.().messages ?? []).length === 0,
          undefined,
          { timeout: 30_000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
    }
    const before = await page
      .evaluate(() => window.__pi_store?.().getState?.().messages?.length ?? 0)
      .catch(() => 0);
    const startedAt = Date.now();
    /*
     * AND CONFIRM THE SEND LANDED. Enter into a composer that is still
     * re-mounting is silently dropped; the only proof is a user row appearing
     * in the store. One retry, then give up loudly rather than burning the cap.
     */
    let sent = false;
    for (let attempt = 0; attempt < 2 && !sent; attempt++) {
      await page.click('[data-testid="composer-input"]').catch(() => undefined);
      await page.keyboard.type(task.prompt).catch(() => undefined);
      await page.keyboard.press('Enter').catch(() => undefined);
      sent = await page
        .waitForFunction(
          (n) =>
            (window.__pi_store?.().getState?.().messages ?? [])
              .slice(n)
              .some((m) => m.kind === 'user'),
          before,
          { timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!sent) console.log(`[${i + 1}/${TASKS.length}] ${task.id} — send did not land, retrying`);
    }
    console.log(`\n[${i + 1}/${TASKS.length}] ${task.id} — sent${sent ? '' : ' (NEVER LANDED)'}`);

    const firstPaint = await page
      .waitForFunction(
        (n) =>
          (window.__pi_store?.().getState?.().messages ?? [])
            .slice(n)
            .some((m) => m.kind === 'assistant' && (m.blocks ?? []).length > 0),
        before,
        { timeout: 120_000 },
      )
      .then(() => Date.now() - startedAt)
      .catch(() => null);

    /*
     * DONE = an assistant message exists after ours and nothing is streaming.
     * Checked on a poll rather than a single waitForFunction so a turn that
     * runs past the cap still yields its partial state instead of throwing the
     * whole run away.
     */
    let done = false;
    while (Date.now() - startedAt < CAP_MS) {
      /*
       * A FAILED POLL IS NOT A FAILED RUN. The renderer's execution context is
       * destroyed and rebuilt whenever the pi bridge restarts — which it does on
       * the first turn of a session, milliseconds after the send — and an
       * unguarded `evaluate` there throws "Execution context was destroyed" and
       * takes the whole ten-task run with it. Killed the first attempt one
       * second into task 1.
       */
      done = await page
        .evaluate((n) => {
          const ms = window.__pi_store?.().getState?.().messages ?? [];
          const after = ms.slice(n);
          if (!after.some((m) => m.kind === 'assistant')) return false;
          return !after.some((m) => m.isStreaming === true);
        }, before)
        .catch(() => false);
      if (done) break;
      await page.waitForTimeout(3000).catch(() => undefined);
    }
    const wallMs = Date.now() - startedAt;

    const state = await page
      .evaluate((n) => {
        const st = window.__pi_store?.().getState?.();
        const ms = (st?.messages ?? []).slice(n);
        let toolCalls = 0;
        let usage;
        let text = '';
        const tools = [];
        for (const m of ms) {
          if (m.kind !== 'assistant') continue;
          if (m.usage !== undefined) usage = m.usage;
          for (const b of m.blocks ?? []) {
            if (b.type === 'toolCall') {
              toolCalls++;
              if (tools.length < 40) tools.push(b.name ?? b.tool ?? '?');
            }
            if (b.type === 'text') text += b.text ?? '';
          }
        }
        return {
          toolCalls,
          tools,
          usage,
          text: text.slice(0, 4000),
          /*
           * THE WORKING FOLDER, and it is not on the session object. MEASURED on
           * the first Ling run: `session.cwd` is undefined, so every task reported
           * zero files while the model was in fact writing them — a grader that
           * would have failed a passing model. The project store is where the
           * resolved workspace path actually lives.
           */
          cwd: window.__pi_project?.().getState?.().activePath ?? st?.session?.cwd ?? null,
          sessionFile: st?.session?.sessionFile ?? null,
        };
      }, before)
      .catch(() => ({
        toolCalls: 0,
        tools: [],
        usage: undefined,
        text: '',
        cwd: null,
        sessionFile: null,
      }));

    const files = [];
    if (state.cwd !== null && existsSync(state.cwd)) {
      try {
        const out = execFileSync(
          '/bin/sh',
          [
            '-c',
            `find ${JSON.stringify(state.cwd)} -type f -not -path '*/.git/*' -not -name '.DS_Store' | head -40`,
          ],
          { encoding: 'utf8' },
        );
        for (const f of out.split('\n').filter(Boolean)) {
          let bytes = 0;
          let head = '';
          try {
            const buf = readFileSync(f);
            bytes = buf.length;
            head = buf.toString('utf8').slice(0, 1500);
          } catch {}
          files.push({ path: f.replace(state.cwd, '.'), bytes, head });
        }
      } catch {}
    }

    const row = {
      id: task.id,
      difficulty: task.difficulty,
      wallMs,
      finished: done,
      firstPaintMs: firstPaint,
      toolCalls: state.toolCalls,
      tools: state.tools,
      usage: state.usage ?? null,
      cwd: state.cwd,
      files: files.map((f) => ({ path: f.path, bytes: f.bytes })),
      textChars: state.text.length,
      text: state.text,
      fileHeads: Object.fromEntries(files.slice(0, 6).map((f) => [f.path, f.head])),
    };
    results.push(row);
    console.log(
      `[${i + 1}/${TASKS.length}] ${task.id}: ${done ? 'finished' : 'CAPPED'} in ${Math.round(wallMs / 1000)}s · ` +
        `${state.toolCalls} tool calls · ${files.length} files · ${state.text.length} chars`,
    );
    await page.screenshot({
      path: path.join(OUT, `${String(i + 1).padStart(2, '0')}-${task.id}.png`),
    });
    writeFileSync(
      path.join(OUT, 'results.json'),
      JSON.stringify({ model: MODEL, results }, null, 2),
    );
  }
} finally {
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ model: MODEL, results }, null, 2));
  writeFileSync(path.join(OUT, 'main.log'), mainLog.join('\n'));
  writeFileSync(settingsPath, settingsBackup);
  await app.close().catch(() => undefined);
  console.log(`\n[bench] ${results.length} tasks → ${OUT}`);
}
