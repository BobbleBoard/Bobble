/**
 * MEASURE a local model's generation speed, with and without its speed head.
 *
 * the user, on Qwen3.8-27B: "see if we can get mtp, dspark/dflash whatever the stuff
 * is for speculative working, if we get reaonsbale speeds, ~30tps, then i'd like
 * you to try a run right after this one".
 *
 * That is a go/no-go number, so it has to be measured rather than reasoned
 * about. This launches llama-server exactly as the supervisor would (same
 * `--spec-type draft-mtp`, same chat template, same context cap), sends real
 * prompts through the OpenAI-compatible endpoint, and reports tokens/sec from
 * the server's own timings — twice, with speculative decoding on and off, so
 * the speed head's contribution is a difference rather than a claim.
 *
 *   MODEL      catalog id                     (default qwen3.8-27b-mtp)
 *   QUANT      quant label                    (default: the catalog's first)
 *   CTX        context to launch with         (default 65536)
 *   NO_SPEC=1  skip the MTP-off comparison run
 *
 * Needs the model on disk. Prints a table; exits 0 whatever the number is —
 * this measures, it does not judge.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const MODEL_ID = process.env.MODEL ?? 'qwen3.8-27b-mtp';
const CTX = Number(process.env.CTX ?? 65_536);
const modelsDir = path.join(homedir(), '.cache/bobble/models', MODEL_ID);
const PORT = Number(process.env.PORT ?? 18099);

/** The prompts. Short in, long out — generation speed is what is being asked. */
const PROMPTS = [
  'Write a Python function that converts a PNG to a JPEG using Pillow. Code only.',
  'Explain in one paragraph why unified memory changes how you size a local model.',
  'List ten file formats a document converter should support, one per line.',
];

function findServer() {
  const root = path.join(homedir(), '.cache/bobble/llamacpp');
  if (!existsSync(root)) return null;
  for (const build of readdirSync(root)) {
    for (const inner of readdirSync(path.join(root, build))) {
      const p = path.join(root, build, inner, 'llama-server');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findFiles() {
  if (!existsSync(modelsDir)) return null;
  const files = readdirSync(modelsDir).filter((f) => f.endsWith('.gguf'));
  const model = files.find((f) => !f.includes('mmproj'));
  const mmproj = files.find((f) => f.includes('mmproj'));
  return model === undefined
    ? null
    : {
        model: path.join(modelsDir, model),
        mmproj: mmproj === undefined ? undefined : path.join(modelsDir, mmproj),
      };
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** One measured generation. Uses the server's OWN timings, not a wall clock. */
async function measure(port, prompt) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 220,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 20,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`completion failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const t = body.timings ?? {};
  return {
    predicted: t.predicted_n ?? body.usage?.completion_tokens ?? 0,
    tps: t.predicted_per_second ?? 0,
    promptTps: t.prompt_per_second ?? 0,
    ttftMs: t.prompt_ms ?? 0,
    text: (body.choices?.[0]?.message?.content ?? '').slice(0, 80).replace(/\n/g, ' '),
  };
}

async function runOnce({ server, files, spec, template }) {
  const args = [
    '--model',
    files.model,
    '--port',
    String(PORT),
    '--ctx-size',
    String(CTX),
    '--parallel',
    '1',
    '--no-warmup',
    '--jinja',
  ];
  if (template !== undefined) args.push('--chat-template-file', template);
  if (spec) args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '2');
  /* NO_MMPROJ=1 isolates the projector, because MTP and `--mmproj` are
     documented as mutually exclusive per launch and a compute error on
     generation is exactly what that would look like. */
  if (files.mmproj !== undefined && process.env.NO_MMPROJ !== '1') {
    args.push('--mmproj', files.mmproj);
  }

  console.log(
    `\n$ llama-server ${args.map((a) => (a.includes('/') ? path.basename(a) : a)).join(' ')}`,
  );
  const child = spawn(server, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  child.stdout.on('data', () => {});

  const t0 = Date.now();
  try {
    const up = await waitForHealth(PORT, 600_000);
    if (!up) {
      console.log(stderr.split('\n').slice(-25).join('\n'));
      throw new Error('server never became healthy');
    }
    const loadS = (Date.now() - t0) / 1000;
    console.log(`  loaded in ${loadS.toFixed(1)}s`);

    const runs = [];
    for (const p of PROMPTS) {
      try {
        runs.push(await measure(PORT, p));
      } catch (err) {
        /* The server's own words. A bare "HTTP 500 Compute error." from the
           client says nothing about WHY; llama-server prints the reason. */
        console.log(`  request failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('  --- llama-server stderr (tail) ---');
        console.log(
          stderr
            .split('\n')
            .filter((l) => l.trim() !== '')
            .slice(-30)
            .map((l) => `  | ${l}`)
            .join('\n'),
        );
        throw err;
      }
    }
    const totalTokens = runs.reduce((s, r) => s + r.predicted, 0);
    const avgTps = runs.reduce((s, r) => s + r.tps, 0) / runs.length;
    for (const r of runs) {
      console.log(
        `  ${r.tps.toFixed(1).padStart(6)} tok/s  ${String(r.predicted).padStart(4)} tok  "${r.text}…"`,
      );
    }
    return { avgTps, totalTokens, loadS, ttftMs: runs[0]?.ttftMs ?? 0, stderr };
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2500));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
  }
}

const server = findServer();
const files = findFiles();
if (server === null) {
  console.error('model-speed-probe: no llama-server binary cached');
  process.exit(1);
}
if (files === null) {
  console.error(`model-speed-probe: no GGUF in ${modelsDir}`);
  process.exit(1);
}
console.log(`model:    ${path.basename(files.model)}`);
console.log(`mmproj:   ${files.mmproj === undefined ? '(none)' : path.basename(files.mmproj)}`);
console.log(`context:  ${CTX}`);

/*
 * The template THIS MODEL declares, not the first Qwen-ish file in the cache.
 * The loose `/qwen|froggeric/` match picked `Qwen--Qwen3.5-4B.jinja` for a 27B
 * — a different model's template, chosen by readdir order.
 * `TEMPLATE_REPO` mirrors the catalog entry's `baseRepo`; the app caches it as
 * `<owner>--<repo>.jinja` (see chat-template.ts `repoSlug`).
 */
const TEMPLATE_REPO = process.env.TEMPLATE_REPO ?? 'froggeric/Qwen-Fixed-Chat-Templates';
const templates = path.join(homedir(), '.cache/bobble/chat-templates');
let template;
if (process.env.NO_TEMPLATE !== '1') {
  const want = path.join(templates, `${TEMPLATE_REPO.replace(/[/\\]/g, '--')}.jinja`);
  if (existsSync(want)) template = want;
}
console.log(`template: ${template === undefined ? '(GGUF built-in)' : path.basename(template)}`);

// Does this build support the speed head at all?
const { stdout, stderr } = await exec(server, ['--help']).catch((e) => ({
  stdout: e.stdout ?? '',
  stderr: e.stderr ?? '',
}));
const mtpSupported = `${stdout}${stderr}`.includes('draft-mtp');
console.log(`draft-mtp supported by this build: ${mtpSupported}`);

const withSpec = await runOnce({ server, files, spec: mtpSupported, template });
let without = null;
if (mtpSupported && process.env.NO_SPEC !== '1') {
  without = await runOnce({ server, files, spec: false, template });
}

console.log(`\n${'='.repeat(64)}`);
console.log(
  `MTP on   : ${withSpec.avgTps.toFixed(1)} tok/s   (load ${withSpec.loadS.toFixed(1)}s, TTFT ${Math.round(withSpec.ttftMs)}ms)`,
);
if (without !== null) {
  const gain = ((withSpec.avgTps / without.avgTps - 1) * 100).toFixed(0);
  console.log(
    `MTP off  : ${without.avgTps.toFixed(1)} tok/s   (load ${without.loadS.toFixed(1)}s)`,
  );
  console.log(`speed head: ${gain}%`);
}
console.log(`\nuser's bar was ~30 tok/s — measured ${withSpec.avgTps.toFixed(1)}.`);
