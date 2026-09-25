/**
 * A REAL PI TURN AGAINST A SCRIPTED MODEL — W0-B's acceptance for _mock-openai.
 *
 * The hidden app runs the REAL pi (not mock-pi), with the real harness,
 * provider-llamacpp and renderer. Only the model is scripted: the mock answers
 * the first request with one `bash` tool call, pi runs the tool for real, and
 * the mock answers the follow-up (which must carry the tool's actual output)
 * with a closing sentence. The probe types into the composer like a person and
 * reads the result from the request log, the store and the screen.
 *
 * No model server starts (PI_E2E_NO_SERVER=1): the probe home's models.json
 * points a `mock` provider at the double, the way the supervisor points
 * `llamacpp` at a real llama-server.
 *
 *   SHOT_DIR=/tmp/shots node tests/e2e/mock-openai-smoke-probe.mjs
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = 'mock-4b';
const MARK = 'w0b-tool-ran';
const PROMPT = 'W0B-SMOKE: please run the check command and tell me what it printed.';
const CLOSING = 'so the tool round-trip works';

const mock = await startMockOpenAI({
  model: MODEL,
  rules: [
    {
      name: 'call-tool',
      match: { lastUser: 'W0B-SMOKE', afterTool: false },
      reply: {
        reasoning: 'The user wants the check command run. I will run it with bash.',
        content: 'Running the check now.',
        toolCalls: [{ name: 'bash', arguments: { command: `echo ${MARK}` } }],
      },
    },
    {
      name: 'after-tool',
      match: { afterTool: MARK },
      reply: { content: `The command printed **${MARK}**, ${CLOSING}.` },
    },
  ],
  // Anything else the app asks the model (none expected) is answered, and logged.
  defaultReply: { content: 'OK.' },
});

const home = probeHome('mock-openai-smoke');
writeModelsJson(home, { provider: 'mock', baseUrl: mock.baseUrl, model: MODEL, name: 'Mock 4B' });

const { app, page, check, shot, finish, shotDir } = await launchApp('mock-openai-smoke', {
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
  timeout: 60_000,
});
const mainLog = path.join(shotDir, 'main.log');
writeFileSync(mainLog, '');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}

const setTheme = async (mode) => {
  await page.evaluate(
    (m) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode: m } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};

const summary = {};
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  check(started.pid > 0, `pi did not start: ${JSON.stringify(started)}`);

  // Select the scripted model the way the supervisor's model switch does.
  const set = await page.evaluate(
    (m) => window.piDesktop.invoke('pi:set-model', { provider: 'mock', modelId: m }),
    MODEL,
  );
  check(set.success === true, `pi:set-model failed: ${JSON.stringify(set)}`);
  await page.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 20_000,
  });

  // A person's send: type into the composer, press Enter.
  const t0 = Date.now();
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(PROMPT);
  await page.keyboard.press('Enter');

  await mock.waitFor((e) => e.rule === 'after-tool', { timeoutMs: 90_000 });
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll('.pd-msg--assistant')].some((el) => el.innerText.includes(t)),
    CLOSING,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return !s.messages.some((m) => m.isStreaming) && s.promptInFlight !== true;
    },
    undefined,
    { timeout: 30_000 },
  );
  summary.turnMs = Date.now() - t0;

  // ── the wire: what the real pi sent the model ──
  const chats = mock.log.filter((e) => e.path.endsWith('/chat/completions'));
  const first = chats.find((e) => e.rule === 'call-tool');
  const second = chats.find((e) => e.rule === 'after-tool');
  summary.requests = mock.log.map((e) => ({
    seq: e.seq,
    path: e.path,
    rule: e.rule,
    stream: e.stream,
    promptN: e.promptN,
    cacheN: e.cacheN,
    tools: e.tools?.length,
  }));
  check(first !== undefined, 'the scripted tool-call request never arrived');
  check(first?.stream === true, 'pi did not stream the turn');
  check(first?.tools?.includes('bash'), `bash was not advertised: ${first?.tools?.join(',')}`);
  const bashTool = first?.body?.tools?.find((t) => t?.function?.name === 'bash');
  check(
    bashTool?.function?.parameters?.properties?.command !== undefined,
    'the advertised bash tool has no `command` parameter',
  );
  const system = first?.body?.messages?.find((m) => m.role === 'system')?.content ?? '';
  summary.systemPromptChars =
    typeof system === 'string' ? system.length : JSON.stringify(system).length;
  check(summary.systemPromptChars > 1000, 'no real harness system prompt reached the model');

  const msgs = second?.body?.messages ?? [];
  const call = msgs
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.tool_calls ?? [])
    .find((c) => c?.function?.name === 'bash');
  check(call !== undefined, 'the follow-up does not carry the assistant tool call');
  check(
    String(call?.function?.arguments ?? '').includes(`echo ${MARK}`),
    `the tool call arguments changed on the way: ${call?.function?.arguments}`,
  );
  const result = msgs.at(-1);
  check(result?.role === 'tool', `the follow-up does not end with a tool result: ${result?.role}`);
  check(
    JSON.stringify(result?.content ?? '').includes(MARK),
    `the tool result is not the command's real output: ${JSON.stringify(result?.content).slice(0, 200)}`,
  );
  summary.toolResult = JSON.stringify(result?.content ?? '').slice(0, 200);
  check(
    (second?.cacheN ?? 0) >= (first?.cacheN ?? 0) + (first?.promptN ?? 0) - 8,
    `the follow-up re-prefilled its history (cache ${second?.cacheN}, new ${second?.promptN})`,
  );

  // ── the app: what the renderer made of it ──
  const store = await page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.map((m) => ({
        kind: m.kind,
        text: m.kind === 'user' || m.kind === 'toolResult' ? m.text : undefined,
        toolName: m.toolName,
        blocks: (m.blocks ?? []).map((b) => ({
          type: b.type,
          name: b.name,
          text: (b.text ?? b.thinking ?? '').slice(0, 80),
          args: b.arguments,
        })),
      })),
  );
  summary.store = store;
  const toolCall = store
    .flatMap((m) => m.blocks)
    .find((b) => b.type === 'toolCall' && b.name === 'bash');
  check(toolCall !== undefined, 'the store has no bash tool call');
  check(
    toolCall?.args?.command === `echo ${MARK}`,
    `tool call args: ${JSON.stringify(toolCall?.args)}`,
  );
  const toolResult = store.find((m) => m.kind === 'toolResult');
  check(toolResult?.text?.includes(MARK), `the store's tool result: ${toolResult?.text}`);
  check(
    store.some((m) =>
      m.blocks.some((b) => b.type === 'thinking' && b.text.includes('check command')),
    ),
    'the scripted reasoning did not render as thinking',
  );

  await page.evaluate(() => document.activeElement?.blur());
  await setTheme('light');
  await new Promise((r) => setTimeout(r, 400));
  await shot('turn-light');
  await setTheme('dark');
  await new Promise((r) => setTimeout(r, 400));
  await shot('turn-dark');
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
  await shot('failure').catch(() => undefined);
} finally {
  writeFileSync(path.join(shotDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(shotDir, 'requests.json'), `${JSON.stringify(mock.log, null, 2)}\n`);
  await mock.close();
}
console.log(JSON.stringify({ ...summary, store: undefined }, null, 2));
await finish();
