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

/*
 * Blender twice per model, and the two are DIFFERENT QUESTIONS rather than two
 * attempts at one.
 *
 * MEASURED across six cold runs: not one model got past Blender's welcome
 * splash — a 4B clicked four times inside it, a 27B left its cursor hovering
 * "Sculpting". That is a real finding, and it also means those runs say nothing
 * about driving Blender, because nothing ever drove Blender. Opening a file
 * skips the splash, so the pair separates "can you dismiss a modal you have
 * never seen" from "can you find a menu in a dense custom interface".
 */
const PLAN = [
  ...MODELS.map((m) => ({ app: 'chrome', demo: 'demo-apple.mjs', model: m })),
  ...MODELS.map((m) => ({ app: 'maps', demo: 'demo-maps.mjs', model: m })),
  ...MODELS.flatMap((m) => [
    { app: 'blender', demo: 'demo-blender.mjs', model: m, take: 'splash' },
    { app: 'blender', demo: 'demo-blender.mjs', model: m, take: 'no-splash', noSplash: true },
  ]),
];

/*
 * MATRIX_ONLY=maps,blender — re-run part of the plan against a fixed harness
 * without discarding the ledger that found the problem. The original twelve are
 * an honest record of the harness as it was; a re-run belongs beside them, not
 * on top of them, so point MATRIX_OUT somewhere new when using this.
 */
const ONLY = (process.env.MATRIX_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

const run = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: err === null, stdout, stderr }),
    );
  });

/**
 * A run that never had tools is retried, not recorded.
 *
 * demo-run marks it `INVALID` (see the note there): pi died at startup, the app
 * degraded to a session with no tools and no generation, and the model never
 * emitted a token. Scoring that as `fail` would put a lie in the ledger that is
 * indistinguishable, read later, from a model that tried. It is also transient —
 * it follows memory pressure — so one retry usually gets a real run.
 */
const MAX_ATTEMPTS = 3;

const started = Date.now();
for (const [i, job] of PLAN.entries()) {
  /* Numbering stays tied to the full plan, so run 7 is the same cell whether or
     not runs 1-6 were part of this pass. */
  if (ONLY.length > 0 && !ONLY.includes(job.app)) continue;
  const name = `matrix-${String(i + 1).padStart(2, '0')}-${job.app}-${job.model}${job.take === undefined ? '' : `-${job.take}`}`;
  const t0 = Date.now();
  console.log(`\n[${i + 1}/${PLAN.length}] ${name}`);
  let res;
  let log = '';
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    res = await run('node', [`apps/desktop/tests/e2e/${job.demo}`], {
      MAC_CU_MODEL: job.model,
      RUN_NAME: name,
      POWER: 'low',
      ...(job.noSplash === true ? { NO_SPLASH: '1' } : {}),
    });
    log = `${res.stdout}\n${res.stderr}`;
    if (!/^INVALID: /m.test(log)) break;
    console.log(
      `    INVALID (attempt ${attempts}/${MAX_ATTEMPTS}) — the session had no tools; retrying`,
    );
  }
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
    take: job.take ?? null,
    focus: /FOCUS HELD/.test(log) ? 'held' : /FOCUS MOVED/.test(log) ? 'moved' : null,
    modality: pick(/MODALITY: (\{.*\})/),
    frames: pick(/(\d+) frames, captured at/),
    fps: pick(/captured at ([\d.]+)\/s/),
    prefill: pick(/prefill: (.*)/),
    attempts,
    invalid: /^INVALID: /m.test(log) ? (log.match(/^INVALID: (.*)$/m) ?? [])[1] : null,
  };
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  console.log(
    `    ${row.ok ? 'ok' : 'FAILED'} in ${row.seconds}s · verdict ${row.verdict ?? '?'} · focus ${row.focus ?? '?'}` +
      (row.attempts > 1 ? ` · ${row.attempts} attempts` : '') +
      (row.invalid === null ? '' : ' · INVALID'),
  );
}
console.log(
  `\nall ${PLAN.length} runs done in ${Math.round((Date.now() - started) / 60000)} min → ${LEDGER}`,
);
