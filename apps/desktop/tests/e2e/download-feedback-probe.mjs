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
 * under the row, and the top-left downloads tray gets a "!" and lists it.
 * A running download (driven through the store's seam, no bytes move) shows
 * its bar, X and numbers inside the tray, hover caption below the bar, and
 * nothing in the input area.
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
    // …and in the tray: the icon is up, top-left, with a "!" (the news is a
    // failure, so the badge is red); opening it lists the refusal; Dismiss
    // clears it and the icon goes away again.
    const tray = await win.evaluate(() => {
      const b = document.querySelector('[data-testid="download-tray"]');
      const r = b?.getBoundingClientRect();
      const badge = document.querySelector('[data-testid="download-tray-badge"]');
      return {
        present: b !== null,
        left: r === undefined ? null : Math.round(r.left),
        unseen: b?.getAttribute('data-unseen'),
        badge: badge?.textContent ?? null,
        badgeKind: badge?.getAttribute('data-kind') ?? null,
        badgeColor: badge === null ? null : getComputedStyle(badge).backgroundColor,
        noFooterBar: document.querySelector('[data-testid="footer-download"]') === null,
      };
    });
    log('tray:', JSON.stringify(tray));
    check(
      tray.present && tray.left !== null && tray.left < 700,
      `the tray icon sits top-left (x=${tray.left})`,
    );
    check(
      tray.badge === '!' && tray.badgeKind === 'failed',
      `a tiny "!" on the icon (${tray.badge}, ${tray.badgeKind})`,
    );
    check(tray.noFooterBar, 'no progress bar in the input area');
    await shot('02-tray-badge');
    await win.click('[data-testid="download-tray"]');
    await win.waitForSelector('[data-testid="download-tray-panel"]', { timeout: 3000 });
    await win.waitForTimeout(300);
    const panel = await win.evaluate(() => ({
      text: document.querySelector('[data-testid="download-tray-panel"]')?.textContent ?? '',
      unseen: document.querySelector('[data-testid="download-tray"]')?.getAttribute('data-unseen'),
      badge: document.querySelector('[data-testid="download-tray-badge"]') !== null,
    }));
    check(
      /Not downloaded/.test(panel.text) && /Not enough space/.test(panel.text),
      'the tray lists the refusal with the sentence',
    );
    check(panel.unseen === 'no' && !panel.badge, 'opening the tray clears the "!"');
    await shot('03-tray-refusal');
    await win.click('[data-testid="download-tray-panel"] .pd-tray-notice-x');
    await win.waitForTimeout(300);
    check(
      (await win.locator('[data-testid="download-tray"]').count()) === 0,
      'dismissing the only notice takes the icon away',
    );
  }

  // 2. A running download: the icon with its moving dot; the tray shows the
  //    bar and its X, the file and its place in the job, bytes / speed, Pause.
  //    Driven through the store's seam, so no bytes move.
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
  await win.waitForSelector('[data-testid="download-tray"][data-active="1"]', { timeout: 3000 });
  await win.click('[data-testid="download-tray"]');
  await win.waitForSelector('[data-testid="download-tray-panel"]', { timeout: 3000 });
  await win.waitForTimeout(300);
  const d = await win.evaluate(() => {
    const panel = document.querySelector('[data-testid="download-tray-panel"]');
    const bar = panel?.querySelector('[data-testid="tray-download-llm:qwen3.5-4b-mtp"]');
    const x = panel?.querySelector('[data-testid="tray-download-llm:qwen3.5-4b-mtp-cancel"]');
    // The tray writes the numbers beside the bar, so it carries no hover
    // caption; the hub's bars keep theirs, below the bar now.
    const cap = panel?.querySelector('[data-testid="tray-download-llm:qwen3.5-4b-mtp-caption"]');
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
      text: panel?.textContent ?? '',
      bar: bar !== null && bar !== undefined,
      x: x !== null && x !== undefined,
      captionBelow:
        cap === null && rule !== undefined && /top:\s*calc\(100%/.test(rule.style.cssText),
      buttons: [...(panel?.querySelectorAll('button') ?? [])]
        .map((b) => b.textContent?.trim())
        .filter(Boolean),
    };
  });
  log('tray panel:', JSON.stringify(d));
  check(d.bar && d.x, 'the bar and its X are inside the tray');
  check(
    /Qwen3\.5-4B-Q8_0\.gguf/.test(d.text) && /1 of 3/.test(d.text),
    'the file and its place in the job',
  );
  check(
    /GB \/ .*GB/.test(d.text) && /20%/.test(d.text),
    `bytes and percent (${d.text.slice(0, 90)})`,
  );
  check(d.buttons.includes('Pause'), `Pause (${d.buttons})`);
  check(
    d.captionBelow,
    'no caption in the tray (the numbers are written); elsewhere the hover caption sits BELOW the bar',
  );
  await win.hover('[data-testid="tray-download-llm:qwen3.5-4b-mtp"]');
  await win.waitForTimeout(250);
  await shot('04-tray-progress');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__llm_store().getState().settleDownload('qwen3.5-4b-mtp'));
  await win.waitForTimeout(300);
  check(
    (await win.locator('[data-testid="download-tray"]').count()) === 0,
    'nothing moving and no news → no icon',
  );
} finally {
  await finish();
  try {
    execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}
