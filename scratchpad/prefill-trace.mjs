/** What llama ACTUALLY reports during a prefill, unfiltered — so the 99%
 *  plateau can be attributed to the server or to us. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const SERVER = `${HOME}/.cache/pi-desktop/llamacpp/b10603/llama-b10603/llama-server`;
const MODEL = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const PORT = 52997;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(SERVER) || !existsSync(MODEL)) throw new Error('missing server/model');
const child = spawn(SERVER, ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT), '-c', '16384', '--parallel', '1', '-fa', 'on'], { stdio: ['ignore', 'ignore', 'ignore'] });
process.on('exit', () => child.kill());
for (let i = 0; i < 120; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await sleep(1000);
}
const PROMPT = `${'The quick brown fox jumps over the lazy dog near the riverbank. '.repeat(700)}\nSummarise.`;
const res = await fetch(`http://127.0.0.1:${PORT}/completion`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: PROMPT, n_predict: 4, cache_prompt: false, stream: true, return_progress: true }),
});
const seen = [];
const t0 = Date.now();
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line.startsWith('data: ')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      const p = j.prompt_progress;
      if (p) seen.push({ ms: Date.now() - t0, ...p });
    } catch {}
  }
}
console.log('prompt_progress frames:', seen.length);
for (const f of seen) {
  const frac = f.processed !== undefined && f.total ? f.processed / f.total : null;
  console.log(`  ${String(f.ms).padStart(6)}ms  processed ${f.processed}/${f.total}  = ${frac === null ? '?' : (frac * 100).toFixed(1) + '%'}`);
}
child.kill();
