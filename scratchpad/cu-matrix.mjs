/**
 * THE TWELVE RUNS, one after another, unattended.
 *
 * the user's matrix: Chrome x3, Maps x3, Blender x6, across the three models — the
 * spread that says what computer use costs on an app that publishes a real
 * Accessibility tree (Maps), one that publishes a page behind a browser
 * (Chrome), and one that publishes nothing at all (Blender, three elements).
 *
 * Serial by necessity: they share one Mac, one Bobble and one llama-server, and
 * two at once would measure the contention rather than the models. Each run
 * writes its own video and its own verdict; this only sequences them and keeps
 * a ledger, so a failure in run 4 does not cost runs 5 through 12.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MODELS = ['qwen3.5-4b-mtp', 'qwen3.5-9b-mtp', 'qwen3.8-27b-mtp'];
const OUT = process.env.MATRIX_OUT ?? '/Users/user/Desktop/OSS-harness/scratchpad/demos/matrix';
mkdirSync(OUT, { recursive: true });
const LEDGER = path.join(OUT, 'ledger.jsonl');

/* Blender twice per model because it is the case the matrix exists for and the
   one with the widest spread between attempts; the other two once each. */
const PLAN = [
  ...MODELS.map((m) => ({ app: 'chrome', demo: 'demo-apple.mjs', model: m })),
  ...MODELS.map((m) => ({ app: 'maps', demo: 'demo-maps.mjs', model: m })),
  ...MODELS.flatMap((m) => [
    { app: 'blender', demo: 'demo-blender.mjs', model: m, take: 1 },
    { app: 'blender', demo: 'demo-blender.mjs', model: m, take: 2 },
  ]),
];

const run = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: err === null, stdout, stderr }));
  });

const started = Date.now();
for (const [i, job] of PLAN.entries()) {
  const name = `matrix-${String(i + 1).padStart(2, '0')}-${job.app}-${job.model}${job.take ? `-t${job.take}` : ''}`;
  const t0 = Date.now();
  console.log(`\n[${i + 1}/${PLAN.length}] ${name}`);
  const res = await run('node', [`apps/desktop/tests/e2e/${job.demo}`], {
    MAC_CU_MODEL: job.model,
    RUN_NAME: name,
    POWER: 'low',
  });
  const log = `${res.stdout}\n${res.stderr}`;
  writeFileSync(path.join(OUT, `${name}.log`), log);
  const pick = (re) => (log.match(re) ?? [])[1] ?? null;
  const row = {
    n: i + 1,
    name,
    app: job.app,
    model: job.model,
    ok: res.ok,
    seconds: Math.round((Date.now() - t0) / 1000),
    verdict: pick(/"verdict":"(\w+)"/),
    focus: /FOCUS HELD/.test(log) ? 'held' : /FOCUS MOVED/.test(log) ? 'moved' : null,
    modality: pick(/MODALITY: (\{.*\})/),
    frames: pick(/(\d+) frames, captured at/),
    fps: pick(/captured at ([\d.]+)\/s/),
    prefill: pick(/prefill: (.*)/),
  };
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  console.log(
    `    ${row.ok ? 'ok' : 'FAILED'} in ${row.seconds}s · verdict ${row.verdict ?? '?'} · focus ${row.focus ?? '?'}`,
  );
}
console.log(`\nall ${PLAN.length} runs done in ${Math.round((Date.now() - started) / 60000)} min → ${LEDGER}`);
