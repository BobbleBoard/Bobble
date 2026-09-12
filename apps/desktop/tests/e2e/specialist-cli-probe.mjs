/**
 * A SPECIALIST CHILD RUNS ON THE CLI — with its own kit, and nothing lost.
 *
 * the user: "ensure there is a cli connector for the specialists that is by default
 * there and enabled, cli tools are a good context saver so it's important that
 * they're just the same power as schemas."
 *
 * The chat here is set to SCHEMAS (the user's own setting); the document specialist
 * is spawned as a child and asked what it can do. PI_ADV_DEBUG_TOOLS makes the
 * child's harness write the command surface it built — which only happens in
 * CLI mode — so the log is the proof: the child is on the CLI, and the commands
 * it can run are its kit (office_*, write/read/ls/bash, the browser, the web).
 *
 *   MODEL=qwen3.5-4b-mtp node tests/e2e/specialist-cli-probe.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PROJECT = path.join(tmpdir(), 'specialist-cli', 'project');
mkdirSync(PROJECT, { recursive: true });
const home = probeHome('specialist-cli');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(path.join(home, '.pi', 'desktop', 'settings.json'), JSON.stringify({ toolInterface: 'schemas', powerMode: 'low' }));
const debugLog = path.join(tmpdir(), 'specialist-cli', 'tools.log');
writeFileSync(debugLog, '');

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'specialist-cli-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'), PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_ADV_DEBUG_TOOLS: debugLog },
});
const t0 = Date.now();
const say = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
let ok = true;
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 60000 });
  await win.waitForTimeout(1500);
  const up = await win.evaluate((id) => window.piDesktop.invoke('llm:start-server', { modelId: id }), MODEL);
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await win.evaluate((p) => window.piDesktop.invoke('pi:restart', { cwd: p }), PROJECT);
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, { timeout: 60000 });
  await win.waitForTimeout(2000);
  const events = [];
  await win.exposeFunction('__probeChildEvent', (e) => events.push(e));
  await win.evaluate(() => {
    window.piDesktop.onEvent('pi:child-event', (e) =>
      window.__probeChildEvent({
        type: e.event?.type,
        text:
          (e.event?.message?.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('') || '',
        raw: JSON.stringify(e.event).slice(0, 300),
      }),
    );
  });
  const res = await win.evaluate(
    (p) =>
      window.piDesktop.invoke('pi:child-spawn', {
        childId: 'probe-doc-1',
        parentId: 'probe',
        title: 'Document specialist',
        goal: 'In one short paragraph, list the commands you have available (run `tools` first), then stop.',
        cwd: p,
        specialist: 'document',
      }),
    PROJECT,
  );
  say(`spawned: ${JSON.stringify(res)}`);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    if (events.some((e) => e.type === 'agent_end')) break;
    await win.waitForTimeout(1000);
  }
  // The child's words: the last message_end carries the whole assistant message.
  const ends = events.filter((e) => e.type === 'message_end');
  const text = ends.map((e) => e.text).join(' ').trim();
  say(`event types: ${[...new Set(events.map((e) => e.type))].join(',')}`);
  for (const e of events.filter((x) => x.type === 'tool_execution_start' || x.type === 'message_end').slice(0, 6)) say(`  ${e.raw}`);
  const log = readFileSync(debugLog, 'utf8');
  const runnable = /specialist\((\w+)\) commands\((\d+)\)=([^\n]*)/.exec(log);
  say(`child reply: ${text.slice(0, 600).replace(/\n/g, ' ')}`);
  say(`cli surface (${runnable ? runnable[1] : '-'}): ${runnable ? runnable[3] : '(no specialist commands line — the child was NOT in CLI mode)'}`);
  const cmds = runnable ? runnable[3].split(',') : [];
  const checks = {
    cliMode: runnable !== null,
    hasOffice: cmds.includes('office_make') && cmds.includes('office_edit') && cmds.includes('office_inspect'),
    noSpawn: !cmds.includes('spawn_subagent'),
    answered: text.length > 0,
  };
  for (const [k, v] of Object.entries(checks)) if (!v) { ok = false; say(`FAIL ${k}`); }
  say(JSON.stringify(checks));
} finally {
  await app.close().catch(() => {});
}
console.log(ok ? 'specialist-cli-probe OK' : 'specialist-cli-probe FAILED');
process.exit(ok ? 0 : 1);
