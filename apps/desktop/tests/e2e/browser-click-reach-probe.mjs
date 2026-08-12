/**
 * AFTER IT NAVIGATES, CAN IT CLICK?
 *
 * The bee-logbook run called browser_navigate once and then browser_snapshot NINE
 * times, never clicking, while its own thinking said "Let me click the sample data
 * button". The suspicion was grammar coercion: click not advertised, so the bid
 * collapses onto the nearest advertised browser name.
 *
 * But `harness/index.ts` has activated the whole browser suite on browser_navigate
 * since abd2c86 (30 July) — before that run. So either the activation does not
 * reach the advertised list, or it does and the cause is something else entirely.
 * Guessing between those two picks the wrong fix, so this reads the ACTUAL tools
 * array llama-server was sent, per request, via PI_ADV_DEBUG_TOOLS.
 *
 *   node tests/e2e/browser-click-reach-probe.mjs
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? '/tmp/click-reach';
const TOOLS_LOG = `${OUT}-tools.log`;
const PAGE = `${OUT}-page.html`;

rmSync(TOOLS_LOG, { force: true });
writeFileSync(
  PAGE,
  `<!doctype html><meta charset="utf-8"><title>Click Reach</title>
<h1>Hive Logbook</h1><p id="out">no data yet</p>
<button id="add" onclick="document.getElementById('out').textContent='SAMPLEADDED'">Add Sample Data</button>`,
);

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot],
  env: { ...process.env, PI_E2E: '1', PI_ADV_DEBUG_TOOLS: TOOLS_LOG },
});

/** Every tools array llama-server was actually sent, in request order. */
function toolSetsPerRequest() {
  let text = '';
  try {
    text = readFileSync(TOOLS_LOG, 'utf8');
  } catch {
    return [];
  }
  // `cwd=… team=… tools[17] sysPromptChars=…: read, write, …` (advanced-hook.ts)
  return text
    .split('\n')
    .filter((l) => l.includes('tools['))
    .map((l) => ({
      count: Number(l.match(/tools\[(\d+)\]/)?.[1] ?? -1),
      click: l.includes('browser_click'),
      navigate: l.includes('browser_navigate'),
      snapshot: l.includes('browser_snapshot'),
    }));
}

const fail = [];

try {
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('llm:start-server', { modelId });
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  await win
    .waitForFunction(
      () => document.querySelector('[data-testid="composer-model-loading"]') === null,
      undefined,
      { timeout: 300_000 },
    )
    .catch(() => {});
  console.log('model warm');

  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(
    `Open file://${PAGE} in the browser, click the button labelled "Add Sample Data", ` +
      'then take a snapshot and tell me exactly what the paragraph says afterwards.',
  );
  await win.keyboard.press('Enter');

  const doneBy = Date.now() + 240_000;
  while (Date.now() < doneBy) {
    const busy = await win.evaluate(
      () => window.__pi_store?.().getState?.().agent?.isStreaming ?? false,
    );
    if (!busy && Date.now() > doneBy - 235_000) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const text = await win.evaluate(() =>
    [...document.querySelectorAll('.pd-msg--assistant')].map((r) => r.textContent ?? '').join('\n'),
  );
  await win.screenshot({ path: `${OUT}-01.png`, fullPage: true }).catch(() => {});

  const sets = toolSetsPerRequest();
  const firstWithClick = sets.findIndex((s) => s.click);
  console.log(`\nrequests captured : ${sets.length}`);
  console.log(
    `browser_click first advertised on request: ${firstWithClick === -1 ? 'NEVER' : firstWithClick + 1}`,
  );
  for (const [i, s] of sets.entries()) {
    console.log(
      `  req ${i + 1}: tools=${s.count} navigate=${s.navigate} snapshot=${s.snapshot} click=${s.click}`,
    );
  }
  /* The OUTCOME: only a real click changes the paragraph. */
  const clicked = text.includes('SAMPLEADDED');
  console.log(`page actually clicked (paragraph changed): ${clicked}`);

  if (sets.length === 0) fail.push('no tools arrays captured — PI_ADV_DEBUG_TOOLS wrote nothing');
  if (firstWithClick === -1) fail.push('browser_click was never advertised, even after navigate');
  if (!clicked) fail.push('the button was never actually clicked');
  console.log(`\nlog -> ${TOOLS_LOG}   screenshot -> ${OUT}-01.png`);
  if (fail.length === 0) console.log('PASS — navigate makes clicking reachable, and it clicked');
  else for (const f of fail) console.log(`FAIL — ${f}`);
  process.exitCode = fail.length === 0 ? 0 : 1;
} finally {
  await app.close();
}
