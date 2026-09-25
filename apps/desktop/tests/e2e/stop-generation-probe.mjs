/**
 * STOP DURING A GENERATION ENDS THE TURN — and the job with it.
 *
 * Review of the 2026-09-23 wave: the gen tools ignored pi's abort, and pi only
 * acknowledges an abort once its turn has ended, so Stop during a generation
 * waited for the job. A job that cannot run is the clearest case: in a fresh
 * home the image module is not installed, so the picture WAITS at the module
 * gate for the Download button — four minutes before this fix, with the card
 * saying a generation was waiting all that time.
 *
 * Real app, real pi, real harness and gen-tools; only the model is scripted
 * (it calls generate_image once). Nothing is installed and no model runs: the
 * job never gets past the gate. The person presses Stop like a person.
 *
 *   1. the job is held at the gate: the image module is `wanted`;
 *   2. Stop ends the turn within seconds (not the gate's four minutes);
 *   3. the job goes with it: the module is no longer wanted (the card lets it
 *      go), and the tool result says it was stopped.
 *
 * Both ways a tool is offered, because they failed differently: with schemas
 * the tool itself held the turn; in bash-CLI mode (the default) Stop killed the
 * bash command at once and the tool behind the shim never heard, so the job
 * stayed at the gate with its card up after the turn had ended.
 *
 *   SHOT_DIR=/tmp/stop-generation node tests/e2e/stop-generation-probe.mjs
 *   TOOL_INTERFACE=schemas node tests/e2e/stop-generation-probe.mjs
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = 'mock-4b';
const TOOL_INTERFACE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';
/* What a model does in each: in CLI mode the picture is a command line; with
   schemas it turns the generation group on, then calls the tool next reply. */
const rules =
  TOOL_INTERFACE === 'bash-cli'
    ? [
        {
          name: 'draw',
          match: { lastUser: 'GEN-STOP', afterTool: false },
          reply: {
            content: 'Making the picture now.',
            toolCalls: [
              {
                name: 'bash',
                arguments: { command: 'media generate image "a red fox in the snow"' },
              },
            ],
          },
        },
      ]
    : [
        {
          name: 'enable',
          match: { lastUser: 'GEN-STOP', afterTool: false },
          reply: {
            content: 'Turning on generation.',
            toolCalls: [{ name: 'capability', arguments: { name: 'generation' } }],
          },
        },
        {
          name: 'draw',
          match: { afterTool: 'generation' },
          reply: {
            content: 'Making the picture now.',
            toolCalls: [{ name: 'generate_image', arguments: { prompt: 'a red fox in the snow' } }],
          },
          times: 1,
        },
      ];
const mock = await startMockOpenAI({ model: MODEL, rules, defaultReply: { content: 'OK.' } });

const home = probeHome('stop-generation');
writeModelsJson(home, { provider: 'mock', baseUrl: mock.baseUrl, model: MODEL, name: 'Mock 4B' });
// The throwaway home's own settings — never the user's.
const settingsFile = path.join(home, '.pi', 'desktop', 'settings.json');
writeFileSync(
  settingsFile,
  `${JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), toolInterface: TOOL_INTERFACE }, null, 2)}\n`,
);

const { app, page, check, shot, finish, shotDir } = await launchApp('stop-generation', {
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
  timeout: 60_000,
});
const mainLog = path.join(shotDir, 'main.log');
writeFileSync(mainLog, '');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const until = async (fn, timeout, arg) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 });
    return true;
  } catch {
    return false;
  }
};
const imageWanted = () =>
  page.evaluate(
    () =>
      window
        .__gen_modules_store()
        .getState()
        .modules.find((m) => m.id === 'image')?.wanted === true,
  );

const summary = { toolInterface: TOOL_INTERFACE };
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  check(started.pid > 0, `pi did not start: ${JSON.stringify(started)}`);
  const set = await page.evaluate(
    (m) => window.piDesktop.invoke('pi:set-model', { provider: 'mock', modelId: m }),
    MODEL,
  );
  check(set.success === true, `pi:set-model failed: ${JSON.stringify(set)}`);
  await page.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 20_000,
  });

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('GEN-STOP: draw me a red fox in the snow');
  await page.keyboard.press('Enter');

  // 1. Held at the module gate.
  const held = await until(
    () =>
      window
        .__gen_modules_store()
        .getState()
        .modules.find((m) => m.id === 'image')?.wanted === true,
    60_000,
  );
  check(held, 'the picture was not held at the image module gate');
  summary.heldAtGate = held;
  summary.turnRunningWhileHeld = await page.evaluate(() => {
    const s = window.__pi_store().getState();
    return s.agent.isStreaming || s.promptInFlight;
  });
  check(summary.turnRunningWhileHeld, 'the turn should still be running while the job waits');
  await page.evaluate(() => document.activeElement?.blur());
  await shot('01-held-at-gate');

  // 2. Stop, like a person.
  const t0 = Date.now();
  await page.click('[data-testid="composer-stop"]');
  const ended = await until(() => {
    const s = window.__pi_store().getState();
    return !s.agent.isStreaming && !s.promptInFlight;
  }, 15_000);
  summary.turnEndedMs = ended ? Date.now() - t0 : 'not within 15 s';
  check(ended, 'Stop did not end the turn within 15 s');

  // 3. The job went with it.
  const released = await until(
    () =>
      window
        .__gen_modules_store()
        .getState()
        .modules.find((m) => m.id === 'image')?.wanted === false,
    5_000,
  );
  summary.moduleReleasedMs = released ? Date.now() - t0 : 'still wanted after 5 s';
  check(released, 'the image module is still wanted after Stop — the job is still waiting');
  summary.stillWantedAtEnd = await imageWanted();

  // The call that ran the picture: `generate_image` itself with schemas, the
  // `bash` line that ran `media generate image` in CLI mode.
  const toolResult = await page.evaluate(() => {
    const m = window
      .__pi_store()
      .getState()
      .messages.filter((x) => x.kind === 'toolResult')
      .at(-1);
    return m === undefined ? null : { tool: m.toolName, text: m.text };
  });
  summary.toolResult = toolResult;
  check(
    toolResult !== null && /stopped|aborted/i.test(toolResult.text),
    `the tool result does not say it was stopped: ${JSON.stringify(toolResult)}`,
  );
  await page.waitForTimeout(800);
  await shot('02-after-stop');

  summary.mockRequests = mock.log.map((e) => e.rule);
} finally {
  console.log(JSON.stringify(summary, null, 2));
  await finish();
  await mock.close();
}
