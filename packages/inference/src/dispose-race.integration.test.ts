/**
 * Does dispose() really wait for llama-server to die?
 *
 * The unit test proves the promise timing against a fake child. This proves the
 * thing that actually matters on the user's machine: after `await dispose()`
 * returns, is the OS process GONE — because that is what decides whether the
 * next (larger) model loads alongside the previous one's weights or after them.
 *
 * Real binary, real model, real PIDs. No fakes.
 *
 * OPT-IN: this spawns a real llama-server and loads a real model, so it is
 * skipped unless PI_INFERENCE_INTEGRATION=1. Unit tests must stay fast and
 * hermetic; this one is neither, and is meant to be run deliberately.
 *
 *   PI_INFERENCE_INTEGRATION=1 npx vitest run src/dispose-race.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlamaServerSupervisor } from './supervisor.js';

const SERVER = path.join(homedir(), '.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server');
const MODEL = path.join(homedir(), '.cache/pi-desktop/models/gemma-4-e2b-it/gemma-4-E2B-it-Q4_K_M.gguf');

const FIXTURES_PRESENT = existsSync(SERVER) && existsSync(MODEL);

/** Is this pid alive? signal 0 tests existence without touching the process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverCount(): string {
  try {
    return execFileSync('/bin/sh', ['-c', 'pgrep -f "llama-server .*--port" | wc -l'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '?';
  }
}

const RUN = process.env.PI_INFERENCE_INTEGRATION === '1' && FIXTURES_PRESENT;

describe.skipIf(!RUN)('dispose against a real llama-server', () => {
  it('the process is gone before dispose() resolves', async () => {
  const sup = new LlamaServerSupervisor({
  serverPath: SERVER,
  modelPath: MODEL,
  launchMode: 'fast-text',
  contextSize: 4096,
  healthTimeoutMs: 120_000,
  });

  const t0 = Date.now();
  const { pid, port } = await sup.start();
  console.log(`started  pid=${pid} port=${port} in ${Date.now() - t0}ms · llama-servers=${serverCount()}`);

  const t1 = Date.now();
  await sup.dispose();
  const took = Date.now() - t1;

  // THE ASSERTION: checked on the very next tick after dispose resolves. Before
  // the fix this could still be true — dispose returned on the SIGKILL timer
  // rather than on the process actually exiting, so the switch path spawned the
  // next model while this one still held its weights.
  const stillAlive = alive(pid);
  console.log(`disposed in ${took}ms · pid ${pid} alive immediately after? ${stillAlive}`);
  console.log(`llama-servers now = ${serverCount()}`);

  if (stillAlive) {
  console.error('FAIL: dispose() resolved while the server was still running');
  process.exit(1);
  }
  console.log('PASS: the process was gone before dispose() returned');

  }, 180_000);
});
