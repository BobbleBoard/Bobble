/**
 * WHAT THE DEFAULT TOOL SET COSTS, in tokens and in seconds.
 *
 * MEASURED with this probe, qwen3.5-4b-mtp, same question, cold each time:
 *
 *   21 tools (today's default)   10,309 tokens of prompt
 *   the same 21 as a bash CLI    10,309 — IDENTICAL, because the CLI's help
 *                                text lists every command, so the same
 *                                information is paid for in prose instead of
 *                                schemas. The format is not where the cost is.
 *   8 tools (read/write/edit/    7,318 — 2,991 fewer, 29% of the prompt, and
 *   bash/ask_user/present/              at the measured cold prefill rate about
 *   generate_image/web_*)               3.5 seconds off every first message.
 *
 * The conclusion the numbers force: cutting the NUMBER of tools is worth
 * seconds; changing how they are described is worth nothing.
 *
 * The app already ships both answers to "how should a model be given tools":
 *
 *   schemas    every tool advertised up front with its JSON schema — 21 of them
 *              on an ordinary turn (15 always-active + 4 from the hardcoded
 *              `coding` preset + the capability/use pair).
 *   bash-cli   ONE tool, `bash`, with the rest exposed as command groups the
 *              model discovers at runtime (harness index.ts, TOOL_CLI_*).
 *
 * Nobody had measured the difference, so the choice between them was taste. This
 * runs the SAME question through both, on the same model, from a cold server
 * each time, and reports the two numbers that matter: how big the prompt is
 * before you have said anything, and how long you wait for the first token.
 *
 * The counters come from llama-server's own /slots (n_prompt_tokens against
 * n_prompt_tokens_processed), the same evidence enhance-prefill-probe uses.
 *
 *   MODEL=<id>   default qwen3.5-4b-mtp — small on purpose, since "is this
 *                affordable on a small model" is the question being asked
 *   ASK=<text>   the question
 */
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ASK = process.env.ASK ?? 'In one sentence, what is the capital of France?';

const discoverPort = () => {
  try {
    const out = execSync('ps -Ao pid,command | grep llama-server | grep -v grep', {
      encoding: 'utf8',
    });
    const found = out
      .split('\n')
      .map((l) => /^\s*(\d+)\s+.*--port (\d+)/.exec(l))
      .filter((m) => m !== null)
      .map((m) => ({ pid: Number(m[1]), port: Number(m[2]) }))
      .sort((a, b) => b.pid - a.pid);
    return found[0]?.port ?? null;
  } catch {
    return null;
  }
};

/** One cold run in one tool mode. A fresh app each time — the prefix cache is
 *  the thing being measured, so it must not carry over. */
async function measure(mode) {
  const home = probeHome(`tool-mode-${mode}`);
  mkdirSync(join(home, '.pi', 'desktop'), { recursive: true });
  const { page, finish, check } = await launchApp(`tool-mode-${mode}`, {
    env: {
      HOME: home,
      PI_BIN: undefined,
      ...(process.env.PI_EXPERIMENT_LEAN
        ? { PI_EXPERIMENT_LEAN: process.env.PI_EXPERIMENT_LEAN }
        : {}),
    },
    realCache: true,
    timeout: 120_000,
  });
  await page.evaluate(
    async ({ modelId, toolInterface }) => {
      await window
        .__settings_store?.()
        .getState?.()
        .update?.({
          toolInterface,
          modelSelection: { mode: 'model', modelId },
        });
      await window.piDesktop.invoke('pi:start', {});
      await window.piDesktop.invoke('llm:start-server', { modelId });
    },
    { modelId: MODEL, toolInterface: mode },
  );
  await page.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 600_000 },
  );
  await page.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  // Let the warm-up settle so what we time is the TURN, not the warm-up racing it.
  await page.waitForTimeout(30_000);

  const port = discoverPort();
  const t0 = Date.now();
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(ASK);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const m = window.__pi_store().getState().messages;
      const last = m[m.length - 1];
      return (
        last?.kind === 'assistant' &&
        (last.blocks ?? []).some((b) => (b.text ?? b.thinking ?? '').length > 0)
      );
    },
    null,
    { timeout: 300_000 },
  );
  const ttft = Date.now() - t0;
  let slot = null;
  if (port !== null) {
    slot = await fetch(`http://127.0.0.1:${port}/slots`)
      .then((r) => r.json())
      .then((j) => ({
        total: j[0]?.n_prompt_tokens ?? 0,
        done: j[0]?.n_prompt_tokens_processed ?? 0,
      }))
      .catch(() => null);
  }
  const reply = await page.evaluate(() => {
    const m = window.__pi_store().getState().messages;
    const last = m[m.length - 1];
    return (last?.blocks ?? [])
      .map((b) => b.text ?? b.thinking ?? '')
      .join(' ')
      .trim()
      .slice(0, 120);
  });
  check(true, '');
  await finish();
  return { mode, ttft, prompt: slot?.total ?? null, reply };
}

const results = [];
for (const mode of (process.env.MODES ?? 'schemas,bash-cli').split(',')) {
  console.log(`\n=== ${mode} ===`);
  results.push(await measure(mode));
  // Leave nothing running for the next mode to inherit.
  try {
    execSync(
      "ps -Ao pid,ppid,command | grep llama-server | grep -v grep | awk '$2==1 {print $1}' | xargs -r kill",
    );
  } catch {
    /* nothing to reap */
  }
}

console.log(`\n${'mode'.padEnd(10)} ${'prompt'.padStart(8)} ${'ttft'.padStart(8)}   reply`);
for (const r of results) {
  console.log(
    `${r.mode.padEnd(10)} ${String(r.prompt ?? '?').padStart(8)} ${`${r.ttft}ms`.padStart(8)}   ${JSON.stringify(r.reply)}`,
  );
}
const [a, b] = results;
if (a?.prompt && b?.prompt) {
  console.log(
    `\nbash-cli is ${a.prompt - b.prompt} tokens smaller (${Math.round((1 - b.prompt / a.prompt) * 100)}%) and ${a.ttft - b.ttft}ms faster to first token on ${MODEL}`,
  );
}
