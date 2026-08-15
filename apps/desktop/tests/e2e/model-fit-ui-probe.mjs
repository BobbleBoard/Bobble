/**
 * LOOK at the model manager's fit/sort/ordering work in the real app.
 *
 * the user's standing rule on UI work: drive the real thing and look, because tests
 * pass while the screen is wrong. This asserts the things the unit tests cannot
 * — that the badge is on screen, that its tooltip carries the arithmetic, that
 * the dropdown really is ordered the way `orderQuantsForDisplay` says, and that
 * the verdict CHANGES when the quant does.
 *
 * Isolated empty HOME by default: no model is cached there, so nothing can
 * auto-start and this is safe to run beside a live corp run on the one GPU.
 * The catalog, the hardware detect and every fit computation are real.
 *
 *   REAL_HOME=1  use the actual model cache, so the downloaded-card and the
 *                delete confirmation can be checked too. Reads only — the
 *                delete dialog is opened, read, screenshotted and CANCELLED.
 *
 * Run `pnpm build` first. Screenshots land in .corp-runs/model-fit-ui/.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');
const OUT = path.join(repoRoot, '.corp-runs', 'model-fit-ui');
const MODEL_ID = process.env.MODEL_ID ?? 'qwen3.8-27b-mtp';

const failures = [];
function check(ok, message) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${message}`);
  if (!ok) failures.push(message);
}

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('model-fit-ui-probe: app not built — run `pnpm build` first');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const env = { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' };
if (process.env.REAL_HOME !== '1') env.HOME = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env,
});

try {
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 200));
  });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 25000 });

  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 10000 });
  await page.click('[data-testid="settings-nav-models"]');
  await page.waitForSelector('[data-testid="model-manager"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid^="model-card-"]', { timeout: 10000 });
  await page.screenshot({ path: path.join(OUT, '1-manager.png'), fullPage: true });

  const hardware = await page.evaluate(() => window.__llm_store?.().getState().hardware ?? null);
  console.log('hardware:', JSON.stringify(hardware));
  check(hardware !== null && hardware.totalRamGB > 0, 'hardware was detected (real RAM)');

  // ── The 27B card exists and its verdict shows its working ────────────────
  const card = page.locator(`[data-testid="model-card-${MODEL_ID}"]`);
  check((await card.count()) > 0, `the ${MODEL_ID} card is in the catalog`);
  await card.scrollIntoViewIfNeeded();

  const badge = page.locator(`[data-testid="ram-badge-${MODEL_ID}"]`);
  const label = (await badge.textContent())?.trim() ?? '';
  const detail = (await badge.getAttribute('title')) ?? '';
  console.log(`verdict: "${label}"  title: "${detail}"`);
  check(
    ['Fits', 'Tight — will swap', "Won't fit"].includes(label),
    `verdict is a fit verdict ("${label}")`,
  );
  check(
    /GB of \d+ GB with a \d+k context/.test(detail),
    `verdict shows its arithmetic ("${detail}")`,
  );
  await card.screenshot({ path: path.join(OUT, '2-card.png') });

  // ── The dropdown: ordering + per-row fit dots ────────────────────────────
  await page.click(`[data-testid="quant-${MODEL_ID}"]`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '3-quant-dropdown.png') });

  const rows = await page.locator('[role="option"]').allTextContents();
  console.log('rows:', JSON.stringify(rows));
  check(rows.length >= 2, `the dropdown lists the quants (${rows.length})`);

  /*
   * The invariants, not a hand-written expected list:
   *   · fit classes are contiguous and in order (Fits → Tight → Won't fit)
   *   · row 0 is in the best class present — it is the preselection
   *   · inside the won't-fit tail, ascending (near-misses first)
   * Size is NOT strictly descending inside a class: a dynamic quant outranks a
   * marginally larger plain one (UD_QUALITY_BONUS), which is deliberate.
   */
  const sizes = rows.map((r) => {
    const m = /([\d.]+)\s*GB/.exec(r);
    return m ? Number(m[1]) : Number.NaN;
  });
  const classOf = (r) => (r.includes("Won't fit") ? 2 : r.includes('Tight') ? 1 : 0);
  const classes = rows.map(classOf);
  console.log('row sizes:', JSON.stringify(sizes));
  console.log('row classes:', JSON.stringify(classes));
  check(
    classes.every((c, i) => i === 0 || c >= classes[i - 1]),
    `fit classes are grouped and ordered: ${JSON.stringify(classes)}`,
  );
  check(classes[0] === Math.min(...classes), 'row 0 is in the best fit class on offer');
  const tail = sizes.filter((_, i) => classes[i] === 2);
  check(
    tail.every((s, i) => i === 0 || s >= tail[i - 1]),
    `the won't-fit tail is ascending — near-misses first (${JSON.stringify(tail)})`,
  );
  // A dynamic quant should win the top slot over a marginally larger plain one.
  check(/UD-/.test(rows[0]), `row 0 is a dynamic quant where one fits ("${rows[0]}")`);

  // A dot per row, coloured by fit.
  const dotCount = await page.locator('[role="option"] span.rounded-full').count();
  check(
    dotCount >= rows.length,
    `every row carries a fit dot (${dotCount} for ${rows.length} rows)`,
  );

  // ── The verdict MOVES with the selection ─────────────────────────────────
  const lastRow = page.locator('[role="option"]').nth(rows.length - 1);
  const lastText = (await lastRow.textContent())?.trim() ?? '';
  await lastRow.click();
  await page.waitForTimeout(500);
  const label2 = (await badge.textContent())?.trim() ?? '';
  const detail2 = (await badge.getAttribute('title')) ?? '';
  console.log(`after selecting "${lastText}": "${label2}"  title: "${detail2}"`);
  check(detail2 !== detail, `the verdict moved when the quant did ("${detail}" → "${detail2}")`);
  await card.screenshot({ path: path.join(OUT, '4-card-other-quant.png') });

  // ── "Only what fits" ─────────────────────────────────────────────────────
  const fitsToggle = page.locator('[data-testid="mm-fits-toggle"]');
  if ((await fitsToggle.count()) > 0) {
    const beforeCards = await page.locator('[data-testid^="model-card-"]').count();
    await fitsToggle.click();
    await page.waitForTimeout(500);
    const afterCards = await page.locator('[data-testid^="model-card-"]').count();
    console.log(`fits filter: ${beforeCards} cards → ${afterCards}`);
    check(afterCards > 0, 'the fit filter leaves something on screen');
    check(
      afterCards <= beforeCards,
      `the fit filter hid the models that cannot load (${beforeCards} → ${afterCards})`,
    );
    await page.screenshot({ path: path.join(OUT, '5-fits-only.png'), fullPage: true });
    await fitsToggle.click();
  } else {
    console.log('  --   fit filter absent (every model fits this machine)');
  }

  /*
   * ── The delete confirmation (REAL_HOME only) ─────────────────────────────
   * Deleting the 27B was one click on a ghost button: 14.4 GB and a 3m30s
   * re-download, with no dialog and no undo. This opens it, reads it, and
   * presses CANCEL — a probe must never destroy what it is inspecting.
   */
  /*
   * The action row must describe the SELECTED quant. With one quant on disk,
   * selecting a different one used to keep offering Verify/Delete/Set active —
   * and Set active would have tried to load a file that is not there.
   */
  const onDiskQuants = await page.evaluate((id) => {
    const e = window
      .__llm_store?.()
      .getState()
      .catalog.find((c) => c.id === id);
    return e?.downloadedQuants ?? [];
  }, MODEL_ID);
  console.log('on disk:', JSON.stringify(onDiskQuants));
  if (onDiskQuants.length > 0) {
    // Currently a NON-downloaded quant is selected (the probe picked the last row).
    const selectedNow =
      (await page.locator(`[data-testid="quant-${MODEL_ID}"]`).textContent()) ?? '';
    const isOnDisk = onDiskQuants.some((q) => selectedNow.includes(q));
    const showsDownload =
      (await page.locator(`[data-testid="download-${MODEL_ID}-btn"]`).count()) > 0;
    check(
      isOnDisk !== showsDownload,
      `the action row follows the selected quant (selected="${selectedNow.trim()}", onDisk=${isOnDisk}, showsDownload=${showsDownload})`,
    );
    // Now pick the downloaded one and confirm the row flips.
    await page.click(`[data-testid="quant-${MODEL_ID}"]`);
    await page.waitForTimeout(400);
    await page.locator('[role="option"]', { hasText: onDiskQuants[0] }).first().click();
    await page.waitForTimeout(500);
    check(
      (await page.locator(`[data-testid="delete-${MODEL_ID}"]`).count()) > 0,
      `selecting the downloaded quant (${onDiskQuants[0]}) offers Delete / Set active`,
    );
  }

  const del = page.locator(`[data-testid="delete-${MODEL_ID}"]`);
  if ((await del.count()) > 0) {
    await del.click();
    const dialog = page.locator(`[data-testid="delete-dialog-${MODEL_ID}"]`);
    await dialog.waitFor({ timeout: 5000 });
    const text = (await dialog.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    console.log(`delete dialog: "${text}"`);
    check(/Frees [\d.]+ GB/.test(text), `the delete dialog says what it frees ("${text}")`);
    await page.screenshot({ path: path.join(OUT, '7-delete-confirm.png') });
    await dialog.locator('text=Cancel').click();
    await page.waitForTimeout(400);
    check((await dialog.count()) === 0, 'Cancel closes the dialog without deleting');
  } else {
    console.log('  --   delete dialog not checked (model not downloaded in this HOME)');
  }
} finally {
  await app.close().catch(() => {});
}

console.log(`\nscreenshots: ${OUT}`);
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('model-fit-ui-probe: all checks passed');
