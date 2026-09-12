/**
 * THE CHILDREN'S BOOK, RERUN — the user's exact brief, a real model, generation on.
 *
 * What went wrong last time: the model (and a subagent it spawned) drew the
 * eight "illustrations" with PIL — text on a coloured rectangle, 10 KB each —
 * and never reached `generate_image`. This drives the real app, headless, and
 * records what the model actually did: every tool call in order, whether the
 * pictures came from the generator, what landed on disk, and the pending
 * cards' notes (paced? made room?).
 *
 * Throwaway HOME (never the shared settings), the real model cache, a pinned
 * chat model, low power (the new default — the mode this run is about).
 *
 *   MODEL   chat model id            (default qwen3.5-4b-mtp)
 *   MODE    schemas | bash-cli       (default schemas)
 *   OUT     screenshots + report dir (default /tmp/childrens-book)
 *   MINUTES how long to let it run   (default 45)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MODE = process.env.MODE ?? 'schemas';
const OUT = process.env.OUT ?? '/tmp/childrens-book';
const MINUTES = Number(process.env.MINUTES ?? 45);
const TARGET = '/Users/user/Pictures/childrens-book/';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

// the user's brief, verbatim — or PROMPT, for a one-picture look at the same path.
const PROMPT =
  process.env.PROMPT ??
  "Create 8 high-quality illustrations for a children's book titled 'The Guardian of the Hidden Forest'. " +
    'The book is about a small fox named Bramble discovering a magical forest. Each slide needs a unique illustration: ' +
    "(1) Title slide - a tree with a hidden forest; (2) Bramble's discovery - a fox looking up at leaves; " +
    '(3) Main message - small flowers and leaves; (4) Forest at a glance - a large forest scene; ' +
    '(5) Nature observations - individual leaves and flowers; (6) Journey of protection - a path through forest; ' +
    '(7) Comparing care vs. protection - two contrasting scenes; (8) Takeaways - a happy forest scene. ' +
    `Use detailed, vivid, and child-friendly art. Save all images to ${TARGET}`;

const home = probeHome('childrens-book');
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
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'childrens-book-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'),
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    UV_CACHE_DIR: path.join(homedir(), '.cache', 'uv'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_DESKTOP_GEN: '1',
  },
});
for (const st of [app.process().stdout, app.process().stderr]) {
  st?.on('data', (d) => {
    for (const line of String(d).split('\n'))
      if (/make room|park|resume chat|guardian|power policy|gen\]|desktop:gen|SHED/i.test(line))
        mainLog.push(line);
  });
}

const listTarget = () => {
  if (!existsSync(TARGET)) return [];
  return readdirSync(TARGET)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const p = path.join(TARGET, f);
      let dims = '';
      try {
        dims = execFileSync('/usr/bin/file', ['-b', p], { encoding: 'utf8' })
          .replace(/PNG image data, /, '')
          .split(',')
          .slice(0, 1)
          .join('')
          .trim();
      } catch {}
      return `${f} ${Math.round(statSync(p).size / 1024)} KB ${dims}`;
    });
};

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
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
    timeout: 60000,
  });
  await win.waitForTimeout(3000);

  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type(PROMPT, { delay: 1 });
  await win.waitForTimeout(300);
  const sentAt = Date.now();
  await win.keyboard.press('Enter');
  say('sent the brief');

  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight && !s.resuming;
    });
  const snapshot = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      const calls = [];
      for (const m of s.messages) {
        if (m.kind !== 'assistant') continue;
        for (const b of m.blocks ?? []) {
          if (b.type !== 'toolCall') continue;
          const args = b.args ?? b.arguments ?? {};
          let brief = '';
          try {
            const a = typeof args === 'string' ? JSON.parse(args) : args;
            brief =
              a.prompt ?? a.command ?? a.goal ?? a.path ?? a.name ?? Object.keys(a).join(',') ?? '';
          } catch {
            brief = String(args).slice(0, 80);
          }
          calls.push(`${b.name}: ${String(brief).replace(/\s+/g, ' ').slice(0, 110)}`);
        }
      }
      const results = s.messages
        .filter((m) => m.kind === 'toolResult')
        .map((m) => `${m.toolName}${m.isError ? ' ERR' : ''}`);
      return {
        calls,
        results,
        notes: [...document.querySelectorAll('[data-testid="pending-pct"]')].map(
          (n) => n.textContent,
        ),
        banner: document.querySelector('[data-testid="guardian-banner"]')?.textContent ?? null,
        tabs: [...document.querySelectorAll('[data-testid="canvas-tab"], .pd-canvas-tab')]
          .map((t) => t.textContent?.trim())
          .slice(0, 12),
        text: s.messages
          .filter((m) => m.kind === 'assistant')
          .map((m) =>
            (m.blocks ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join(''),
          )
          .join('\n')
          .slice(-600),
      };
    });

  let lastCalls = 0;
  let lastNote = '';
  let shotPending = false;
  let shots = 0;
  const deadline = Date.now() + MINUTES * 60_000;
  let idleSince = null;
  let snap = await snapshot();
  while (Date.now() < deadline) {
    await win.waitForTimeout(2000);
    snap = await snapshot();
    if (snap.calls.length !== lastCalls) {
      for (const c of snap.calls.slice(lastCalls)) say(`call → ${c}`);
      lastCalls = snap.calls.length;
    }
    const note = snap.notes.join(' | ');
    if (note !== lastNote && note !== '') {
      say(`card: ${note}${snap.banner ? `  banner: ${snap.banner}` : ''}`);
      lastNote = note;
      if (!shotPending) {
        shotPending = true;
        await win.screenshot({ path: path.join(OUT, 'pending.png') });
      }
    }
    if ((Date.now() - sentAt) / 60_000 > shots) {
      shots += 1;
      await win.screenshot({ path: path.join(OUT, `min-${String(shots).padStart(2, '0')}.png`) });
    }
    if (await ready()) {
      idleSince ??= Date.now();
      // Idle for a while with nothing in flight: the turn is over.
      if (Date.now() - idleSince > 8000) break;
    } else {
      idleSince = null;
    }
  }
  const elapsed = ((Date.now() - sentAt) / 1000).toFixed(0);
  await win.screenshot({ path: path.join(OUT, 'final.png'), fullPage: true });
  const files = listTarget();
  say(`DONE in ${elapsed}s — ${snap.calls.length} tool calls`);
  say(`FILES (${files.length}):\n  ${files.join('\n  ')}`);
  say(`LAST TEXT: ${snap.text.replace(/\s+/g, ' ').slice(-400)}`);
  const gens = snap.calls.filter((c) =>
    /^generate_image|^media generate|generate_image/.test(c),
  ).length;
  const pil = snap.calls.filter((c) => /PIL|ImageDraw|Pillow|from PIL/i.test(c)).length;
  say(
    `generate_image calls: ${gens}; PIL-ish bash calls: ${pil}; errors: ${snap.results.filter((r) => / ERR/.test(r)).length}`,
  );
  const report = [
    `# children's book rerun — ${MODEL} / ${MODE} / low power`,
    '',
    `elapsed: ${elapsed}s, tool calls: ${snap.calls.length}, generate_image: ${gens}, PIL: ${pil}`,
    '',
    '## calls',
    ...snap.calls.map((c, i) => `${i + 1}. ${c}`),
    '',
    '## results',
    snap.results.join(', '),
    '',
    '## files',
    ...files.map((f) => `- ${f}`),
    '',
    '## last text',
    snap.text,
    '',
    '## main log',
    ...mainLog.slice(-60),
  ].join('\n');
  writeFileSync(path.join(OUT, 'report.md'), report);
  console.log(
    mainLog
      .filter((l) => /make room|park|resume chat|SHED/i.test(l))
      .slice(-12)
      .join('\n'),
  );
} finally {
  await app.close().catch(() => {});
}
