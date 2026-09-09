/**
 * THE LEVERS THAT ACTUALLY MOVE A UNIFIED-MEMORY MAC.
 *
 * Measured first (power-bench.mjs): `taskpolicy -b`, which is all 'gentle' does
 * to the process today, costs about 1% of prefill — because prefill is a GPU
 * matmul and PRIO_DARWIN_BG governs CPU scheduling and I/O. So the current low
 * power mode buys the user almost nothing on the axis that hurts them, and the
 * policy's own comment already says it: "there is no clock knob (MEASURED), so
 * every lever is a memory lever."
 *
 * What DOES contend on this machine is the GPU and the memory bus. The knob
 * nobody has tried is the micro-batch: prefill is submitted as one Metal command
 * buffer per ubatch, so a smaller ubatch means shorter kernels and more gaps for
 * the compositor to draw the user's frame in. This measures what that costs in
 * throughput, which is the whole question — a lever that halves the user's stutter
 * for 10% of prefill is a good trade, one that costs 60% is not.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = process.env.HOME;
const SERVER = `${HOME}/.cache/pi-desktop/llamacpp/b10603/llama-b10603/llama-server`;
const MODEL = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const PORT = 52998;
const PROMPT = `${'The quick brown fox jumps over the lazy dog near the riverbank. '.repeat(220)}\nSummarise.`;

if (!existsSync(SERVER) || !existsSync(MODEL)) throw new Error('server or model missing');

async function measure(label, extraArgs) {
  const child = spawn(
    SERVER,
    ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT), '-c', '8192', '--parallel', '1', ...extraArgs],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  try {
    for (let i = 0; i < 120; i += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {}
      await sleep(1000);
    }
    const shot = async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/completion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: PROMPT, n_predict: 16, cache_prompt: false, temperature: 0 }),
      });
      return (await r.json()).timings ?? {};
    };
    await shot();
    const runs = [await shot(), await shot()];
    const pp = Math.max(...runs.map((t) => t.prompt_per_second ?? 0));
    const gp = Math.max(...runs.map((t) => t.predicted_per_second ?? 0));
    console.log(`${label.padEnd(28)} ${pp.toFixed(0).padStart(8)} ${gp.toFixed(1).padStart(9)}`);
    return pp;
  } finally {
    child.kill();
    await sleep(2500);
  }
}

console.log(`${'config'.padEnd(28)} ${'prefill/s'.padStart(8)} ${'gen tok/s'.padStart(9)}`);
const base = await measure('default (-fa on)', ['-fa', 'on']);
await measure('ubatch 128', ['-fa', 'on', '-ub', '128']);
await measure('ubatch 256', ['-fa', 'on', '-ub', '256']);
await measure('kv q8_0', ['-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0']);
await measure('kv q8_0 + ubatch 128', ['-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '-ub', '128']);
console.log(`\nbaseline prefill ${base.toFixed(0)} tok/s`);
