/**
 * THE OFFICE PIPELINE, FROM A CHAT, WITH A REAL MODEL — and LOOK.
 *
 * the user: "model should not be using python-pptx, there is a dedicated subagent
 * for each pptx/docx/xlsx creation and editing right?" This asks the app, as a
 * person would, for a deck (and then a change to it), and records what the
 * model reached for, what landed on disk, what the canvas shows, and how long
 * the next reply took to start (a re-prefill after the tool would show here).
 *
 *   MODEL=qwen3.5-4b-mtp MODE=bash-cli|schemas node tests/e2e/office-live-probe.mjs
 *
 * Output: $OUT/{01-deck,02-edit}.png, $OUT/canvas-*.png (the office editor's own
 * capture), $OUT/report.json, and the produced files under the project.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MODE = process.env.MODE ?? 'bash-cli';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'office-live', MODE);
const PROJECT = process.env.PROJECT ?? path.join(tmpdir(), 'office-live', `project-${MODE}`);
const TURN_MS = Number(process.env.TURN_MS ?? 420_000);
mkdirSync(OUT, { recursive: true });
mkdirSync(path.join(PROJECT, 'docs'), { recursive: true });

const home = probeHome('office-live');
// The person's tool-interface choice, as the settings file carries it.
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ toolInterface: MODE, powerMode: 'auto' }),
);

const PROMPTS = [
  {
    id: 'deck',
    prompt:
      "Make me a 6-slide deck for the owners of Marlow's Bakery about Q3 2026 and save it as docs/q3-review.pptx. Revenue was $412,000, up 14% on Q2 ($361,000). Sourdough is 38% of revenue, pastries 29%, coffee 21%, catering 12%. Wholesale accounts grew from 9 to 14. Staff turnover fell from 22% to 11% after the new rota. Q4 plan: open the second counter at the Northside market on Oct 12, launch the holiday catering menu on Nov 1, hire two bakers. Risks: flour up 9%, the oven lease renews in December.",
  },
  {
    id: 'edit',
    prompt: 'Change the title of the last slide to "What we do next".',
  },
];

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'office-live-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const mainLog = [];
app.process().stdout?.on('data', (d) => mainLog.push(...String(d).split('\n').filter(Boolean)));
app.process().stderr?.on('data', (d) => mainLog.push(...String(d).split('\n').filter(Boolean)));
const errors = [];
const report = { model: MODEL, mode: MODE, turns: [] };
const say = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const t0 = Date.now();

try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(`[pageerror] ${String(e.stack ?? e).slice(0, 600)}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 600)}`);
  });
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 60000 });
  await win.waitForTimeout(1500);
  await win.evaluate((p) => window.piDesktop.invoke('project:set', { path: p }), PROJECT);
  await win.reload();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 60000 });
  await win.waitForTimeout(2000);
  const up = await win.evaluate((id) => window.piDesktop.invoke('llm:start-server', { modelId: id }), MODEL);
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await win.evaluate((p) => window.piDesktop.invoke('pi:restart', { cwd: p }), PROJECT);
  const models = await win.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  await win.evaluate((t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }), target);
  await win.evaluate(
    (id) => window.__settings_store?.().getState?.().update?.({ modelSelection: { mode: 'model', modelId: id } }),
    MODEL,
  );
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, { timeout: 60000 });
  await win.waitForTimeout(3000);
  say(`model up: ${MODEL}, mode ${MODE}, project ${PROJECT}`);

  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming;
    });
  const answerDialogs = async () => {
    const found = await win
      .evaluate(() => {
        const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
        if (!dlg) return null;
        const title = (dlg.querySelector('h1,h2,h3,[id$="title"]')?.textContent ?? '').trim();
        const cancel = [...dlg.querySelectorAll('button')].find((b) => /don.?t|cancel|not now|dismiss|deny|^no\b/i.test(b.textContent ?? ''));
        if (cancel) { cancel.click(); return { title, answered: 'Cancel' }; }
        return { title, answered: null };
      })
      .catch(() => null);
    if (found !== null) say(`[dialog] "${found.title}" → ${found.answered ?? 'left open'}`);
  };
  const waitReady = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await answerDialogs();
      if (await ready()) return true;
      await win.waitForTimeout(1000);
    }
    return false;
  };
  const turnDump = (before) =>
    win.evaluate((b) => {
      const msgs = window.__pi_store().getState().messages.slice(b);
      const calls = [];
      const results = [];
      let text = '';
      for (const m of msgs) {
        if (m.kind === 'assistant') {
          for (const blk of m.blocks ?? []) {
            if (blk.type === 'toolCall') calls.push({ name: blk.name, args: JSON.stringify(blk.arguments).slice(0, 400) });
            if (blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) text = blk.text.trim();
          }
        }
        if (m.kind === 'toolResult') results.push({ tool: m.toolName, text: String(m.text ?? '').slice(0, 700), isError: m.isError === true, hasImage: Array.isArray(m.images) && m.images.length > 0 });
      }
      return { calls, results, text: text.slice(0, 600) };
    }, before);
  const canvasState = () =>
    win.evaluate(() => {
      const c = window.__pi_canvas?.();
      const s = c?.getState();
      return { tabs: (s?.tabs ?? []).map((t) => ({ id: t.id, kind: t.kind, title: t.title ?? '', filePath: t.filePath ?? '' })), active: s?.activeTabId ?? null };
    });

  let n = 0;
  for (const p of PROMPTS) {
    n += 1;
    const tag = `${String(n).padStart(2, '0')}-${p.id}`;
    await waitReady(30_000);
    const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
    const editor = win.locator('[contenteditable="true"]').first();
    await editor.click();
    await win.keyboard.type(p.prompt, { delay: 3 });
    await win.waitForTimeout(300);
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    // TTFT: the first assistant characters of THIS turn.
    let ttft = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const chars = await win.evaluate((b) => {
        const msgs = window.__pi_store().getState().messages.slice(b);
        let c = 0;
        for (const m of msgs) if (m.kind === 'assistant') for (const blk of m.blocks ?? []) c += blk.type === 'toolCall' ? 1 : (blk.text ?? blk.thinking ?? '').length;
        return c;
      }, before);
      if (chars > 0) { ttft = Date.now() - sentAt; break; }
      await new Promise((r) => setTimeout(r, 40));
    }
    say(`${tag}: sent; first token ${ttft ?? 'TIMEOUT'}ms`);
    const finished = await waitReady(TURN_MS);
    const seconds = Math.round((Date.now() - sentAt) / 1000);
    await win.waitForTimeout(1500);
    await win.screenshot({ path: path.join(OUT, `${tag}.png`) });
    const turn = await turnDump(before);
    const canvas = await canvasState();
    // The office editor's own capture — the WebContentsView is invisible to a
    // page screenshot.
    const officeTab = canvas.tabs.find((t) => t.kind === 'office');
    let captured = false;
    if (officeTab) {
      const cap = await win.evaluate((id) => window.piDesktop.invoke('office:capture', { tabId: id }), officeTab.id).catch(() => null);
      if (cap?.dataUrl) {
        writeFileSync(path.join(OUT, `canvas-${tag}.png`), Buffer.from(cap.dataUrl.split(',')[1], 'base64'));
        captured = true;
      }
    }
    const files = existsSync(path.join(PROJECT, 'docs')) ? readdirSync(path.join(PROJECT, 'docs')) : [];
    const entry = { id: p.id, finished, seconds, ttft, calls: turn.calls, results: turn.results, text: turn.text, canvas, captured, files, errors: errors.length };
    report.turns.push(entry);
    say(`${tag}: ${finished ? 'done' : 'TIMEOUT'} in ${seconds}s; calls=${turn.calls.map((c) => c.name).join(',')}; files=${files.join(',')}; canvas=${canvas.tabs.map((t) => t.kind).join(',')}; capture=${captured}`);
    for (const r of turn.results) say(`   result[${r.tool}${r.isError ? ' ERROR' : ''}]: ${r.text.replace(/\n/g, ' ⏎ ').slice(0, 300)}`);
    say(`   reply: ${turn.text.replace(/\n/g, ' ').slice(0, 300)}`);
  }
} catch (err) {
  say(`FAILED: ${err.message}`);
  report.failed = String(err.message);
} finally {
  report.errors = errors.slice(0, 20);
  report.mainLog = mainLog.filter((l) => /office|present|prefill|slot|cache/i.test(l)).slice(-40);
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await app.close().catch(() => {});
}
console.log(`report: ${path.join(OUT, 'report.json')}`);
