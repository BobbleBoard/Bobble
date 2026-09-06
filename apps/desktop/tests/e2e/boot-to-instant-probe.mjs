/**
 * DOUBLE-CLICK TO INSTANT — the only number that describes a real user.
 *
 * the user: "get streaming complaint to absolute 0, ttft loading model instant when
 * the app opens." The blind tester, on the same thing: "You have a number for
 * when the SERVER is up. You do not have a number for when the first token of my
 * first message arrives on a cold start. That's the only number that describes
 * my experience and it isn't in this report."
 *
 * So this one measures it, and nothing else. It opens the REAL app against the
 * REAL model cache, sends NOTHING, and watches the milestones the app already
 * publishes:
 *
 *   server starting    llm phase leaves idle
 *   server ready       llm phase is ready + serverRunning
 *   warm start         the harness claims `harness-prefix-warm = warming`
 *   INSTANT            it publishes `ready` — from here a message pays only its
 *                      own few tokens, MEASURED elsewhere at ~360ms
 *
 * The gap between app-open and INSTANT is the whole of the first-message wait,
 * and it is the budget every prompt-size argument is really about.
 *
 *   MODEL=<id>   default qwen3.5-4b-mtp
 *   REAL=1       required — this is meaningless against a mock
 */
import { launchApp, REAL_CACHE } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';

const { page, check, finish } = await launchApp('boot-to-instant', {
  realCache: true,
  env: { PI_BIN: undefined },
  timeout: 120_000,
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const mark = (name) => console.log(`  ${at().padStart(7)}  ${name}`);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  mark('window ready');

  /*
   * TWO WAYS TO RUN THIS, and the difference matters.
   *
   * DRIVEN (default) forces a named model through pi:start → llm:start-server →
   * pi:restart → pi:set-model, which is what every other latency probe here
   * does. It is reproducible and it is NOT the app's own boot.
   *
   * `WATCH=1` touches nothing at all: it opens the app and waits, so what it
   * times is the real `preloadFastestModel()` path a person gets when they
   * double-click the icon. That is the number the blind tester said we did not
   * have — "double-click to the first word appearing on screen" — and she was
   * right that we did not.
   */
  const WATCH = process.env.WATCH === '1';
  if (WATCH) {
    mark('watching the app boot itself — nothing driven');
  } else {
    await page.evaluate(async (modelId) => {
      await window.piDesktop.invoke('pi:start', {});
      await window.piDesktop.invoke('llm:start-server', { modelId });
    }, MODEL);
    mark('server requested');
  }

  await page.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  const serverAt = Date.now() - t0;
  mark('server ready');

  if (!WATCH) {
    await page.evaluate(async (modelId) => {
      await window.piDesktop.invoke('pi:restart', {});
      await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
    }, MODEL);
    mark('pi pointed at it');
  }

  const warmState = () =>
    page.evaluate(
      () => window.__pi_store().getState().extensionStatus['harness-prefix-warm'] ?? null,
    );

  const deadline = Date.now() + 180_000;
  let warmStart = null;
  let instant = null;
  while (Date.now() < deadline && instant === null) {
    const s = await warmState();
    if (s === 'warming' && warmStart === null) {
      warmStart = Date.now() - t0;
      mark('warm-up started');
    }
    if (s === 'ready') {
      instant = Date.now() - t0;
      mark('INSTANT — a message now pays only its own tokens');
    }
    await page.waitForTimeout(200);
  }

  console.log('\n──────── boot to instant ────────');
  console.log(`  server ready      ${(serverAt / 1000).toFixed(2)}s`);
  console.log(
    `  warm started      ${warmStart === null ? 'never' : `${(warmStart / 1000).toFixed(2)}s`}`,
  );
  console.log(
    `  INSTANT           ${instant === null ? 'never' : `${(instant / 1000).toFixed(2)}s`}`,
  );
  if (instant !== null && warmStart !== null) {
    console.log(`  warm-up itself    ${((instant - warmStart) / 1000).toFixed(2)}s`);
    console.log(
      `  dead time first   ${(warmStart / 1000).toFixed(2)}s  ← everything before the warm could start`,
    );
  }
  check(instant !== null, 'the app reaches a state where a first message is instant');
  console.log(`\n  cache: ${REAL_CACHE}`);
} finally {
  await finish();
}
