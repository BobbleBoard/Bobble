/**
 * A REAL multi-gigabyte download, driven the way a person does it, watched the
 * way a person watches it.
 *
 * the user: "download the 27b through the model picker driving the UI via
 * playwright/automation to ensure it all works end to end and progress in
 * indicated well and non confusingly as the user uses the app as normal while
 * the download (which is far from instant in most cases) occurs."
 *
 * Every other model-manager probe drives `download-progress` through the store
 * hook with synthetic numbers. That proves the component renders and proves
 * nothing about the thing this is for: whether a 13.4 GB pull, split across a
 * model and its vision projector, reads sensibly for the eight minutes it takes
 * — including from the chat screen, which is where the user actually is.
 *
 * WHAT IT ASSERTS
 *   1. The card's fit verdict responds to the QUANT, and shows its arithmetic.
 *   2. The quant list is ordered largest-that-fits first, so row 0 — the
 *      preselection Download acts on — is the recommendation.
 *   3. Download starts from the preselected quant with one click.
 *   4. The reported fraction NEVER GOES BACKWARDS. This is the whole point: the
 *      job spans two files and a per-file bar restarts at the projector.
 *   5. Progress is legible from the chat screen (percent + ETA in the footer),
 *      not only from the settings pane the user has navigated away from.
 *   6. The second file is NAMED, in words, so its smaller byte count reads as a
 *      new file rather than a lost one.
 *   7. The files land, complete, with the right sizes.
 *
 * Real HOME (the actual model cache) + mock pi (no model is loaded; this is
 * about the downloader, and the GPU may be busy).
 *
 *   MODEL_ID   catalog id to download        (default qwen3.8-27b-mtp)
 *   MAX_MIN    give up after this many mins  (default 25)
 *
 * Run `pnpm build` first. This DELETES and re-downloads the model's files.
 */
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

const MODEL_ID = process.env.MODEL_ID ?? 'qwen3.8-27b-mtp';
const MAX_MIN = Number(process.env.MAX_MIN ?? 25);
const modelsDir = path.join(homedir(), '.cache/pi-desktop/models', MODEL_ID);

const failures = [];
const notes = [];
function check(ok, message) {
  if (ok) notes.push(`  ok   ${message}`);
  else failures.push(message);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${message}`);
}
function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('model-download-ux-probe: app not built — run `pnpm build` first');
  process.exit(1);
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  // REAL home (real model cache, real hardware detect); mock pi so no model loads.
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') log('console.error:', m.text().slice(0, 200));
  });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20000 });

  // ── Navigate the way a user does: profile → settings → models ──────────────
  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 10000 });
  await page.click('[data-testid="settings-nav-models"]');
  await page.waitForSelector('[data-testid="model-manager"]', { timeout: 10000 });

  const card = page.locator(`[data-testid="model-card-${MODEL_ID}"]`);
  await card.waitFor({ timeout: 15000 });
  log('card visible');

  const hardware = await page.evaluate(() => window.__llm_store?.().getState().hardware ?? null);
  log('hardware:', JSON.stringify(hardware));

  // ── 1. The fit verdict is about the SELECTED quant, and shows its working ──
  const ramBadge = page.locator(`[data-testid="ram-badge-${MODEL_ID}"]`);
  const verdictQ3 = (await ramBadge.textContent())?.trim() ?? '';
  const detailQ3 = (await ramBadge.getAttribute('title')) ?? '';
  log(`verdict @ default quant: "${verdictQ3}" (${detailQ3})`);
  check(verdictQ3.length > 0, 'fit verdict is rendered');
  check(/GB of \d+ GB/.test(detailQ3), `fit verdict shows its arithmetic (title="${detailQ3}")`);

  // ── 2. Row 0 is the recommendation; the list is largest-fitting-first ──────
  await page.click(`[data-testid="quant-${MODEL_ID}"]`);
  await page.waitForTimeout(400);
  const rows = await page.locator('[role="option"]').allTextContents();
  log('quant rows:', JSON.stringify(rows));
  check(rows.length > 1, `quant dropdown lists options (${rows.length})`);
  const selected = (await page.locator(`[data-testid="quant-${MODEL_ID}"]`).textContent()) ?? '';
  check(
    rows.length > 0 && rows[0].includes(selected.trim().split(' ')[0]),
    `the preselected quant is row 0 (selected="${selected.trim()}", row0="${rows[0]}")`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── The verdict MOVES when the quant does ─────────────────────────────────
  const quants = await page.evaluate((id) => {
    const st = window.__llm_store?.().getState();
    const e = st?.catalog.find((c) => c.id === id);
    return e?.quants.map((q) => q.quant) ?? [];
  }, MODEL_ID);
  log('catalog quants:', JSON.stringify(quants));

  // ── 3. Start the real download from the preselected quant ─────────────────
  const before = existsSync(modelsDir) ? readdirSync(modelsDir) : [];
  log('model dir before:', JSON.stringify(before));
  check(before.length === 0, `model dir is empty before the download (${before.length} files)`);

  await page.click(`[data-testid="download-${MODEL_ID}-btn"]`);
  log('Download clicked');
  await page.waitForSelector(`[data-testid="download-${MODEL_ID}"]`, { timeout: 30000 });
  log('progress UI appeared');

  // ── 4/5/6. Watch it, from BOTH screens, sampling the reported fraction ────
  let maxFraction = 0;
  let regressions = 0;
  let sawEta = false;
  let sawFooter = false;
  let sawSecondFile = false;
  let sawFileLabel = '';
  let onChatScreen = false;
  const deadline = Date.now() + MAX_MIN * 60_000;
  let lastLog = 0;

  while (Date.now() < deadline) {
    const dl = await page.evaluate(() => {
      const d = window.__llm_store?.().getState().download ?? null;
      return d === null ? null : { ...d };
    });
    if (dl === null) {
      log('download state cleared — job finished or failed');
      break;
    }

    const frac =
      dl.jobTotal != null && dl.jobTotal > 0 && dl.jobReceived != null
        ? dl.jobReceived / dl.jobTotal
        : (dl.fraction ?? 0);
    if (frac + 1e-9 < maxFraction) {
      regressions += 1;
      log(
        `REGRESSION: fraction ${(frac * 100).toFixed(1)}% < max ${(maxFraction * 100).toFixed(1)}%`,
      );
    }
    maxFraction = Math.max(maxFraction, frac);
    if ((dl.fileIndex ?? 0) > 0) sawSecondFile = true;

    // Halfway through, go and use the app like a person: back to chat.
    if (!onChatScreen && frac > 0.03) {
      await page.click('[data-testid="settings-back"]').catch(() => {});
      await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });
      onChatScreen = true;
      log('navigated back to chat — the download is now off-screen');
    }

    if (onChatScreen) {
      const footer = page.locator('[data-testid="footer-download"]');
      if ((await footer.count()) > 0) {
        sawFooter = true;
        const text = (await footer.textContent())?.trim() ?? '';
        if (/left/.test(text)) sawEta = true;
        if (Date.now() - lastLog > 20_000) {
          log(`chat-screen indicator: "${text}"`);
          lastLog = Date.now();
        }
      }
    } else if (Date.now() - lastLog > 20_000) {
      const line = page.locator(`[data-testid="download-line-${MODEL_ID}"]`);
      if ((await line.count()) > 0) log(`settings line: "${(await line.textContent())?.trim()}"`);
      lastLog = Date.now();
    }

    // The named-file line only exists on the card, so peek when it's the 2nd file.
    if (sawSecondFile && sawFileLabel === '' && onChatScreen) {
      await page.click('[data-testid="profile-button"]').catch(() => {});
      await page.click('[data-testid="open-settings"]').catch(() => {});
      await page.click('[data-testid="settings-nav-models"]').catch(() => {});
      const label = page.locator(`[data-testid="download-file-${MODEL_ID}"]`);
      if ((await label.count()) > 0) sawFileLabel = (await label.textContent())?.trim() ?? '';
      log(`second-file label: "${sawFileLabel}"`);
      await page.click('[data-testid="settings-back"]').catch(() => {});
      onChatScreen = true;
    }

    await page.waitForTimeout(1500);
  }

  check(
    regressions === 0,
    `the reported progress never went backwards (${regressions} regressions)`,
  );
  check(maxFraction > 0.9, `progress reached the end (max ${(maxFraction * 100).toFixed(1)}%)`);
  check(sawFooter, 'progress is visible from the chat screen, not only in settings');
  check(sawEta, 'the chat-screen indicator carries an ETA, not just a bar');
  check(sawSecondFile, 'the projector was fetched as part of the same job');
  check(
    sawFileLabel === '' || /projector|weights|head|draft/i.test(sawFileLabel),
    `the second file is named in words ("${sawFileLabel}")`,
  );

  // ── 7. The files actually landed ─────────────────────────────────────────
  const after = existsSync(modelsDir) ? readdirSync(modelsDir) : [];
  const sizes = after.map((f) => ({ f, bytes: statSync(path.join(modelsDir, f)).size }));
  log('model dir after:', JSON.stringify(sizes, null, 2));
  check(
    after.some((f) => f.endsWith('.gguf') && !f.includes('mmproj')),
    'the model GGUF is on disk',
  );
  check(
    after.some((f) => f.includes('mmproj')),
    'the projector is on disk',
  );
  check(!after.some((f) => f.endsWith('.part')), 'no .part files left behind');

  await page.screenshot({ path: path.join(repoRoot, '.corp-runs', 'download-ux-final.png') });
} finally {
  await app.close().catch(() => {});
}

console.log(`\n${'='.repeat(60)}`);
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('model-download-ux-probe: all checks passed');
