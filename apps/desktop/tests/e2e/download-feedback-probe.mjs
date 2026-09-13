/**
 * A DOWNLOAD THAT CANNOT START SAYS SO — where it was pressed and in the top
 * bar — and a download that is running can be opened from the top bar.
 *
 * the user (2026-09-13): "clicking download on the model picker for the quick
 * ones, does not download them or show any user indication there like it
 * should either that there's not enough disk space or that it is downloading.
 * show download progress in the top bar clickable to show more details."
 *
 * Throwaway HOME, and the library on a 64 MB RAM disk so the refusal is the
 * supervisor's real "Not enough space" on any machine: the press shows it
 * under the row and as a chip in the top bar that opens the whole sentence.
 * The progress panel is driven with the store's own progress seam, so no
 * bytes move.
 *
 *   SHOT_DIR=/tmp/dlfb node apps/desktop/tests/e2e/download-feedback-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

/*
 * A DISK WITH NO ROOM, MADE FOR THE PROBE: a 64 MB RAM disk is the library
 * volume, so "Not enough space" is the supervisor's real answer whatever this
 * Mac's own disk has free today (it was 7 GB when the user reported this and 88 GB
 * an hour later). Detached at the end.
 */
const dev = execFileSync('hdiutil', ['attach', '-nomount', 'ram://131072']).toString().trim();
execFileSync('diskutil', ['erasevolume', 'HFS+', 'PDTINY', dev], { stdio: 'ignore' });
const tinyLibrary = '/Volumes/PDTINY/Models';
mkdirSync(tinyLibrary, { recursive: true });

const {
  page: win,
  check,
  finish,
  shotDir,
} = await launchApp('download-feedback', {
  waitFor: '[data-testid="composer-input"]',
  env: { PI_DESKTOP_MODELS_DIR: tinyLibrary },
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = async (name) =>
  writeFileSync(path.join(shotDir, `${name}.png`), await win.screenshot());
try {
  await win.waitForTimeout(1500);
  // 1. The tier picker: find a row that is not downloaded and whose file does
  //    not fit this disk.
  await win.click('[data-testid="footer-model-chip"]');
  await win.waitForSelector('[data-testid="footer-model-menu"]', { timeout: 5000 });
  await win.waitForTimeout(400);
  const buttons = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tier-download-"]')].map((b) =>
      b.getAttribute('data-testid').replace('tier-download-', ''),
    ),
  );
  log('download buttons:', buttons.join(','));
  const catalog = await win.evaluate(() => window.piDesktop.invoke('llm:list-catalog', undefined));
  const disk = await win.evaluate(() => window.piDesktop.invoke('storage:disk', undefined));
  const entries = (catalog.models ?? catalog).filter((m) => buttons.includes(m.id));
  log('library volume free:', disk.free, 'at', disk.root);
  const tooBig = entries.find((m) => (m.quants?.[0]?.bytes ?? 0) > disk.free - 2 * 1024 ** 3);
  if (tooBig === undefined) {
    console.log(
      'every offered model fits this disk — the refusal case is skipped (nothing is downloaded)',
    );
  } else {
    log(`pressing Download on ${tooBig.id} (${tooBig.quants[0].bytes} B, ${disk.free} B free)`);
    await win.click(`[data-testid="tier-download-${tooBig.id}"]`);
    await win.waitForSelector('[data-testid="tier-download-error"]', { timeout: 10000 });
    const rowErr = await win.evaluate(
      () => document.querySelector('[data-testid="tier-download-error"]')?.textContent ?? '',
    );
    log('row says:', rowErr);
    check(/Not enough space/.test(rowErr), `the row shows the refusal (${rowErr.slice(0, 60)})`);
    await shot('01-tier-refusal');
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
    const chip = await win.evaluate(
      () => document.querySelector('[data-testid="topbar-download-error"]')?.textContent ?? null,
    );
    check(
      chip !== null && /not downloaded/.test(chip),
      `the top bar carries the refusal chip (${chip})`,
    );
    await win.click('[data-testid="topbar-download-error"]');
    await win.waitForSelector('[data-testid="topbar-download-details"]', { timeout: 3000 });
    const detail = await win.evaluate(
      () => document.querySelector('[data-testid="topbar-download-details"]')?.textContent ?? '',
    );
    check(/Not enough space/.test(detail), 'the chip opens the whole sentence');
    await shot('02-topbar-refusal');
    await win.click('[data-testid="topbar-download-details"] button');
    await win.waitForTimeout(300);
    check(
      (await win.locator('[data-testid="topbar-download-error"]').count()) === 0,
      'Dismiss clears the chip',
    );
  }

  // 2. A running download in the top bar, clickable for the details.
  await win.evaluate(() => {
    window.__llm_store().getState().applyDownloadProgress({
      modelId: 'qwen3.5-4b-mtp',
      file: 'Qwen3.5-4B-Q8_0.gguf',
      received: 1_200_000_000,
      total: 4_800_000_000,
      fraction: 0.25,
      fileIndex: 0,
      fileCount: 3,
      jobReceived: 1_200_000_000,
      jobTotal: 6_100_000_000,
    });
  });
  await win.waitForSelector('[data-testid="topbar-downloads"]', { timeout: 3000 });
  await win.click('[data-testid="topbar-download-llm:qwen3.5-4b-mtp-open"]');
  await win.waitForSelector('[data-testid="topbar-download-details"]', { timeout: 3000 });
  const d = await win.evaluate(() => ({
    text: document.querySelector('[data-testid="topbar-download-details"]')?.textContent ?? '',
    buttons: [...document.querySelectorAll('[data-testid="topbar-download-details"] button')].map(
      (b) => b.textContent?.trim(),
    ),
  }));
  log('details:', JSON.stringify(d));
  check(
    /Qwen3\.5-4B-Q8_0\.gguf/.test(d.text) && /1 of 3/.test(d.text),
    'the file and its place in the job',
  );
  check(
    /1\.1 GB \/ 5\.7 GB|1\.2 GB \/ 6\.1 GB|GB \/ .*GB/.test(d.text) && /20%|19%/.test(d.text),
    `bytes and percent (${d.text.slice(0, 90)})`,
  );
  check(
    d.buttons.includes('Pause') && d.buttons.includes('Cancel'),
    `Pause and Cancel (${d.buttons})`,
  );
  await shot('03-topbar-details');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__llm_store().getState().settleDownload('qwen3.5-4b-mtp'));
} finally {
  await finish();
  try {
    execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}
