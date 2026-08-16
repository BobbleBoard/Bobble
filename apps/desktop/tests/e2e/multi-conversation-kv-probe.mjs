/**
 * Do MANY conversations keep their KV prefix on ONE slot — or does every switch
 * between the CEO, the manager and each engineer cost a full re-prefill?
 *
 * the user: "if currently you can only hold one prefix at once, the build needs to be
 * able to store KV for many instances… so if anything is ever sent as a follow up
 * that has been activated in the last hour already, it just gets to use cached kv
 * and doesn't have to reprefill."
 *
 * THE ANSWER, MEASURED (2026-08-16, b9934, Qwen3.5-4B-Q8_0, M5 Pro): llama-server
 * ALREADY DOES THIS, and it is already on. Two flags do it:
 *
 *   -cram, --cache-ram N     host-RAM prompt cache, default 8192 MiB, 0 disables
 *   --cache-idle-slots       "save idle slots to the prompt cache on new task",
 *                            default ENABLED, requires cache-ram
 *
 * That is save-on-yield / restore-on-return, keyed by prompt prefix, with a byte
 * budget and LRU eviction — in host RAM rather than on disk. So the thing to
 * protect is not a new cache; it is this one staying switched on. Measured with
 * exactly what this probe runs (6 unrelated agents, ~1.9k tokens each, 11,247
 * tokens live, round-robin twice, one slot):
 *
 *   --cache-ram 0     pass 2 re-prefilled 11247/11247 tokens — 9.9 s
 *   --cache-ram 8192  pass 2 re-prefilled    882/11247 tokens — 1.2 s   (92% reuse)
 *
 * AND IT SCALES TO THE REAL THING. Re-run at the size a corp engineer's thread
 * actually reaches — 6 agents × ~11.9k tokens, 71,361 tokens live, `-c 65536`,
 * which is what chooseContextCap picks for a 4B model on this 24GB machine:
 *   default 8192 MiB → 882/71439 re-prefilled, 1.6 s   (98.8% reuse)
 *   unlimited (-1)   → 882/71439 re-prefilled, 1.6 s   — byte for byte identical
 * Coming back to an agent costs a flat ~120-175 tokens no matter how long its
 * thread is, and raising the budget above the default buys nothing. That is the
 * evidence for leaving `--cache-ram` unset rather than "tuning" it.
 *
 * THE FAILURE MODE IS A CLIFF, WHICH IS WHY THIS IS WORTH A PROBE. Sweeping the
 * budget at ctx 32768 with those same 6 agents:
 *   1024 MiB → 0.0% reuse      1536 MiB → 92.2%      4096 MiB → 92.2%
 * One step below the working point the reuse is not degraded, it is GONE: the six
 * conversations rotate through an LRU that fits four, so every single one of them
 * is evicted before its turn comes round again. There is no warning band, and the
 * only visible symptom is that follow-ups got slow — the user's recurring report.
 * (Below the cliff a smaller fan-out is still fine: at 1024 MiB, 1/2/3 agents all
 * measured 92%. It is the ratio of live conversations to budget that decides.)
 *
 * WHAT THIS PROBE GUARDS: anything that turns the prompt cache off (`--cache-ram 0`,
 * `--no-cache-idle-slots`) or sizes it below the fan-out. Invisible to every
 * functional test; it shows up only as a number.
 *
 * ARM 3 IS A TOMBSTONE. `--slot-save-path` + `POST /slots/{id}?action=restore`
 * looks like the right tool for this and is NOT. Restoring a slot from disk
 * measured *worse* than leaving the server alone — the restore reports success
 * (`n_restored` = every token, ~8 ms) and the very next request re-prefills the
 * conversation anyway. Measured three ways in one session:
 *   follow-up, prompt cache doing its job          160 tok /  223 ms
 *   follow-up after an explicit /slots restore    1994 tok / 1860 ms
 *   and on a 19.4k-token thread: 17519 tok / 19.8 s after restore, vs 17 tok /
 *   126 ms for the same thread left alone — 150× worse.
 * With the prompt cache switched off entirely, restore does not help either
 * (1994 of 2020 tokens re-prefilled), so this is not the host cache "winning" a
 * fight — the restored KV simply is not reused by the next request on b9934.
 * The arm stays in the probe so the next person to reach for the disk endpoints
 * sees the number before writing the code.
 *
 *   MODEL   catalog id to serve   (default qwen3.5-4b-mtp)
 *   AGENTS  distinct conversations to round-robin (default 6)
 *   TURNS   turns per conversation (default 14)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const MODEL_ID = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const AGENTS = Number(process.env.AGENTS ?? 6);
const TURNS = Number(process.env.TURNS ?? 14);
const BASE_PORT = Number(process.env.PORT ?? 18190);

function findServer() {
  const root = path.join(homedir(), '.cache/pi-desktop/llamacpp');
  if (!existsSync(root)) return null;
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
  console.error(`multi-conversation-kv-probe: need llama-server and ${MODEL_ID} on disk`);
  process.exit(1);
}

/*
 * Six agents that share NOTHING — different role, different language, different
 * subject. This matters more than it looks: an earlier version of this
 * measurement used two conversations that overlapped almost completely, so a
 * "switch" only ever re-prefilled ~100 tokens and the cache appeared to do
 * nothing. A corp run's CEO / manager / engineers really are this unrelated, and
 * only unrelated prompts measure a real switch.
 */
const ROLES = [
  [
    'ceo',
    'You are the CEO. You commission work and never write code.',
    'Decide whether the LocalConvert milestone ships this week and why.',
  ],
  [
    'manager',
    'Vous êtes le MANAGER technique. Répondez en une ligne.',
    "Vérifiez le contrat de l'ingénieur sur le pipeline de conversion d'images.",
  ],
  [
    'eng-1',
    'You are ENGINEER 1, owner of the PNG/JPEG decoder path in C++.',
    'Explain the chroma subsampling loss when transcoding JPEG to PNG and back.',
  ],
  [
    'eng-2',
    'Du bist INGENIEUR 2 und betreust die PDF-Ausgabe.',
    'Beschreibe die Einbettung von Schriftarten und den Farbraum fuer den Druck.',
  ],
  [
    'eng-3',
    'You are ENGINEER 3, responsible for the DOCX importer and its XML schema.',
    'Describe how numbering definitions survive a round trip through the importer.',
  ],
  [
    'eng-4',
    'You are ENGINEER 4, working on the MP4 container muxer.',
    'Describe the timescale drift when remuxing variable frame rate footage.',
  ],
];

function conversation(idx, turns) {
  const [tag, sys, topic] = ROLES[idx % ROLES.length];
  const msgs = [{ role: 'system', content: `${sys} Session ${tag}. Answer in one short line.` }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: `${tag} note ${i}: ${`${topic} `.repeat(7)}` });
    msgs.push({ role: 'assistant', content: `${tag} noted ${i}.` });
  }
  return msgs;
}

async function ask(port, messages, label) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 4, stream: false, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const t = body.timings ?? {};
  return {
    promptN: t.prompt_n ?? 0,
    promptMs: Math.round(t.prompt_ms ?? 0),
    total: body.usage?.prompt_tokens ?? 0,
  };
}

async function slotAction(port, action, filename) {
  const res = await fetch(`http://127.0.0.1:${port}/slots/0?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

/** Boot a server with `extra` args, hand it to `fn`, and always reap it. */
async function withServer(port, extra, fn) {
  const args = [
    '--model',
    model,
    '--port',
    String(port),
    '--ctx-size',
    '32768',
    '--parallel',
    '1',
    '--no-warmup',
    ...extra,
  ];
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
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return await fn();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1200));
    child.kill('SIGKILL');
  }
}

/**
 * Round-robin every agent once (all cold), then round-robin again with a short
 * follow-up. Pass 2 is the measurement: with a working prompt cache each agent
 * re-prefills only its new turn; without one it re-prefills its whole history.
 */
async function roundRobin(port) {
  const convs = Array.from({ length: AGENTS }, (_, i) => conversation(i, TURNS));
  for (const c of convs) await ask(port, c, 'pass1');
  let promptN = 0;
  let promptMs = 0;
  let total = 0;
  const per = [];
  for (let i = 0; i < convs.length; i++) {
    const r = await ask(
      port,
      [...convs[i], { role: 'user', content: 'One-line status please.' }],
      `pass2-${i}`,
    );
    promptN += r.promptN;
    promptMs += r.promptMs;
    total += r.total;
    per.push(r.promptN);
  }
  return { promptN, promptMs, total, per };
}

console.log(
  `llama-server · ${path.basename(model)} · ${AGENTS} agents × ${TURNS} turns · one slot\n`,
);

let failures = 0;
try {
  // ARM 1 — the shipped default. No --cache-ram flag at all, so the server's own
  // 8192 MiB default and --cache-idle-slots apply. This is exactly what
  // assembleServerArgs() launches today.
  const shipped = await withServer(BASE_PORT, [], () => roundRobin(BASE_PORT));

  // ARM 2 — the counterfactual: the same run with the prompt cache switched off.
  // This is what the app would do if anyone set -cram 0, and it is the world the
  // "store KV for many instances" request assumed we were already living in.
  const disabled = await withServer(BASE_PORT + 1, ['--cache-ram', '0'], () =>
    roundRobin(BASE_PORT + 1),
  );

  console.log('  pass 2 (every agent sends a follow-up) — tokens the server had to RE-PREFILL');
  console.log(
    `    prompt cache ON  (default 8192 MiB) : ${String(shipped.promptN).padStart(6)} / ${shipped.total} tok   ${String(shipped.promptMs).padStart(6)} ms   per-agent [${shipped.per.join(', ')}]`,
  );
  console.log(
    `    prompt cache OFF (--cache-ram 0)    : ${String(disabled.promptN).padStart(6)} / ${disabled.total} tok   ${String(disabled.promptMs).padStart(6)} ms   per-agent [${disabled.per.join(', ')}]`,
  );
  const reuse = 100 * (1 - shipped.promptN / Math.max(1, shipped.total));
  console.log(
    `\n    reuse with the cache on: ${reuse.toFixed(1)}%   saved ${disabled.promptN - shipped.promptN} tok / ${disabled.promptMs - shipped.promptMs} ms across ${AGENTS} agents`,
  );

  // The invariant: on one slot, N unrelated conversations must each keep their
  // prefix. 80% is a deliberately loose floor — a healthy run measures ~99% — so
  // this fails on a switched-off cache, not on sampling noise.
  if (reuse < 80) {
    console.log(`\n  FAIL: multi-conversation KV reuse is ${reuse.toFixed(1)}% (expected > 80%).`);
    console.log('        The host prompt cache is off or too small for the fan-out:');
    console.log('        check --cache-ram / --cache-idle-slots in assembleServerArgs.');
    failures += 1;
  } else {
    console.log('\n  PASS: many conversations keep their KV on one slot.');
  }

  // ARM 3 — the tombstone. Disk slot save/restore, measured against just letting
  // the prompt cache work. See the header.
  const dir = mkdtempSync(path.join(tmpdir(), 'slot-probe-'));
  try {
    await withServer(BASE_PORT + 2, ['--slot-save-path', dir], async () => {
      const port = BASE_PORT + 2;
      const a = conversation(0, TURNS);
      const b = conversation(1, TURNS);
      await ask(port, a, 'arm3-a-cold');
      const saved = await slotAction(port, 'save', 'a.bin');
      await ask(port, b, 'arm3-b-cold'); // A yields the slot
      const plain = await ask(port, [...a, { role: 'user', content: 'Status?' }], 'arm3-plain');
      await ask(port, b, 'arm3-b-again'); // A yields the slot again
      const restored = await slotAction(port, 'restore', 'a.bin');
      const afterRestore = await ask(
        port,
        [...a, { role: 'user', content: 'Status now?' }],
        'arm3-restored',
      );
      console.log('\n  arm 3 — disk slot save/restore, for the record');
      console.log(
        `    saved ${saved.n_saved ?? '?'} tok → ${saved.n_written ?? '?'} bytes in ${saved.timings?.save_ms ?? '?'} ms`,
      );
      console.log(
        `    restore reported n_restored=${restored.n_restored ?? '?'} in ${restored.timings?.restore_ms ?? '?'} ms`,
      );
      console.log(
        `    follow-up, prompt cache left alone : ${String(plain.promptN).padStart(5)} tok / ${plain.promptMs} ms`,
      );
      console.log(
        `    follow-up after /slots restore     : ${String(afterRestore.promptN).padStart(5)} tok / ${afterRestore.promptMs} ms`,
      );
      console.log(
        afterRestore.promptN > plain.promptN
          ? '    → restore is WORSE. Do not build a disk slot cache on this build.'
          : '    → restore beat the prompt cache here; the tombstone is worth re-examining.',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (err) {
  console.error(`multi-conversation-kv-probe: ${err.message}`);
  failures += 1;
}

process.exitCode = failures > 0 ? 1 : 0;
