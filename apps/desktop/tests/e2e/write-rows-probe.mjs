/**
 * WRITTEN FILES, AS THE THREAD AND THE CANVAS SHOW THEM — live, through the
 * real chat on the real model.
 *
 * the user (2026-09-13): every written file opened in the canvas as "Could not
 * read this file"; two "Wrote a file" rows carried no name and could not be
 * clicked; the > chevrons sat pinned to the right edge.
 *
 * The chat asks for three small files in ONE response (three write calls in
 * one message — the shape the unnamed rows appeared in). While it streams and
 * after it settles, the probe records every activity row's label + filename,
 * the store's tool-call blocks (id / arguments / argsText), then clicks each
 * row and reads what the canvas tab shows. Screenshots at each stage.
 *
 *   OUT=/tmp/write-rows node apps/desktop/tests/e2e/write-rows-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'write-rows');
mkdirSync(OUT, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('write-rows');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'write-rows-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const mainLog = [];
app.process().stdout?.on('data', (d) => mainLog.push(String(d)));
app.process().stderr?.on('data', (d) => mainLog.push(String(d)));
const shot = async (win, name) =>
  writeFileSync(path.join(OUT, `${name}.png`), await win.screenshot());

/** Every activity row: its label, filename and the chevron's position. */
const rows = (win) =>
  win.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.pd-chain-step')) {
      const label = el.querySelector('.pd-chain-step-label');
      const file = el.querySelector('.pd-chain-step-subline');
      const chev = el.querySelector('.pd-chain-step-chevron');
      const stat = el.querySelector('.pd-chain-step-diffstat');
      const r = (el.querySelector('.pd-chain-step-row') ?? el).getBoundingClientRect();
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      out.push({
        text,
        label: label?.textContent?.trim() ?? null,
        file: file?.textContent?.trim() ?? null,
        rowRight: Math.round(r.right),
        textRight: Math.round(
          Math.max(
            (file ?? label)?.getBoundingClientRect().right ?? r.left,
            stat?.getBoundingClientRect().right ?? 0,
          ),
        ),
        chevLeft: chev === null ? null : Math.round(chev.getBoundingClientRect().left),
        clickable: el.matches('button, [role="button"], a') || el.querySelector('button') !== null,
      });
    }
    return out;
  });

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
  await win.waitForTimeout(1500);
  log(`starting ${MODEL} on llama.cpp…`);
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  // Through the store, as the engine menu does: relaunches on llama.cpp (a
  // calibration record may say otherwise) AND repoints pi at it.
  const sw = await win.evaluate(() =>
    window.__llm_store().getState().switchProfile('llamacpp', 'none'),
  );
  log('switchProfile:', JSON.stringify(sw));
  await win.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 300_000,
  });
  log('pi model:', await win.evaluate(() => window.__pi_store().getState().agent.model?.id));
  await win.waitForTimeout(4000);

  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(
    'Create three files in the working folder using three separate write tool calls in this single response: alpha.txt containing "one", beta.txt containing "two", gamma.txt containing "three". Then say done.',
  );
  await win.keyboard.press('Enter');
  // Watch the rows while the calls stream.
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const s = await win.evaluate(() => {
      const st = window.__pi_store().getState();
      const calls = [];
      for (const m of st.messages) {
        if (m.kind !== 'assistant') continue;
        for (const b of m.blocks) {
          if (b.type === 'toolCall') {
            calls.push({
              id: b.id,
              name: b.name,
              path: b.arguments?.path ?? null,
              argsText: (b.argsText ?? '').length,
            });
          }
        }
      }
      return { streaming: st.agent.isStreaming, calls };
    });
    const r = await rows(win);
    const sig = JSON.stringify({ c: s.calls, r: r.map((x) => `${x.label}|${x.file}`) });
    if (seen[seen.length - 1]?.sig !== sig) {
      seen.push({ at: Date.now() - t0, sig, calls: s.calls, rows: r });
      log(
        `+${Date.now() - t0}ms calls=${s.calls.map((c) => `${c.name}:${c.path ?? '?'}(${c.argsText})`).join(' ')} rows=${r.map((x) => `${x.label}·${x.file ?? '-'}`).join(' | ')}`,
      );
      // The state the user saw: a second call streaming while the first has no
      // result yet.
      if (s.calls.length >= 2 && !seen.some((e) => e.shot)) {
        await shot(win, '01-streaming');
        seen[seen.length - 1].shot = true;
      }
    }
    if (!s.streaming && s.calls.length >= 3) break;
    await win.waitForTimeout(150);
  }
  await win.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return s.agent.isStreaming !== true && s.promptInFlight !== true;
    },
    undefined,
    { timeout: 120_000 },
  );
  await win.waitForTimeout(800);
  const settled = await rows(win);
  log('settled rows:', JSON.stringify(settled));
  await shot(win, '02-settled');
  const writes = settled.filter((r) => /file/i.test(r.label ?? ''));
  check(writes.length >= 3, `three write rows (${writes.length})`);
  for (const r of writes) {
    check(r.file !== null && r.file.length > 0, `row "${r.label}" names its file`);
    // The chevron sits right after the text, not pinned to the right edge.
    if (r.chevLeft !== null) {
      check(
        r.chevLeft - r.textRight < 40,
        `chevron of ${r.file} sits by the text (gap ${r.chevLeft - r.textRight}px, row right ${r.rowRight})`,
      );
    }
  }
  // Every unnamed-row state seen while streaming is a defect too.
  for (const e of seen) {
    for (const r of e.rows) {
      if (/wrote a file/i.test(r.label ?? '') && (r.file === null || r.file === '')) {
        check(false, `at +${e.at}ms a done write row had no name: ${r.text}`);
      }
    }
  }

  // The chain collapses to its summary once the turn ends; open it first.
  for (const summary of await win.$$('.pd-chain[data-expanded="false"] .pd-chain-summary')) {
    await summary.click();
    await win.waitForTimeout(300);
  }
  // Click each written file's row → the canvas shows the file, not an error.
  const rowEls = await win.$$(
    '.pd-chain-step .pd-chain-step-open-main, .pd-chain-step button.pd-chain-step-row',
  );
  let clicked = 0;
  for (const el of rowEls) {
    const text = ((await el.textContent()) ?? '').trim();
    if (!/(alpha|beta|gamma)\.txt/.test(text)) continue;
    await el.click();
    await win.waitForTimeout(900);
    const canvas = await win.evaluate(() => {
      const t = document.querySelector(
        '[data-testid="canvas-tab-active"], .pd-canvas-tab[data-active="true"]',
      );
      const body = document.querySelector(
        '[data-testid="canvas-body"], .pd-canvas-body, .cm-content',
      );
      return {
        tab: t?.textContent?.trim() ?? null,
        body: (body?.textContent ?? '').trim().slice(0, 200),
        error: document.body.innerText.includes('Could not read this file'),
      };
    });
    log(
      `clicked ${text.slice(0, 40)} → tab=${canvas.tab} error=${canvas.error} body=${JSON.stringify(canvas.body.slice(0, 60))}`,
    );
    check(
      !canvas.error,
      `canvas shows the file for ${text.slice(0, 30)} (not "Could not read this file")`,
    );
    clicked++;
    if (clicked === 1) await shot(win, '03-canvas');
  }
  check(clicked >= 1, 'clicked at least one file row');
} finally {
  writeFileSync(path.join(OUT, 'main.log'), mainLog.join(''));
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'write-rows-probe OK' : `FAILED: ${failures.length}`);
