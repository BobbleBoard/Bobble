/**
 * DEEPER THAN THE SURFACE — the user (2026-09-15): "why don't you try a bit deeper
 * testing and ensure you can get expected and proper behavior eg. calling
 * subagents/tools to get office docs created/edited rather than doing it
 * manually … we should for example be able to get really good datavisuals,
 * tables, svgs drawings, and get the same quality standalone as when we ask
 * for presentations or documents (which should utilize these of course) and
 * the ability to find data/extract anything from the web, really any
 * research/presentation task should be able to be achieved relatively easily
 * and findings presented well. similar items apply to coding … note issues
 * you find, run these deeper tests all headed."
 *
 * Real app, real model, one fresh chat per task, HEADED (PI_E2E_HEADED: the
 * window is on screen and never takes focus). Each task is a plain request a
 * person would type; what is judged is what a person would judge — did the
 * right tool get used rather than a hand-rolled substitute, did a file of the
 * right kind land in the chat's folder, was it presented, did the reply say
 * so — plus the time it took and every tool error along the way.
 *
 *   MODEL=qwen3.5-4b-mtp ENGINE=rapid-mlx/mtp TASKS=svg,chart,… \
 *     SHOT_DIR=/tmp/deep node apps/desktop/tests/e2e/deep-tasks-probe.mjs
 *
 * Results: <SHOT_DIR>/results.md (one row per task) and a screenshot per task.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ENGINE = process.env.ENGINE ?? 'rapid-mlx/mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/deep';
const TURN_CAP_MS = Number(process.env.TURN_CAP_S ?? 720) * 1000;
mkdirSync(SHOT_DIR, { recursive: true });

/** One task: the request as typed, and what a good outcome looks like. */
const TASKS = [
  {
    id: 'svg',
    prompt: 'Draw a simple bicycle as an SVG drawing and show it to me.',
    files: [/\.svg$/i],
    tools: [/\bsvg\b/],
    present: true,
    forbid: [/<svg[\s>]/i], // hand-written markup in a bash heredoc
  },
  {
    id: 'chart',
    prompt:
      'Here are units sold (thousands) by year: 2021: 12, 2022: 19, 2023: 27, 2024: 35. Make a bar chart of it and show me.',
    files: [/\.(svg|png)$/i],
    // A chart of data is the office pipeline's `chart` kind — drawn from the
    // numbers, never painted (media generate image) or hand-plotted.
    tools: [/\boffice\b/],
    forbid: [/media generate image|matplotlib/],
    present: true,
  },
  {
    id: 'table',
    prompt:
      'Make a comparison table of Python, Rust and Go with rows for typing, memory management, concurrency model and typical use.',
    // A markdown table — in the reply, or in a file it wrote and presented
    // (a 4B put it in comparison_table.md and opened it: also right).
    replyOrFile: [/\|.*\|.*\|/],
  },
  {
    id: 'docx',
    prompt:
      'Write a one-page memo as a Word document (docx) to the team proposing we move our daily standups to async written updates, and open it for me.',
    files: [/\.docx$/i],
    tools: [/\boffice\b|\.docx/], // `write x.docx` IS the pipeline (withOfficeFormats)
    present: true,
    forbid: [/python-docx|from docx import|import docx/],
  },
  {
    id: 'deck',
    prompt:
      'Make a 4-slide presentation (pptx) about the growth of solar power this decade, with one slide holding a bar chart of rough capacity numbers, and show it to me.',
    files: [/\.pptx$/i],
    tools: [/\boffice\b|\.pptx/],
    present: true,
    forbid: [/python-pptx|from pptx import|import pptx/],
  },
  {
    id: 'web',
    prompt:
      'Find out how tall the Eiffel Tower is including its antennas, and tell me which page you got that from.',
    tools: [/\b(web|browser|chrome)\b/],
    reply: [/\b3[23]\d(\.\d+)?\s?m|\b1,?0[0-9]{2}\s?f(ee)?t/i, /https?:\/\//],
  },
  {
    id: 'research-deck',
    prompt:
      'Research the three tallest buildings in the world (name, city, height) on the web and put them in a short deck (pptx), then show it to me.',
    files: [/\.pptx$/i],
    tools: [/\b(web|browser|chrome)\b/, /\boffice\b/],
    present: true,
  },
  {
    id: 'code',
    prompt:
      'Write a Python script that prints the first 20 Fibonacci numbers, run it, and show me the output.',
    files: [/\.py$/i],
    tools: [/python3?\b/],
    reply: [/4181/], // the 19th number (0-based) — proof the output was read back
  },
  {
    id: 'office-edit',
    prompt:
      'Create a Word document called notes.docx with the title "Draft" and one short paragraph about tea. Then change its title to "Final" and show me the result.',
    files: [/notes\.docx$/i],
    tools: [/\boffice\b|\.docx/],
    present: true,
  },
  {
    id: 'subagents',
    prompt:
      'Use two subagents in parallel: one writes a haiku about the sea, the other a haiku about mountains. Then put both into poems.md and show it to me.',
    files: [/poems\.md$/i],
    tools: [/subagent|spawn/],
    present: true,
  },
];
const WANT = new Set((process.env.TASKS ?? TASKS.map((t) => t.id).join(',')).split(','));

const home = probeHome('deep-tasks');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL }, experimentalGeneration: true }, null, 2)}\n`,
);
const { app, page, shot, check, finish } = await launchApp('deep-tasks', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_DESKTOP_GEN: '1',
    PI_E2E_HEADED: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rows = [];

/** Every file under a folder (relative), newest first. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push({ rel: path.relative(dir, p), bytes: st.size, mtime: st.mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await sleep(3000);

  // The model, up and pointed at by pi (tool-surface-probe's recipe).
  log(`starting ${MODEL} on ${ENGINE}…`);
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  const [engine, spec] = ENGINE.split('/');
  const already = await page.evaluate(
    ({ engine, spec }) => {
      const s = window.__llm_store().getState().status;
      return s.profile?.engine === engine && s.profile?.spec === spec;
    },
    { engine, spec },
  );
  if (ENGINE !== 'llamacpp/none' && !already) {
    await page.evaluate(
      ({ engine, spec }) => window.__llm_store().getState().switchProfile(engine, spec),
      { engine, spec },
    );
    await page.waitForFunction(
      ({ engine, spec }) => {
        const s = window.__llm_store().getState().status;
        return s.phase === 'ready' && s.profile?.engine === engine && s.profile?.spec === spec;
      },
      { engine, spec },
      { timeout: 300_000 },
    );
  }
  const want = ENGINE.startsWith('llamacpp') ? MODEL : `${MODEL}@${engine}`;
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    want,
    { timeout: 120_000 },
  );
  await sleep(4000);
  log(`model ${want} up`);

  for (const task of TASKS) {
    if (!WANT.has(task.id)) continue;
    log(`── ${task.id}: ${task.prompt}`);
    // A fresh chat for every task: its own folder, its own transcript.
    await page.click('[data-testid="new-chat"]').catch(() => {});
    await sleep(1500);
    const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(task.prompt);
    await page.keyboard.press('Enter');
    const t0 = Date.now();
    // The turn ends when the assistant has replied with text and nothing is
    // streaming; a stuck turn ends at the cap.
    const ended = await page
      .waitForFunction(
        (k) => {
          const s = window.__pi_store().getState();
          const m = s.messages.slice(k);
          const replied = m.some(
            (x) =>
              x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          );
          return replied && !s.messages.some((x) => x.isStreaming) && s.promptInFlight !== true;
        },
        n,
        { timeout: TURN_CAP_MS, polling: 1000 },
      )
      .then(() => true)
      .catch(() => false);
    // Let a follow-up (present, a nudge) land.
    await sleep(6000);
    const secs = Math.round((Date.now() - t0) / 1000);
    const tail = await page.evaluate((k) => {
      const s = window.__pi_store().getState();
      const m = s.messages.slice(k);
      const results = new Map();
      for (const x of m) if (x.kind === 'toolResult') results.set(x.toolCallId, x);
      const calls = [];
      for (const x of m) {
        if (x.kind !== 'assistant') continue;
        for (const b of x.blocks ?? []) {
          if (b.type !== 'toolCall') continue;
          const r = results.get(b.id);
          calls.push({
            name: b.name,
            command:
              typeof b.arguments?.command === 'string'
                ? b.arguments.command
                : JSON.stringify(b.arguments ?? {}),
            error: r?.isError === true,
            result: String(r?.text ?? '').slice(0, 300),
          });
        }
      }
      const text = m
        .filter((x) => x.kind === 'assistant')
        .flatMap((x) => (x.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text))
        .join('\n');
      const errors = m
        .filter((x) => x.kind === 'assistant' && x.errorMessage)
        .map((x) => x.errorMessage);
      return {
        calls,
        text,
        errors,
        presented: document.querySelectorAll('[data-testid="presented"]').length,
        // The canvas's own failure text (file-tabs.ts): a tab opened for a
        // path that could not be read.
        canvasError: document.body.innerText.includes('Could not read this file')
          ? 'a canvas tab says "Could not read this file"'
          : null,
        workspace: window.__pi_workspace?.() ?? null,
      };
    }, n);
    const files = tail.workspace ? filesUnder(tail.workspace) : [];
    const cmdText = tail.calls.map((c) => c.command).join('\n');
    const verdicts = [];
    const ok = (name, pass, note = '') => verdicts.push({ name, pass, note });
    ok('turn ended', ended, ended ? `${secs}s` : `cap ${TURN_CAP_MS / 1000}s`);
    if (task.files) {
      const hit = task.files.map((re) => files.find((f) => re.test(f.rel)));
      ok(
        'file of the right kind',
        hit.every(Boolean),
        hit.map((f, i) => (f ? `${f.rel} (${f.bytes} B)` : `none for ${task.files[i]}`)).join('; '),
      );
    }
    if (task.tools) {
      for (const re of task.tools) ok(`used ${re}`, re.test(cmdText), '');
    }
    if (task.forbid) {
      for (const re of task.forbid) ok(`did not hand-roll ${re}`, !re.test(cmdText), '');
    }
    if (task.present) ok('presented', tail.presented > 0, `${tail.presented} card(s)`);
    if (task.reply) {
      for (const re of task.reply) ok(`reply has ${re}`, re.test(tail.text), '');
    }
    if (task.replyOrFile) {
      const written = files
        .filter((f) => /\.(md|txt|html)$/i.test(f.rel))
        .map((f) => {
          try {
            return readFileSync(path.join(tail.workspace ?? '', f.rel), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
      for (const re of task.replyOrFile) {
        ok(`reply or a written file has ${re}`, re.test(tail.text) || re.test(written), '');
      }
    }
    const toolErrors = tail.calls.filter((c) => c.error);
    ok(
      'no tool errors',
      toolErrors.length === 0,
      toolErrors.map((c) => `${c.command.slice(0, 60)} → ${c.result.slice(0, 120)}`).join(' | '),
    );
    ok('no turn errors', tail.errors.length === 0, tail.errors.join(' | '));
    ok('canvas ok', tail.canvasError === null, tail.canvasError ?? '');
    const passed = verdicts.filter((v) => v.pass).length;
    rows.push({
      task: task.id,
      secs,
      calls: tail.calls.length,
      passed,
      total: verdicts.length,
      verdicts,
      files: files.slice(0, 8),
      text: tail.text.slice(0, 500),
    });
    log(
      `   ${passed}/${verdicts.length} in ${secs}s, ${tail.calls.length} calls${tail.workspace ? ` → ${tail.workspace}` : ''}`,
    );
    for (const v of verdicts) if (!v.pass) log(`   FAIL ${v.name} ${v.note}`);
    for (const c of tail.calls)
      log(
        `      ${c.error ? 'ERR ' : '    '}${c.name} ${c.command.slice(0, 120).replace(/\n/g, ' ')}`,
      );
    await shot(`task-${task.id}`);
    writeFileSync(
      path.join(SHOT_DIR, `task-${task.id}.json`),
      JSON.stringify({ ...rows.at(-1), calls: tail.calls, text: tail.text }, null, 2),
    );
  }
} finally {
  const md = [
    `# Deep tasks — ${MODEL} on ${ENGINE}`,
    '',
    '| task | time | calls | verdicts | failed |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.task} | ${r.secs}s | ${r.calls} | ${r.passed}/${r.total} | ${
          r.verdicts
            .filter((v) => !v.pass)
            .map((v) => `${v.name}${v.note ? ` (${v.note.slice(0, 80)})` : ''}`)
            .join('; ') || '—'
        } |`,
    ),
  ].join('\n');
  writeFileSync(path.join(SHOT_DIR, 'results.md'), `${md}\n`);
  log(`\n${md}`);
  for (const r of rows)
    for (const v of r.verdicts) if (!v.pass) check(false, `${r.task}: ${v.name} ${v.note}`);
  await finish();
}
