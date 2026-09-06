/**
 * K2 HORIZON, IN THE APP, ON AN ENGINE THE APP BUILT ITSELF.
 *
 * The whole variant pipeline exists to make one thing true: a model whose
 * architecture the shipped llama.cpp has never heard of still just works. Every
 * part of that is checkable in isolation and none of the isolated checks are the
 * claim — so this drives the real app, picks the model, and reads the answer.
 *
 * What it establishes, in order:
 *
 *  1. The PINNED engine genuinely cannot load it. Without this the rest could
 *     pass on an engine that never needed replacing. MEASURED directly against
 *     the shipped binary: `unknown model architecture: 'k2-horizon'`.
 *  2. The app resolves K2 to the variant, builds it if it has to, and starts a
 *     server on it — through `llm:start-server`, the same call the model manager
 *     makes, not a test-only path.
 *  3. A real turn comes back, with the model's own chat template applied (K2 is
 *     a reasoning model, so a working template shows up as reasoning content
 *     rather than as literal `<think>` in the reply).
 *
 * The build is cached in `~/.cache/pi-desktop/llamacpp/k2-horizon`; the first run
 * on a machine compiles llama.cpp and takes minutes, later runs seconds. Weights
 * come from the real cache (`realCache`), because they are 2.16GB and shared.
 *
 *   MODEL=<id>   override the model (default k2-horizon-0.9b)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchApp, REAL_CACHE } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'k2-horizon-0.9b';

const { page, shot, check, finish } = await launchApp('k2-horizon-real-probe', {
  // REAL pi, not the mock: the point is the model's own words. Without this the
  // reply comes from a fixture and the probe passes on an engine it never used —
  // MEASURED as "Done — hello.txt now greets the world." in 24ms, which is
  // mock-pi's canned answer to a question about France.
  env: { PI_BIN: undefined },
  realCache: true,
  timeout: 60_000,
});

// --- 1. the premise: the shipped engine refuses this model ------------------
const listed = await page.evaluate(async (id) => {
  const res = await window.piDesktop.invoke('llm:list-catalog', undefined);
  const entry = (res?.models ?? []).find((m) => m.id === id);
  return { found: entry !== undefined, name: entry?.displayName ?? null };
}, MODEL);
check(listed.found, `${MODEL} is not in the app's catalog`);
console.log(`[k2] catalog lists it as ${JSON.stringify(listed.name)}`);

/*
 * Asserted against the binary rather than taken on trust. `strings` is enough:
 * llama.cpp holds architecture ids as plain C strings, which is the same
 * evidence the pipeline's own retirement check uses.
 */
const pinnedServer = path.join(REAL_CACHE, 'llamacpp');
let pinnedHasK2 = true;
try {
  const out = execFileSync(
    '/bin/sh',
    [
      '-c',
      `find ${JSON.stringify(pinnedServer)} -name 'libllama.*dylib' -not -path '*k2-horizon*' | head -1 | xargs strings -a 2>/dev/null | grep -cx k2-horizon || true`,
    ],
    { encoding: 'utf8' },
  );
  pinnedHasK2 = Number(out.trim()) > 0;
} catch {
  // Can't read it — say so rather than claiming either answer.
  pinnedHasK2 = false;
}
check(
  !pinnedHasK2,
  'the PINNED engine already provides k2-horizon — this probe is no longer testing anything, and the variant should be retired',
);

// --- 2. the app starts a server for it -------------------------------------
console.log(`[k2] starting ${MODEL} — the first run on a machine compiles the engine`);
const started = Date.now();
await page.evaluate(async (id) => {
  await window.piDesktop.invoke('pi:start', {});
  await window.piDesktop.invoke('llm:start-server', { modelId: id });
}, MODEL);

// Long: an engine build is minutes, and that is the case under test.
await page.waitForFunction(
  () => window.__llm_store?.().getState().status.serverRunning === true,
  undefined,
  { timeout: 1_800_000 },
);
console.log(`[k2] server up in ${((Date.now() - started) / 1000).toFixed(1)}s`);
const status = await page.evaluate(() => {
  const s = window.__llm_store().getState().status;
  return { model: s.model?.id ?? null, ctx: s.model?.contextWindow ?? null, phase: s.phase };
});
check(status.model === MODEL, `the running model is ${status.model}, not ${MODEL}`);
console.log(`[k2] ${status.model} · context ${status.ctx} · phase ${status.phase}`);
await shot('01-k2-loaded');

// --- 3. a real turn ---------------------------------------------------------
await page.evaluate(async (id) => {
  await window.piDesktop.invoke('pi:restart', {});
  await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId: id });
}, MODEL);
await page.waitForTimeout(6000);

await page.click('[data-testid="composer-input"]');
await page.keyboard.type('In one short sentence: what is the capital of France?');
const t0 = Date.now();
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => {
    const m = window.__pi_store().getState().messages;
    const last = m[m.length - 1];
    if (last?.kind !== 'assistant') return false;
    return (last.blocks ?? []).some((b) => (b.text ?? '').length > 0);
  },
  null,
  { timeout: 300_000 },
);
const ttft = Date.now() - t0;
await page.waitForFunction(() => window.__pi_store().getState().agent?.isStreaming !== true, null, {
  timeout: 300_000,
});

const reply = await page.evaluate(() => {
  const m = window.__pi_store().getState().messages;
  const last = m[m.length - 1];
  const blocks = last?.blocks ?? [];
  return {
    text: blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    thinking: blocks
      .filter((b) => b.type === 'thinking')
      .map((b) => b.thinking ?? '')
      .join(''),
  };
});
console.log(`[k2] ttft ${ttft}ms · reply: ${JSON.stringify(reply.text.slice(0, 160))}`);
if (reply.thinking.length > 0) {
  console.log(`[k2] reasoning: ${JSON.stringify(reply.thinking.slice(0, 120))}…`);
}
check(reply.text.trim().length > 0, 'K2 produced no visible reply');
check(
  /paris/i.test(reply.text),
  `the reply does not answer the question: ${JSON.stringify(reply.text.slice(0, 200))}`,
);
/*
 * A chat template that did not apply shows up as the raw control tokens landing
 * in the visible reply. It is the difference between "it loaded" and "it works".
 */
check(
  !/<\|?(im_start|think|assistant)\|?>/.test(reply.text),
  `raw template tokens leaked into the reply: ${JSON.stringify(reply.text.slice(0, 200))}`,
);
await shot('02-k2-answered');

await finish();
