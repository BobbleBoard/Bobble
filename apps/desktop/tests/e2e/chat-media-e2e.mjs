/**
 * THE CLAIM THAT MATTERS: ask in a new chat, get media back.
 *
 * the user: "from the chat interface, these backends should be connected. I should
 * be able to go to a new chat and ask for any of these types of media or files,
 * all are delivered and embedded cleanly and in full quality into the chat."
 *
 * Everything else I have built for this is verifiable in isolation — the job
 * builder against the catalogue, the parser against the tool's own strings, the
 * player against a real WAV. This is the only test that proves the PIECES ARE
 * CONNECTED: a real model, deciding on its own to call a real tool, whose real
 * output lands in the real thread as something you can press play on.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/chat-e2e';
mkdirSync(OUT, { recursive: true });
const MODEL = process.env.MODEL ?? 'qwen3.5-9b-mtp';
const ASK =
  process.env.ASK ?? 'Use your speech tool to read this out loud: "Bobble can speak now."';
const CAP_MS = Number(process.env.CAP_MS ?? 420_000);

const settingsPath = path.join(homedir(), '.pi/desktop/settings.json');
const backup = readFileSync(settingsPath, 'utf8');
const settings = JSON.parse(backup);
settings.modelSelection = { mode: 'model', modelId: MODEL };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const log = [];
for (const s of [app.process().stdout, app.process().stderr]) {
  s?.on('data', (d) => log.push(String(d)));
}

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 30000 });
  await win.waitForTimeout(6000);

  const before = await win.evaluate(() => window.__pi_store?.().getState?.().messages?.length ?? 0);
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(ASK);
  await win.keyboard.press('Enter');
  console.log('[e2e] asked:', ASK);

  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < CAP_MS) {
    done = await win
      .evaluate((n) => {
        const ms = window.__pi_store?.().getState?.().messages ?? [];
        const after = ms.slice(n);
        if (!after.some((m) => m.kind === 'assistant')) return false;
        return !after.some((m) => m.isStreaming === true);
      }, before)
      .catch(() => false);
    if (done) break;
    /*
     * A CLOSED WINDOW IS NOT A SLOW TURN. Every probe of the window here is
     * `.catch(() => false)`, so when the app goes away the loop reads "not
     * finished yet" and keeps saying it until the cap — ten minutes of waiting
     * on something that ended in the first one, and then a stack trace from the
     * next unguarded evaluate rather than the actual cause.
     */
    if (win.isClosed()) {
      console.error('[e2e] the app window closed mid-turn — nothing left to measure');
      // Its own output is the only evidence left of WHY, so keep it.
      writeFileSync(`${OUT}/main.log`, log.join(''));
      console.error(log.join('').slice(-4000));
      process.exit(2);
    }
    await win.waitForTimeout(4000).catch(() => undefined);
  }

  /*
   * A SECOND TURN, because that is how the harness works — activating a
   * capability takes effect on the model's NEXT reply, and the tool result says
   * so in as many words: "They are NOT callable in this reply." A one-message
   * test measures the discovery step and calls it a failure.
   */
  const midway = await win.evaluate((n) => {
    const ms = window.__pi_store?.().getState?.().messages ?? [];
    return ms
      .slice(n)
      .some((m) => m.kind === 'toolResult' && /generation" is on/.test(m.text ?? ''));
  }, before);
  if (midway) {
    console.log('[e2e] capability activated; sending the follow-up turn');
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(process.env.FOLLOWUP ?? 'Go ahead now.');
    await win.keyboard.press('Enter');
    const t1 = Date.now();
    while (Date.now() - t1 < CAP_MS) {
      const d = await win
        .evaluate(() => {
          const ms = window.__pi_store?.().getState?.().messages ?? [];
          const tail = ms.slice(-4);
          return (
            tail.some((m) => m.kind === 'assistant') && !ms.some((m) => m.isStreaming === true)
          );
        })
        .catch(() => false);
      if (d) break;
      await win.waitForTimeout(4000).catch(() => undefined);
    }
  }

  const result = await win.evaluate((n) => {
    const ms = window.__pi_store?.().getState?.().messages ?? [];
    const after = ms.slice(n);
    const calls = [];
    for (const m of after) {
      if (m.kind === 'assistant') {
        for (const b of m.blocks ?? []) if (b.type === 'toolCall') calls.push(b.name);
      }
      if (m.kind === 'toolResult') calls.push(`result:${m.toolName}${m.isError ? '(ERR)' : ''}`);
    }
    const results = after
      .filter((m) => m.kind === 'toolResult')
      .map((m) => (m.text ?? '').slice(0, 300));
    return {
      calls,
      results,
      mediaMounted: document.querySelectorAll('[data-testid="thread-media"]').length,
      audioPlayers: document.querySelectorAll('[data-testid="thread-audio"]').length,
      fileCards: document.querySelectorAll('[data-testid="thread-file-card"]').length,
      waveBars: document.querySelectorAll('.pd-thread-audio-bar').length,
      images: document.querySelectorAll('[data-testid="thread-image"]').length,
      videos: document.querySelectorAll('[data-testid="thread-video"]').length,
      cardText: document.querySelector('[data-testid="thread-file-card"]')?.textContent ?? null,
    };
  }, before);

  console.log('[e2e] finished:', done, 'in', Math.round((Date.now() - t0) / 1000), 's');
  console.log('[e2e] RESULT:', JSON.stringify(result, null, 1));
  // Is the collapsed chain summary ACCURATE? It read "read a file" on a turn
  // whose only call was generate_speech, which is either a labelling bug or a
  // true statement about a step I did not capture. Worth knowing which.
  const chain = await win.evaluate(() => ({
    summary: document.querySelector('.pd-chain-summary-text')?.textContent ?? null,
    steps: [...document.querySelectorAll('.pd-chain-step-label')].map((n) => n.textContent),
  }));
  console.log('[e2e] CHAIN:', JSON.stringify(chain));

  /*
   * THE SPEECH ROW MUST OPEN.
   *
   * The chain keeps every step MOUNTED when collapsed (it animates
   * `grid-template-rows: 0fr → 1fr`), so counting nodes proves nothing — an
   * earlier version of this check called the reveal "clickable" while the chain
   * was shut. Measure boxes, and wait for the animation rather than racing it.
   */
  const reveal = await win.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = (el) => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.round(r.height);
    };
    const IGNORE = /^(Thought|Done)$/;
    const generateRow = (root) =>
      [...root.querySelectorAll('.pd-chain-step-row')].find((r) => {
        const t = r.querySelector('.pd-chain-step-label')?.textContent?.trim() ?? '';
        return t !== '' && !IGNORE.test(t);
      });
    const chain = [...document.querySelectorAll('.pd-chain')].find((c) => generateRow(c));
    if (!chain) return { found: false };

    const out = { found: true, expandedAtRest: chain.dataset.expanded === 'true' };
    if (!out.expandedAtRest) {
      chain.querySelector('.pd-chain-summary')?.click();
      await sleep(600);
    }
    out.expandedNow = chain.dataset.expanded === 'true';

    const row = generateRow(chain);
    out.rowLabel = row?.querySelector('.pd-chain-step-label')?.textContent?.trim() ?? null;
    out.rowHeight = box(row);
    if (!row || out.rowHeight === 0) return out;

    row.click();
    await sleep(700);
    // The step's own body — the reveal this fix is about.
    const body = row.closest('.pd-chain-step')?.querySelector('.pd-chain-facts, .pd-chain-preview');
    out.factLabels = [
      ...(row.closest('.pd-chain-step')?.querySelectorAll('.pd-chain-fact-label') ?? []),
    ].map((n) => n.textContent);
    out.revealHeight = box(body);
    out.revealText = body ? body.innerText.replace(/\s+/g, ' ').slice(0, 160) : null;
    return out;
  });
  console.log('[e2e] GENERATE ROW:', JSON.stringify(reveal));

  /*
   * THE CANVAS TAB A GENERATED IMAGE OPENS. An image row routes to the canvas
   * rather than expanding, and that tab opened on nothing — "Failed to load
   * file content" under the title "PNG" — while the picture sat correctly in
   * the thread. The tab is a different surface with a different src, so the
   * thread rendering says nothing about it.
   */
  const canvas = await win.evaluate(() => {
    const tab =
      document.querySelector('.pd-canvas-tab[data-active] .pd-canvas-tab-label') ??
      document.querySelector('.pd-canvas-tab-label');
    const err = document.querySelector('.pd-media-error');
    const img = document.querySelector('.pd-media-body img');
    return {
      tabTitle: tab?.textContent?.trim() ?? null,
      failed: err !== null,
      imgSrc: img?.getAttribute('src') ?? null,
      imgLoaded: img instanceof HTMLImageElement ? img.naturalWidth > 0 : null,
    };
  });
  console.log('[e2e] CANVAS TAB:', JSON.stringify(canvas));
  const chainShot = win.locator('.pd-chain').first();
  await chainShot.screenshot({ path: `${OUT}/chain-expanded.png` }).catch(() => {});
  await win.screenshot({ path: path.join(OUT, 'chat.png'), fullPage: true });
  writeFileSync(path.join(OUT, 'main.log'), log.join(''));
} finally {
  writeFileSync(settingsPath, backup);
  await app.close().catch(() => undefined);
  console.log('[e2e] artifacts in', OUT);
}
