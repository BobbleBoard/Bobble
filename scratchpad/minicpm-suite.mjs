#!/usr/bin/env node
/**
 * MiniCPM5 2B across every kind of task this harness can pose.
 *
 * The user: "test minicpm 5 more comprehensively i'm very interested in it's
 * performance and speed for all different types of tasks."
 *
 * Five kinds, chosen because each fails differently:
 *
 *   recall   no tools at all — the model alone, reading a passage
 *   compute  the shell: write a program, run it, report a number it cannot guess
 *   chrome   computer use through a DOM, which needs no eyes
 *   maps     computer use through an Accessibility tree, indexed elements
 *   blender  computer use with NO tree — three window buttons and a picture
 *
 * The last one is included deliberately even though MiniCPM5 is text-only and
 * publishes no mmproj: "it cannot see" is a fact about the model worth having
 * measured rather than assumed, and the run records which wall it hits.
 *
 * A reference model runs the identical set, because "59 tok/s" and "passed 4 of
 * 5" mean nothing on their own — the question is always "compared to what".
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');

const OUT = process.env.SUITE_OUT ?? `${REPO_ROOT}/scratchpad/demos/minicpm-suite`;
mkdirSync(OUT, { recursive: true });
const LEDGER = path.join(OUT, 'ledger.jsonl');

const MODELS = (process.env.SUITE_MODELS ?? 'minicpm5-2b,qwen3.5-4b-mtp').split(',');
const TASKS = [
  { key: 'recall', demo: 'demo-recall.mjs', app: null },
  { key: 'compute', demo: 'demo-compute.mjs', app: null },
  { key: 'chrome', demo: 'demo-apple.mjs', app: 'Google Chrome' },
  { key: 'maps', demo: 'demo-maps.mjs', app: 'Maps' },
  { key: 'browser', demo: 'demo-browser.mjs', app: null },
  { key: 'blender', demo: 'demo-blender.mjs', app: 'Blender' },
];
/** The cheap, model-only tasks are repeated: one sample says nothing about a
 *  speed that varies with what else the machine is doing. */
/* Three of everything. A 2B varies enough run to run that one sample cannot
   tell a harness bug from the model having a bad turn — which is the whole
   question being asked of this suite. */
const REPEATS = Number(process.env.SUITE_REPEATS ?? 3);

const run = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: err === null, stdout, stderr }),
    );
  });

const started = Date.now();
for (const model of MODELS) {
  for (const task of TASKS) {
    const n = REPEATS;
    for (let i = 1; i <= n; i++) {
      const name = `suite-${model}-${task.key}${n > 1 ? `-${i}` : ''}`;
      const t0 = Date.now();
      console.log(`\n[${name}]`);
      /* Chrome's task is only a task while the page is on 1TB. */
      if (task.key === 'chrome') await run('python3', ['/tmp/reset1tb.py'], {});
      const res = await run('node', [`apps/desktop/tests/e2e/${task.demo}`], {
        MAC_CU_MODEL: model,
        RUN_NAME: name,
        POWER: 'low',
      });
      const log = `${res.stdout}\n${res.stderr}`;
      writeFileSync(path.join(OUT, `${name}.log`), log);
      const pick = (re) => (log.match(re) ?? [])[1] ?? null;
      const row = {
        name,
        model,
        task: task.key,
        i,
        ok: res.ok,
        seconds: Math.round((Date.now() - t0) / 1000),
        verdict: pick(/"verdict":"(\w+)"/),
        invalid: /^INVALID: /m.test(log) ? (log.match(/^INVALID: (.*)$/m) ?? [])[1] : null,
        genTps: pick(/^speed: ([\d.]+) tok\/s generated/m),
        promptTps: pick(/tok\/s generated, ([\d.]+) tok\/s prompt/m),
        calls: (log.match(/^tool calls \((\d+)\)/m) ?? [])[1] ?? null,
        prefill: pick(/^prefill: (.*)$/m),
        focus: /FOCUS HELD/.test(log) ? 'held' : /FOCUS MOVED/.test(log) ? 'MOVED' : '?',
        /* The overlay's own report, if it ever could not mask itself. */
        unmasked: (log.match(/overlay: UNMASKED — (.*)/) ?? [])[1] ?? null,
      };
      appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
      console.log(
        `  ${row.ok ? 'ok' : 'FAILED'} ${row.seconds}s · ${row.verdict ?? '?'} · ` +
          `${row.genTps ?? '?'} tok/s · ${row.calls ?? '?'} calls · focus ${row.focus}` +
          (row.unmasked === null ? '' : ` · UNMASKED: ${row.unmasked}`),
      );
    }
  }
}
console.log(`\nsuite done in ${Math.round((Date.now() - started) / 60000)} min → ${LEDGER}`);
