/**
 * DOES A CONNECTOR WORK, END TO END, WITH A REAL MODEL? (the user, 2026-10-06: "are
 * the connectors seamless and working at all?")
 *
 * The connectors probes before this one drive the Connectors SCREEN against a
 * mock pi — add, switch off, save a key — and the `pi-tool` bridge is covered
 * by mcp-lite's unit tests. Nothing had put a real model in front of a real
 * MCP server inside the real app. This does, headless, with a harmless one:
 * the official `time` server (`uvx mcp-server-time`), in Bash-CLI mode.
 *
 *   A. a person's question it is for: "What time is it in Tokyo right now?" —
 *      did the model reach for the connector (`pi-tool time …`), or answer
 *      some other way, and was the answer right?
 *   B. the plumbing alone: run `pi-tool list` — does the shim, the socket and
 *      the server answer at all?
 *
 * What the model ran and what came back are read from the request bodies
 * (PI_DIAG_PROMPTS_FULL) — every tool call and result as sent — not guessed
 * from the screen. The system prompt is checked for any word of the connector.
 *
 *   node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/connector-call-probe.mjs
 *   (MODEL=<id>, OUT=<dir>)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? '/tmp/connector-call';
mkdirSync(OUT, { recursive: true });
const DIAG = path.join(OUT, 'diag.log');
/* FINDER_PATH=1: the app gets the bare system PATH a Finder-launched Bobble has. */
const FINDER_PATH = process.env.FINDER_PATH === '1';
/* BLENDER=1: one read-only question about the open Blender scene (needs Blender
   open with Blender Lab's MCP add-on; it changes nothing in the scene). */
const BLENDER = process.env.BLENDER === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const home = probeHome('connector-call');
const desk = path.join(home, '.pi', 'desktop');
mkdirSync(desk, { recursive: true });
writeFileSync(
  path.join(desk, 'settings.json'),
  `${JSON.stringify(
    {
      userMode: 'power',
      effort: 'medium',
      toolInterface: 'bash-cli',
      mcpMode: 'bash-cli',
      modelSelection: { mode: 'model', modelId: MODEL },
    },
    null,
    2,
  )}\n`,
);
// The catalog's own template for Time (packages/mcp-lite/src/detect-apps.ts).
writeFileSync(
  path.join(desk, 'mcp-connectors.json'),
  `${JSON.stringify(
    {
      version: 1,
      mode: 'bash-cli',
      servers: [
        {
          id: 'time',
          name: 'Time',
          icon: '🕐',
          description: 'Current time and timezone conversions.',
          command: 'uvx',
          args: ['mcp-server-time'],
          enabled: true,
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const { page, check, finish } = await launchApp('connector-call', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    PI_DIAG_PROMPTS: DIAG,
    PI_DIAG_PROMPTS_FULL: '1',
    ...(FINDER_PATH ? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } : {}),
  },
  timeout: 120_000,
});
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
await page.waitForFunction(
  (m) =>
    window.__llm_store?.().getState().status.model?.id === m &&
    window.__llm_store().getState().status.phase === 'ready',
  MODEL,
  { timeout: 900_000 },
);
await page
  .waitForFunction(
    () => window.__pi_store().getState().extensionStatus?.['harness-prefix-warm'] === 'ready',
    null,
    { timeout: 180_000 },
  )
  .catch(() => undefined);
log('model up and warm');

const bodies = () =>
  existsSync(`${DIAG}.bodies.jsonl`)
    ? readFileSync(`${DIAG}.bodies.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((r) => r.engine !== 'utility' && r.engine !== 'prefill')
    : [];
const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === 'string' ? p : (p.text ?? ''))).join('')
      : '';
/** Every tool call and its result in the conversation, as last sent. */
const calls = () => {
  const last = bodies().at(-1);
  if (last === undefined) return [];
  const out = [];
  const results = new Map();
  for (const m of last.body.messages)
    if (m.role === 'tool') results.set(m.tool_call_id, textOf(m.content));
  for (const m of last.body.messages) {
    for (const c of m.tool_calls ?? []) {
      out.push({
        name: c.function?.name,
        args: (c.function?.arguments ?? '').slice(0, 300),
        result: (results.get(c.id) ?? '').slice(0, 400),
      });
    }
  }
  return out;
};
const replyText = () =>
  page.evaluate(() => {
    const rows = window
      .__pi_store()
      .getState()
      .messages.filter((r) => r.kind === 'assistant');
    return (rows.at(-1)?.blocks ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  });
const turn = async (label, text) => {
  const before = calls().length;
  await page.click('.pd-composer-editor');
  await page.keyboard.type(text, { delay: 5 });
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await sleep(1500);
  /* Idle for 3 s running, not one glance: a turn pauses between its steps
     (a nudge, a retry), and the next question typed into that gap queued
     behind it and read as its answer. */
  let idleSince = null;
  while (Date.now() - t0 < 600_000) {
    const busy = await page
      .locator('[data-testid="composer-stop"], [data-testid="composer-paused"]')
      .count();
    if (busy > 0) idleSince = null;
    else if (idleSince === null) idleSince = Date.now();
    else if (Date.now() - idleSince > 3000) break;
    await sleep(250);
  }
  // The request after the turn's last tool result carries it; a turn that
  // ended on a reply has it in the final body.
  await sleep(1000);
  const made = calls().slice(before);
  const reply = await replyText();
  await page.screenshot({ path: path.join(OUT, `${label}.png`) });
  const r = { label, ms: Date.now() - t0, calls: made, reply: reply.slice(0, 500) };
  log(label, JSON.stringify(r, null, 1));
  return r;
};

const report = { model: MODEL, finderPath: FINDER_PATH };
const usageSince = (from) => {
  try {
    return [
      ...readFileSync(DIAG, 'utf8')
        .slice(from)
        .matchAll(/\[pi-diag-usage\] engine=(\S+) prompt_tokens=(\d+) cached_tokens=(\d+)/g),
    ].map((m) => ({ prompt: Number(m[2]), cached: Number(m[3]) }));
  } catch {
    return [];
  }
};
const diagSize = () => (existsSync(DIAG) ? readFileSync(DIAG).length : 0);

const at = diagSize();
report.a = await turn('a-tokyo', 'What time is it in Tokyo right now?');
const first = usageSince(at)[0];
report.turn1Prefill = first ?? null;
// The prompt as the chat's first request sent it.
const sys = textOf(bodies()[0]?.body.messages?.[0]?.content ?? '');
report.systemPrompt = {
  timeLine: (sys.match(/^ {2}pi-tool time — .*$/m) ?? [null])[0],
  blenderLine: (sys.match(/^ {2}blender — .*$/m) ?? [null])[0],
};
report.a2 = await turn('a2-named', 'Use my Time connector to tell me the time in Tokyo.');
report.b = await turn('b-list', 'Run `pi-tool list` in bash and tell me exactly what it prints.');
if (BLENDER) report.c = await turn('c-blender', "What's in my Blender scene right now?");

const used = (t, re) => t.calls.some((c) => re.test(c.args));
check(
  report.systemPrompt.timeLine !== null,
  `the prompt names the connector: ${report.systemPrompt.timeLine}`,
);
check(
  first !== undefined && first.cached / first.prompt >= 0.8,
  `turn 1 read its prompt from the warmed cache (${first?.cached}/${first?.prompt})`,
);
log(
  `natural ask used the connector: ${used(report.a, /pi-tool\s+time\b/)} (${JSON.stringify(report.a.calls.map((c) => c.args))})`,
);
check(
  report.a2.calls.some(
    (c) => /pi-tool\s+time\s+\S/.test(c.args) && /Tokyo|\d{2}:\d{2}/.test(c.result),
  ),
  `named, the model ran the connector and it answered (${JSON.stringify(report.a2.calls.map((c) => [c.args, c.result.slice(0, 80)]))})`,
);
check(
  report.b.calls.some(
    (c) =>
      /pi-tool\s+list/.test(c.args) &&
      /pi-tool time \S+ --help/.test(c.result) &&
      !/mcp_call/.test(c.result),
  ),
  'pi-tool list speaks CLI (pi-tool time <tool> --help, no mcp_call)',
);
if (BLENDER) {
  check(
    report.systemPrompt.blenderLine !== null,
    `the prompt names Blender: ${report.systemPrompt.blenderLine}`,
  );
  check(
    report.c.calls.some((c) => /\bblender\s+scene\b/.test(c.args) && /object_count/.test(c.result)),
    `asked about the Blender scene, the model read it (${JSON.stringify(report.c.calls.map((c) => c.args))})`,
  );
}
writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
log('report', JSON.stringify({ systemPromptMentions: report.systemPromptMentions }));

await page.evaluate(() => window.piDesktop.invoke('llm:stop-server')).catch(() => undefined);
await sleep(3000);
await finish();
