/**
 * Does a background utility call EVICT the conversation's KV prefix?
 *
 * the user, for the fifth time: "the prefix caching for instant follow up prefills…
 * I paused, sent a message, it took 90 seconds for this follow up to prefill
 * (likely whole context since it was a 12 word message)".
 *
 * Every previous fix has been to whichever background caller was doing it that
 * month (the post-turn reviewer, then the naming call). This probe measures the
 * MECHANISM instead, so the next caller to do it is caught by a number rather
 * than by the user noticing the app is slow.
 *
 * WHAT IT PROVES. llama-server reports `timings.prompt_n` — how many prompt
 * tokens it actually had to PROCESS. On a cache hit that is a handful (just the
 * new turn); on an eviction it is the whole conversation. So:
 *
 *   1. cold      send a long conversation                → prompt_n ≈ all of it
 *   2. warm      same conversation + a short follow-up   → prompt_n ≈ tiny
 *   3. intruder  a DIFFERENT short prompt (the classifier/utility shape)
 *   4. after     same conversation + another follow-up   → prompt_n = ?
 *
 * If step 4 looks like step 1, the intruder evicted the conversation and every
 * follow-up in the app pays a full prefill. That is the bug, in one number.
 *
 *   MODEL     catalog id to serve      (default qwen3.5-4b-mtp)
 *   PARALLEL  llama-server --parallel  (default 1 — what the app ships)
 *   TURNS     conversation size        (default 12)
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const MODEL_ID = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PARALLEL = process.env.PARALLEL ?? '1';
const TURNS = Number(process.env.TURNS ?? 12);
const PORT = Number(process.env.PORT ?? 18122);

function findServer() {
  const root = path.join(homedir(), '.cache/pi-desktop/llamacpp');
  for (const build of readdirSync(root)) {
    for (const inner of readdirSync(path.join(root, build))) {
      const p = path.join(root, build, inner, 'llama-server');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findModel() {
  const dir = path.join(homedir(), '.cache/pi-desktop/models', MODEL_ID);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.endsWith('.gguf') && !n.includes('mmproj'));
  return f === undefined ? null : path.join(dir, f);
}

const server = findServer();
const model = findModel();
if (server === null || model === null) {
  console.error(`kv-eviction-probe: need llama-server and ${MODEL_ID} on disk`);
  process.exit(1);
}

/** A conversation long enough that a full re-prefill is unmistakable. */
function conversation(turns) {
  const msgs = [
    { role: 'system', content: 'You are a terse assistant. Answer in one short line.' },
  ];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: 'user',
      content:
        `Item ${i}: describe the file format ${['png', 'jpeg', 'webp', 'pdf', 'docx', 'mp4'][i % 6]} ` +
        'and one thing a converter must preserve when writing it. '.repeat(6),
    });
    msgs.push({ role: 'assistant', content: `Noted item ${i}.` });
  }
  return msgs;
}

async function ask(messages, label) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 8, stream: false, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const t = body.timings ?? {};
  return {
    label,
    promptN: t.prompt_n ?? 0,
    promptMs: Math.round(t.prompt_ms ?? 0),
    cachedN: t.prompt_n_cached ?? t.cache_n ?? undefined,
  };
}

const args = [
  '--model',
  model,
  '--port',
  String(PORT),
  '--ctx-size',
  '32768',
  '--parallel',
  PARALLEL,
  '--no-warmup',
];
console.log(`llama-server --parallel ${PARALLEL} · ${path.basename(model)}\n`);
const child = spawn(server, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += String(d);
});

try {
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never came up:\n${stderr.slice(-800)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const base = conversation(TURNS);
  const rows = [];
  rows.push(await ask(base, '1 cold      (first send)'));
  rows.push(
    await ask(
      [...base, { role: 'user', content: 'Which of those is lossless?' }],
      '2 warm      (follow-up)',
    ),
  );
  // The intruder: exactly the shape of a classifier / naming / reviewer call —
  // a short, unrelated prompt sent to the same server between two user turns.
  rows.push(
    await ask(
      [
        { role: 'system', content: 'Classify the request.' },
        { role: 'user', content: 'Classify: "build me a converter". One word.' },
      ],
      '3 intruder  (utility call)',
    ),
  );
  rows.push(
    await ask(
      [...base, { role: 'user', content: 'And which is best for photos?' }],
      '4 after      (follow-up)',
    ),
  );

  /*
   * THE SCENARIO the user ACTUALLY DESCRIBED: "I paused, sent a message, it took 90
   * seconds". A pause is an ABORT of the in-flight request (see the pause work:
   * abort + resumable + keep-queue). An aborted generation leaves the slot
   * part-way through writing its KV, which is a different situation from an
   * unrelated request arriving — and the step above shows an unrelated request
   * is harmless on this build.
   */
  const ctrl = new AbortController();
  const aborted = fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [...base, { role: 'user', content: 'Write a long essay about image formats.' }],
      max_tokens: 400,
      stream: false,
      temperature: 0,
    }),
    signal: ctrl.signal,
  }).catch(() => undefined);
  // Let it get properly under way, then pull the plug the way the pause button does.
  await new Promise((r) => setTimeout(r, 2500));
  ctrl.abort();
  await aborted;
  await new Promise((r) => setTimeout(r, 1000));

  rows.push(
    await ask(
      [...base, { role: 'user', content: 'Which one supports transparency?' }],
      '5 post-abort (follow-up)',
    ),
  );

  console.log('  step                        prompt_n   prompt_ms');
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(26)} ${String(r.promptN).padStart(8)} ${String(r.promptMs).padStart(11)}`,
    );
  }

  const cold = rows[0].promptN;
  const warm = rows[1].promptN;
  const afterIntruder = rows[3].promptN;
  const afterAbort = rows[4].promptN;
  console.log('');
  console.log(`  cache WORKS when warm ≪ cold:              ${warm} vs ${cold}`);
  console.log(`  utility call evicts?   after ≈ cold:       ${afterIntruder} vs ${cold}`);
  console.log(`  ABORT evicts?          post-abort ≈ cold:  ${afterAbort} vs ${cold}`);
  const byIntruder = afterIntruder > cold * 0.5;
  const byAbort = afterAbort > cold * 0.5;
  console.log('');
  console.log(`  utility call: ${byIntruder ? 'EVICTS' : 'harmless'}`);
  console.log(
    `  pause/abort : ${byAbort ? 'EVICTS — this is the 90-second follow-up' : 'harmless'}`,
  );
  process.exitCode = byIntruder || byAbort ? 1 : 0;
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGKILL');
}
