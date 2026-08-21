/**
 * THE LEFT SIDEBAR'S CLOSE, FRAME BY FRAME.
 *
 * the user: "left sidebar does not close cleanly, it's instant dissapear and then
 * slide left rather than the correct slide in like the canvas sidebar does."
 *
 * Two things are measured here, because the complaint is about the RELATIONSHIP
 * between them: the slot's animated width, and whether the panel's own content
 * is still on screen while that width animates. A close reads as "clean" when
 * the two move together — the content is still there, being clipped away. It
 * reads as "instant disappear then slide" when the content leaves at frame 0
 * and an empty gap finishes the animation on its own.
 *
 * The canvas rail is captured the same way in the same run, because it is the
 * reference the user named. Frames land as PNGs so the two can be compared by eye.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const outDir = process.env.OUT ?? '/tmp/sidebar-close';
const label = process.env.LABEL ?? 'before';

mkdirSync(outDir, { recursive: true });
if (!existsSync(path.join(appRoot, 'dist/index.html')))
  throw new Error('app is not built — run `pnpm build` first');

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});

/**
 * Sample the DOM every animation frame for `ms`, recording the geometry that
 * decides whether a close looks clean. Runs inside the page so the samples are
 * real frames, not screenshot cadence.
 */
async function sample(page, ms) {
  return page.evaluate(async (duration) => {
    const t0 = performance.now();
    const rows = [];
    return new Promise((resolve) => {
      const tick = () => {
        const slot = document.querySelector('.pd-sidebar-slot');
        const panel = document.querySelector('.pd-sidebar');
        const rail = document.querySelector('.pd-canvas-rail');
        const railInner = rail?.firstElementChild ?? null;
        rows.push({
          t: Math.round(performance.now() - t0),
          slotW: slot === null ? null : Math.round(slot.getBoundingClientRect().width),
          slotR: slot === null ? null : Math.round(slot.getBoundingClientRect().right),
          panel: panel === null ? null : Math.round(panel.getBoundingClientRect().width),
          panelL: panel === null ? null : Math.round(panel.getBoundingClientRect().left),
          panelR: panel === null ? null : Math.round(panel.getBoundingClientRect().right),
          panelOpacity: panel === null ? null : getComputedStyle(panel).opacity,
          railW: rail === null ? null : Math.round(rail.getBoundingClientRect().width),
          railInnerW: railInner === null ? null : Math.round(railInner.getBoundingClientRect().width),
        });
        if (performance.now() - t0 < duration) requestAnimationFrame(tick);
        else resolve(rows);
      };
      requestAnimationFrame(tick);
    });
  }, ms);
}

/**
 * A real filmstrip, via the CDP screencast.
 *
 * `page.screenshot()` is far too slow to film a 300ms transition — MEASURED, its
 * first frame already landed after the panel was gone, which is the same blind
 * spot that let the original bug ship. The screencast delivers COMPOSITOR frames
 * instead, so what lands on disk is what the user's eye gets.
 */
async function startFilm(app, page) {
  const cdp = await app.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push(f.data);
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
    } catch {
      /* the cast is already stopped */
    }
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return {
    async stop(name, keep) {
      try {
        await cdp.send('Page.stopScreencast');
      } catch {
        /* already stopped */
      }
      const step = Math.max(1, Math.floor(frames.length / keep));
      const files = [];
      for (let i = 0, n = 0; i < frames.length && n < keep; i += step, n++) {
        const file = path.join(outDir, `${label}-${name}-${String(n).padStart(2, '0')}.png`);
        writeFileSync(file, Buffer.from(frames[i], 'base64'));
        files.push(file);
      }
      console.log(`${name}: ${frames.length} compositor frames → ${files.length} saved`);
      frames.length = 0;
      return files;
    },
  };
}

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await page.waitForTimeout(1200);

  // ── the LEFT SIDEBAR close ────────────────────────────────────────────────
  const toggle = page.locator('[data-testid="collapse-sidebar"]').first();
  const toggleCount = await toggle.count();
  const openBefore = await page.evaluate(() =>
    document.querySelector('.pd-sidebar') === null ? 'absent' : 'present',
  );

  await page.screenshot({ path: path.join(outDir, `${label}-sidebar-00-open.png`) });

  // Start the sampler, then click — so frame 0 is the last OPEN frame.
  const film = await startFilm(app, page);
  const samplerP = sample(page, 600);
  await page.waitForTimeout(40);
  if (toggleCount > 0) await toggle.click();
  else throw new Error('no collapse-sidebar control found');
  const rows = await samplerP;
  await film.stop('sidebar', 8);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `${label}-sidebar-99-closed.png`) });

  // The panel must LEAVE once it has finished sliding — a hidden sidebar that
  // stays in the tree keeps its buttons in the tab order.
  const afterClose = await page.evaluate(() => ({
    panel: document.querySelector('.pd-sidebar') === null ? 'unmounted' : 'still mounted',
    slotW: Math.round(
      document.querySelector('.pd-sidebar-slot')?.getBoundingClientRect().width ?? -1,
    ),
  }));

  // ── the OPEN, which has to slide the same way in reverse ──────────────────
  const openFilm = await startFilm(app, page);
  const openSamplerP = sample(page, 600);
  await page.waitForTimeout(40);
  await page.locator('[data-testid="expand-sidebar"]').first().click();
  const openRows = await openSamplerP;
  await openFilm.stop('sidebar-open', 8);
  await page.waitForTimeout(500);

  // ── the CANVAS rail close, for comparison ─────────────────────────────────
  const canvasToggle = page.locator('[data-testid="canvas-toggle"]').first();
  let canvasRows = [];
  if ((await canvasToggle.count()) > 0) {
    await canvasToggle.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, `${label}-canvas-00-open.png`) });
    const closeBtn = page.locator('[aria-label="Close canvas panel"]').first();
    const canvasFilm = await startFilm(app, page);
    const canvasSamplerP = sample(page, 600);
    await page.waitForTimeout(40);
    if ((await closeBtn.count()) > 0) await closeBtn.click();
    else throw new Error('no canvas close control found');
    canvasRows = await canvasSamplerP;
    await canvasFilm.stop('canvas', 8);
  }

  const report = {
    label,
    toggleCount,
    openBefore,
    afterClose,
    sidebar: rows,
    sidebarOpen: openRows,
    canvas: canvasRows,
  };
  writeFileSync(path.join(outDir, `${label}-frames.json`), JSON.stringify(report, null, 2));

  const fmt = (r) =>
    r
      .filter((_, i) => i % 2 === 0)
      .map(
        (s) =>
          `${String(s.t).padStart(4)}ms slotW=${String(s.slotW).padStart(4)} slotRight=${String(s.slotR).padStart(4)} panelW=${String(s.panel).padStart(4)} panelLeft=${String(s.panelL).padStart(5)} panelRight=${String(s.panelR).padStart(4)} rail=${String(s.railW).padStart(4)} inner=${String(s.railInnerW).padStart(4)}`,
      )
      .join('\n');
  console.log(`--- ${label} SIDEBAR close ---\n${fmt(rows)}`);
  console.log(`--- ${label} SIDEBAR open ---\n${fmt(openRows)}`);
  console.log(`--- ${label} CANVAS close ---\n${fmt(canvasRows)}`);
  console.log(`after the close: sidebar ${afterClose.panel}, slot ${afterClose.slotW}px`);
  console.log(`frames in ${outDir}`);
} finally {
  await app.close();
}
