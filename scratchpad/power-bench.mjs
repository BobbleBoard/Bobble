/**
 * WHAT LOW POWER ACTUALLY COSTS, AND WHETHER IT HAS TO.
 *
 * The user: "what can we do actually to improve that low power mode speed without
 * sacrificing other computer performance?"
 *
 * Today 'gentle' calls `taskpolicy -b`, which is PRIO_DARWIN_BG — on Apple
 * Silicon that pins the process to the EFFICIENCY cores. Prefill is one big
 * matmul, so that is the whole 4-7x slowdown measured on the demo runs. macOS
 * has finer tiers than that, and this measures them against each other on the
 * same server, same prompt, same machine.
 *
 * Prompt eval (prefill) is the number that matters: a computer-use turn ingests
 * a fresh screenshot every time, so prefill dominates the wall clock.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = process.env.HOME;
const SERVER = `${HOME}/.cache/pi-desktop/llamacpp/b10603/llama-b10603/llama-server`;
const MODEL = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const PORT = 52999;

if (!existsSync(SERVER)) throw new Error(`no server at ${SERVER}`);
if (!existsSync(MODEL)) throw new Error(`no model at ${MODEL}`);

/** ~3k tokens of prose, so prefill is long enough to time honestly. */
const PROMPT = `${'The quick brown fox jumps over the lazy dog near the riverbank. '.repeat(220)}\nSummarise.`;

async function timePrefill(port) {
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // cache_prompt off: we are timing the ingest, not the cache.
    body: JSON.stringify({ prompt: PROMPT, n_predict: 1, cache_prompt: false, temperature: 0 }),
  });
  const j = await res.json();
  return j.timings ?? {};
}

const child = spawn(
  SERVER,
  [
    '-m',
    MODEL,
    '--host',
    '127.0.0.1',
    '--port',
    String(PORT),
    '-c',
    '8192',
    '--parallel',
    '1',
    '-fa',
    'on',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

process.on('exit', () => child.kill());
for (let i = 0; i < 120; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (r.ok) break;
  } catch {}
  await sleep(1000);
}

const policies = [
  {
    name: 'full (no policy)',
    apply: async () => run('taskpolicy', ['-B', '-p', String(child.pid)]),
  },
  {
    name: 'gentle TODAY (-b)',
    apply: async () => run('taskpolicy', ['-b', '-p', String(child.pid)]),
  },
  {
    name: 'thruput tier 1',
    apply: async () => {
      await run('taskpolicy', ['-B', '-p', String(child.pid)]);
      await run('taskpolicy', ['-t', '1', '-p', String(child.pid)]);
    },
  },
  {
    name: 'thruput tier 2',
    apply: async () => {
      await run('taskpolicy', ['-B', '-p', String(child.pid)]);
      await run('taskpolicy', ['-t', '2', '-p', String(child.pid)]);
    },
  },
  {
    name: 'latency tier 1',
    apply: async () => {
      await run('taskpolicy', ['-B', '-p', String(child.pid)]);
      await run('taskpolicy', ['-l', '1', '-p', String(child.pid)]);
    },
  },
  {
    name: 'full again (check)',
    apply: async () => {
      await run('taskpolicy', ['-B', '-p', String(child.pid)]);
      await run('taskpolicy', ['-t', '0', '-p', String(child.pid)]);
      await run('taskpolicy', ['-l', '0', '-p', String(child.pid)]);
    },
  },
];

await timePrefill(PORT); // warm the graph, discard
console.log(`${'policy'.padEnd(20)} ${'prefill tok/s'.padStart(14)} ${'gen tok/s'.padStart(10)}`);
for (const p of policies) {
  await p.apply().catch(() => {});
  await sleep(1200);
  const a = await timePrefill(PORT);
  const b = await timePrefill(PORT);
  const pp = Math.max(a.prompt_per_second ?? 0, b.prompt_per_second ?? 0);
  const gp = Math.max(a.predicted_per_second ?? 0, b.predicted_per_second ?? 0);
  console.log(`${p.name.padEnd(20)} ${pp.toFixed(1).padStart(14)} ${gp.toFixed(1).padStart(10)}`);
}
child.kill();
