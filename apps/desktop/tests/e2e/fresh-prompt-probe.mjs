/**
 * THE SYSTEM PROMPT OF A FRESH, PROJECTLESS CHAT — verbatim, headless.
 *
 * The user, reading it in the Advanced panel: "there's so much explanation which
 * I can't figure out what it's explaining about and the working directory is
 * by default users/the user when in no project??? not a sandbox..."
 *
 *   MODE=schemas MODEL=qwen3.5-4b-mtp OUT=/path/prompt.md node tests/e2e/fresh-prompt-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MODE = process.env.MODE ?? 'schemas';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'fresh-prompt', `${MODE}.md`);
mkdirSync(path.dirname(OUT), { recursive: true });
const home = probeHome('fresh-prompt');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
// A pinned model, as a person's settings would have: with the selection left on
// Auto the router re-tiers on every send (a server relaunch + a pi respawn), and
// the numbers measure the router, not the prompt.
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    toolInterface: MODE,
    powerMode: 'low',
    modelSelection: { mode: 'model', modelId: MODEL },
  }),
);

const mainLog = [];
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'fresh-prompt-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'bobble'),
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
app.process().stdout?.on('data', (d) => mainLog.push(...String(d).split('\n').filter(Boolean)));
app.process().stderr?.on('data', (d) => mainLog.push(...String(d).split('\n').filter(Boolean)));
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);
  const up = await win.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL,
  );
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  // NO project, NO pi:restart with a cwd — exactly a person's fresh chat.
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
    timeout: 60000,
  });
  await win.waitForTimeout(Number(process.env.WAIT_MS ?? 3000));
  const before = await win.evaluate(() => ({
    cwd: window.__pi_store().getState().session?.cwd ?? null,
    home: null,
  }));
  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight && !s.resuming;
    });
  const ttftOf = async (text) => {
    const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
    const editor = win.locator('[contenteditable="true"]').first();
    await editor.click();
    await win.keyboard.type(text, { delay: 5 });
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    console.log(JSON.stringify({ sentAt }));
    let ttft = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const chars = await win.evaluate((b) => {
        let c = 0;
        for (const m of window.__pi_store().getState().messages.slice(b))
          if (m.kind === 'assistant')
            for (const blk of m.blocks ?? [])
              c += blk.type === 'toolCall' ? 1 : (blk.text ?? blk.thinking ?? '').length;
        return c;
      }, before);
      if (chars > 0) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      if (await ready()) break;
      await win.waitForTimeout(500);
    }
    return ttft;
  };
  /* The server's own account of the turn: `/slots` keeps the last task's
     n_prompt_tokens vs n_prompt_tokens_processed — a follow-up that reused the
     prefix processed a handful; one that re-prefilled processed the lot. */
  const slotsAfter = async () => {
    const st = await win.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));
    const origin = String(st?.baseUrl ?? '').replace(/\/v1\/?$/, '');
    if (origin === '') return null;
    try {
      const res = await fetch(`${origin}/slots`);
      const slots = await res.json();
      return slots.map((x) => ({
        prompt: x.n_prompt_tokens,
        processed: x.n_prompt_tokens_processed,
      }));
    } catch (e) {
      return String(e);
    }
  };
  /* pi's own stderr, as the renderer receives it ('pi:event' _stderr): the
     provider's [pi-kv]/[pi-ctx] lines and anything the harness prints. */
  await win.evaluate(() => {
    window.__piStderr = [];
    window.piDesktop.onEvent('pi:event', (e) => {
      if (e?.type === '_stderr')
        window.__piStderr.push(`${Date.now()} ${String(e.text).slice(0, 300)}`);
    });
  });
  const stderrSince = async (from) =>
    (await win.evaluate(() => window.__piStderr)).filter((l) => Number(l.split(' ')[0]) >= from);
  const t1 = Date.now();
  const ttft1 = await ttftOf('hi');
  console.log(JSON.stringify({ ttft1, slots: await slotsAfter() }));
  for (const l of await stderrSince(t1))
    console.log('  stderr:', l.replace(/\n/g, ' | ').slice(0, 260));
  let got = '';
  let tools = '[]';
  for (let i = 0; i < 60; i += 1) {
    await win.waitForTimeout(1000);
    const st = await win.evaluate(() => window.__pi_store().getState().extensionStatus);
    if (
      typeof st['harness-prefill-system'] === 'string' &&
      st['harness-prefill-system'].length > 0
    ) {
      got = st['harness-prefill-system'];
      tools = st['harness-prefill-tools'] ?? '[]';
      break;
    }
  }
  const t2 = Date.now();
  const ttft2 = await ttftOf('and one more word');
  console.log(JSON.stringify({ ttft2, slots: await slotsAfter() }));
  for (const l of await stderrSince(t2))
    console.log('  stderr:', l.replace(/\n/g, ' | ').slice(0, 260));
  const piMsgs = await win.evaluate(() => window.piDesktop.invoke('pi:get-messages', undefined));
  console.log(
    JSON.stringify({
      piRoles: (piMsgs.messages ?? []).map(
        (m) =>
          `${m.role}${m.role === 'custom' ? `:${m.customType}=${String(m.content).slice(0, 80)}` : ''}`,
      ),
    }),
  );
  const msgs = await win.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.map(
        (m) =>
          `${m.kind}${m.kind === 'assistant' ? `(${(m.blocks ?? []).map((b) => b.type).join('+')})` : ''}${m.kind === 'toolResult' ? `[${m.toolName}${m.isError ? ' ERR' : ''}]` : ''}`,
      ),
  );
  console.log(
    JSON.stringify({
      msgs,
      queued: await win.evaluate(() => window.__pi_store().getState().queuedSends.length),
    }),
  );
  for (const l of mainLog
    .filter((l) => /pi\]|workspace|spawn|restart|exit|harness/i.test(l))
    .slice(-25))
    console.log(`  ${l.slice(0, 220)}`);
  const after = await win.evaluate(() => ({
    cwd: window.__pi_store().getState().session?.cwd ?? null,
    sessionFile: window.__pi_store().getState().session?.sessionFile ?? null,
    harness: window.__pi_store().getState().extensionStatus.harness ?? null,
  }));
  const { execSync } = await import('node:child_process');
  let piCwd = '?';
  try {
    const pids = execSync("pgrep -f 'cli.js --mode rpc' || true")
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    piCwd = pids
      .map((pid) =>
        execSync(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep '^n' | head -1`)
          .toString()
          .trim(),
      )
      .join(' | ');
  } catch {}
  console.log(JSON.stringify({ piProcessCwd: piCwd, harnessStatus: after.harness }));
  let names = [];
  try {
    names = JSON.parse(tools).map((t) => t.name);
  } catch {}
  writeFileSync(
    OUT,
    `# fresh chat, no project, ${MODE}\n\ncwd before send: ${before.cwd}\ncwd after send: ${after.cwd}\nsession: ${after.sessionFile}\nHOME (probe): ${home}\n\n${got.length} chars, tools (${names.length}): ${names.join(', ')}\n\n---\n\n${got}\n`,
  );
  console.log(
    JSON.stringify({
      chars: got.length,
      tools: names.length,
      cwdBefore: before.cwd,
      cwdAfter: after.cwd,
      out: OUT,
    }),
  );
} finally {
  await app.close().catch(() => {});
}
