/**
 * A DOWNLOAD THAT CANNOT START SAYS SO — where it was pressed and in the top
 * bar — and a download that is running can be opened from the top bar.
 *
 * The user (2026-09-13): "clicking download on the model picker for the quick
 * ones, does not download them or show any user indication there like it
 * should either that there's not enough disk space or that it is downloading.
 * show download progress in the top bar clickable to show more details."
 *
 * Throwaway HOME, and the library on a 64 MB RAM disk so the refusal is the
 * supervisor's real "Not enough space" on any machine: the press shows it
 * under the row, and the task tray (top-left, beside the sidebar toggle; its
 * "Downloads" group since 2026-09-24) comes up with a red dot and lists it.
 * A running download (driven through the store's seam, no bytes move) shows
 * its bar, X, bytes and Pause inside the tray, hover caption below the bar
 * elsewhere, and nothing in the input area.
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
    // …and in the tray: the button is up, top-left, with a red dot (the news
    // is a failure); opening it lists the refusal under "Downloads" and clears
    // the dot; dismissing it takes the button away again.
    const tray = await win.evaluate(() => {
      const b = document.querySelector('[data-testid="task-tray"]');
      const r = b?.getBoundingClientRect();
      const dot = b?.querySelector('.pd-task-tray-dot');
      return {
        present: b !== null,
        left: r === undefined ? null : Math.round(r.left),
        dot: dot?.getAttribute('data-tone') ?? null,
        noFooterBar: document.querySelector('[data-testid="footer-download"]') === null,
        oldIcon: document.querySelector('[data-testid="download-tray"]') !== null,
      };
    });
    log('tray:', JSON.stringify(tray));
    check(
      tray.present && tray.left !== null && tray.left < 700,
      `the tray button sits top-left (x=${tray.left})`,
    );
    check(tray.dot === 'failed', `a red dot on the button (${tray.dot})`);
    check(tray.noFooterBar, 'no progress bar in the input area');
    check(!tray.oldIcon, 'no second download icon in the top bar');
    await shot('02-tray-badge');
    await win.click('[data-testid="task-tray"]');
    await win.waitForSelector('[data-testid="task-tray-panel"]', { timeout: 3000 });
    await win.waitForTimeout(300);
    const panel = await win.evaluate(() => ({
      text: document.querySelector('[data-testid="tray-downloads"]')?.textContent ?? '',
      dot: document.querySelector('[data-testid="task-tray"] .pd-task-tray-dot') !== null,
    }));
    check(
      /Downloads/.test(panel.text) &&
        /Not downloaded/.test(panel.text) &&
        /Not enough space/.test(panel.text),
      'the tray lists the refusal, with the sentence, under Downloads',
    );
    check(!panel.dot, 'opening the tray clears the dot');
    await shot('03-tray-refusal');
    await win.hover('[data-testid="transfer-notice"]');
    await win.click('[data-testid="transfer-notice"] .pd-task-row-x');
    await win.waitForTimeout(400);
    check(
      (await win.locator('[data-testid="task-tray"]').count()) === 0,
      'dismissing the only notice takes the button away',
    );
  }

  // 2. A running download: the button; the tray shows its bar and red X, the
  //    bytes, and Pause. Driven through the store's seam, so no bytes move.
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
  await win.waitForSelector('[data-testid="task-tray"]', { timeout: 3000 });
  await win.click('[data-testid="task-tray"]');
  await win.waitForSelector('[data-testid="task-tray-panel"]', { timeout: 3000 });
  await win.waitForTimeout(300);
  const d = await win.evaluate(() => {
    const row = document.querySelector(
      '[data-testid="transfer-row"][data-key="llm:qwen3.5-4b-mtp"]',
    );
    // The tray writes the numbers beside the bar; the hub's bars keep their
    // hover caption, below the bar.
    const rule = [...document.styleSheets]
      .flatMap((ss) => {
        try {
          return [...ss.cssRules];
        } catch {
          return [];
        }
      })
      .find((r) => r.selectorText === '.pd-dl-caption');
    return {
      bar: row?.querySelector('.pd-transfer-bar') !== null && row !== null,
      x: row?.querySelector('[data-testid="transfer-cancel"]') !== null && row !== null,
      pause: row?.querySelector('[data-testid="transfer-pause"]') !== null && row !== null,
      amount: row?.querySelector('[data-testid="transfer-amount"]')?.textContent ?? '',
      title: row?.querySelector('[data-testid="transfer-title"]')?.textContent ?? '',
      captionBelow: rule !== undefined && /top:\s*calc\(100%/.test(rule.style.cssText),
    };
  });
  log('tray row:', JSON.stringify(d));
  check(d.bar && d.x, 'the bar and its X are inside the tray');
  check(/Qwen3\.5 4B|qwen3\.5-4b-mtp/.test(d.title), `the model is named (${d.title})`);
  check(/^\d+(\.\d)? \/ \d+(\.\d)? GB$/.test(d.amount), `bytes, received / total (${d.amount})`);
  check(d.pause, 'Pause');
  check(d.captionBelow, 'elsewhere the hover caption sits BELOW the bar');
  await shot('04-tray-progress');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__llm_store().getState().settleDownload('qwen3.5-4b-mtp'));
  await win.waitForTimeout(300);
  check(
    (await win.locator('[data-testid="task-tray"]').count()) === 0,
    'nothing moving and no news → no button',
  );
} finally {
  await finish();
  try {
    execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}
