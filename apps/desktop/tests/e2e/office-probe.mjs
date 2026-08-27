/**
 * Office E2E: opens a .docx, .xlsx, .pptx and .pdf as LIVE canvas tabs backed by
 * the vendored GenOffice editors, captures each one, and re-captures at three
 * canvas widths.
 *
 * Why capture through `office:capture` rather than a Playwright screenshot: the
 * editor is a native WebContentsView that paints ABOVE the DOM, so a page
 * screenshot shows the slot's background and nothing else. `office:capture`
 * calls capturePage() on the view itself, which also works while the window is
 * occluded or on another Space.
 *
 * Every assertion is backed by pixels: a view that was created but never painted
 * returns a uniform image, and "created" is not the same as "rendered" — that
 * distinction is the whole point of this probe.
 *
 *   node tests/e2e/office-probe.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const fixtureChat = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');
const FIXTURES = path.join(homedir(), 'bobble-testbed/office-fixtures');
const SHOTS = path.join(homedir(), 'bobble-testbed/office-shots');

const CASES = [
  { ext: 'docx', file: 'test.docx', kind: 'docs' },
  { ext: 'xlsx', file: 'test.xlsx', kind: 'sheets' },
  { ext: 'pptx', file: 'test.pptx', kind: 'slides' },
  { ext: 'pdf', file: 'test.pdf', kind: 'pdf' },
];

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  return ok;
}

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('office-probe: app is not built — run `npm run build` in apps/desktop');
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

/** Decode a data URL and report size + how many distinct colours it contains. */
function imageStats(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
  const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  // PNG IHDR: width/height are big-endian uint32 at byte 16 and 20.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { bytes: buf.length, width, height, buf };
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-office-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixtureChat,
    PI_E2E: '1',
    // No inference supervisor: this probe is about document rendering, and a
    // 6.5GB model server per run is how earlier probes leaked memory.
    PI_E2E_NO_SERVER: '1',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 15000 });

  // Let the window's compositor come up before creating any native view. A view
  // attached while the host window is still initialising gets no display
  // surface, and capturePage() then returns an empty image forever — visible,
  // correctly bounded, and blank.
  await page.waitForTimeout(4000);

  // Dark FIRST, so every per-format capture below is dark-mode evidence rather
  // than a light screenshot with a separate theme check bolted on the end.
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('dark'));
  await page.waitForTimeout(1500);

  const available = await page.evaluate(() => window.piDesktop.invoke('office:available', {}));
  check(available?.available === true, 'office seam reports available');
  if (available?.available !== true) throw new Error('seam unavailable — nothing else can pass');

  for (const c of CASES) {
    const filePath = path.join(FIXTURES, c.file);
    check(existsSync(filePath), `${c.ext}: fixture exists`);

    const tabId = await page.evaluate(
      ({ filePath, title }) => window.__pi_canvas().openTab({ kind: 'office', title, filePath }),
      { filePath, title: c.file },
    );
    check(typeof tabId === 'string' && tabId.length > 0, `${c.ext}: canvas tab opened`);

    // The surface must mount and report a rect before main can size the view.
    await page.waitForTimeout(1200);

    const created = await page.evaluate(
      ({ tabId, kind, filePath }) =>
        window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
      { tabId, kind: c.kind, filePath },
    );
    check(
      created?.ok === true,
      `${c.ext}: editor view created${created?.error ? ` (${created.error})` : ''}`,
    );

    // Editors mount asynchronously — Univer especially. Poll rather than guess
    // a single timeout: a fixed wait either fails a slow editor or slows every
    // fast one, and neither tells you WHICH you are looking at.
    const started = Date.now();
    let stats = null;
    let lastErr = null;
    while (Date.now() - started < 25000) {
      await page.waitForTimeout(1500);
      const shot = await page.evaluate(
        ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
        { tabId },
      );
      stats = imageStats(shot?.dataUrl);
      if (stats !== null && stats.bytes > 6000) break;
      lastErr = shot?.error ?? null;
    }
    if (stats === null) console.log(`      ${c.ext}: capture error -> ${lastErr}`);
    const diag = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    console.log(
      `      ${c.ext}: ${Date.now() - started}ms  window=${win.w}x${win.h}  state=${diag?.error ?? 'painted ok'}`,
    );
    if (check(stats !== null, `${c.ext}: captured a PNG from the native view`)) {
      writeFileSync(path.join(SHOTS, `${c.ext}.png`), stats.buf);
      check(
        stats.width > 200 && stats.height > 200,
        `${c.ext}: capture is ${stats.width}x${stats.height}`,
      );
      // A view that never painted compresses to almost nothing. This is a
      // floor, not a rendering check — the images are for human eyes.
      check(stats.bytes > 6000, `${c.ext}: capture has content (${stats.bytes} bytes)`);
    }
  }

  // ── theming: the editor must look like part of the app, not an embed ─────
  const themeShots = {};
  for (const themeMode of ['dark', 'light']) {
    const applied = await page.evaluate((m) => {
      const st = window.__pi_theme?.();
      if (!st?.setMode) return null;
      st.setMode(m);
      return window.__pi_theme().mode;
    }, themeMode);
    check(applied === themeMode, `theme ${themeMode}: app switched (got ${applied})`);
    await page.waitForTimeout(3000);
    const tabId = await page.evaluate(() => window.__pi_canvas().getState().activeTabId);
    const shot = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const stats = imageStats(shot?.dataUrl);
    if (check(stats !== null, `theme ${themeMode}: captured`)) {
      writeFileSync(path.join(SHOTS, `theme-${themeMode}.png`), stats.buf);
      themeShots[themeMode] = stats.buf;
    }
  }
  // The whole point. Capturing twice proves nothing if the editor ignored the
  // theme both times — which is exactly how this passed before insertCSS was
  // found to be losing the cascade to their author styles.
  if (themeShots.dark && themeShots.light) {
    check(!themeShots.dark.equals(themeShots.light), 'theme: the editor re-themed with the app');
  }

  // ── toolbar starts collapsed, and the button reveals it ──────────────────
  {
    const tabId = await page.evaluate(() => window.__pi_canvas().getState().activeTabId);
    const collapsed = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const a = imageStats(collapsed?.dataUrl);
    if (check(a !== null, 'toolbar: captured collapsed')) {
      writeFileSync(path.join(SHOTS, 'toolbar-collapsed.png'), a.buf);
    }
    // The button is at top-left, roughly 8,6 + half its size in CSS px.
    await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:click', { tabId, x: 45, y: 16 }),
      { tabId },
    );
    await page.waitForTimeout(1500);
    const shown = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const b = imageStats(shown?.dataUrl);
    if (check(b !== null, 'toolbar: captured after clicking Show toolbar')) {
      writeFileSync(path.join(SHOTS, 'toolbar-shown.png'), b.buf);
      check(!a.buf.equals(b.buf), 'toolbar: the button revealed the ribbon');
    }
  }

  // ── click around inside the editor (native view, so DOM tooling cannot) ──
  const activeId = await page.evaluate(() => window.__pi_canvas().getState().activeTabId);
  const before = await page.evaluate(
    ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
    { tabId: activeId },
  );
  // Ribbon tabs sit along the top strip; these land on different ones.
  for (const [x, y] of [
    [200, 60],
    [120, 300],
    [260, 300],
  ]) {
    await page.evaluate(
      ({ tabId, x, y }) => window.piDesktop.invoke('office:click', { tabId, x, y }),
      { tabId: activeId, x, y },
    );
    await page.waitForTimeout(700);
  }
  const after = await page.evaluate(
    ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
    { tabId: activeId },
  );
  const a = imageStats(before?.dataUrl);
  const b = imageStats(after?.dataUrl);
  if (check(a !== null && b !== null, 'click: captured before and after')) {
    writeFileSync(path.join(SHOTS, 'click-before.png'), a.buf);
    writeFileSync(path.join(SHOTS, 'click-after.png'), b.buf);
    // If clicking the ribbon changed nothing, the view is not receiving input —
    // which a screenshot alone would never reveal.
    check(!a.buf.equals(b.buf), 'click: the editor reacted to the clicks');
  }

  // ── canvas resize: DRAG THE RAIL HANDLE, not the window ──────────────────
  // The first version of this resized the window and passed while measuring
  // nothing: all three captures came back byte-identical because the canvas
  // panel has its own width and does not track the window. Asserting the
  // captures DIFFER is what makes this a test.
  const handle = page.locator('[data-testid="canvas-rail-handle"]');
  check((await handle.count()) > 0, 'resize: rail handle present');
  const sizes = [];
  {
    for (const [label, dx] of [
      ['wider', -260],
      ['widest', -300],
      ['narrow', 380],
    ]) {
      // Re-read the handle every time: it MOVES with the panel edge, so a box
      // captured once sends every drag after the first to empty space — which
      // is exactly how this passed while resizing nothing.
      const box = await handle.boundingBox();
      if (!box) break;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1200);

      const panelWidth = await page.evaluate(
        () =>
          document.querySelector('[data-testid="canvas-tabs-panel"]')?.getBoundingClientRect()
            .width ?? 0,
      );
      const tabId = await page.evaluate(() => window.__pi_canvas().getState().activeTabId);
      const shot = await page.evaluate(
        ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
        { tabId },
      );
      const stats = imageStats(shot?.dataUrl);
      if (check(stats !== null, `resize ${label}: captured`)) {
        writeFileSync(path.join(SHOTS, `resize-${label}.png`), stats.buf);
        sizes.push({ label, panelWidth: Math.round(panelWidth), capture: stats.width });
        console.log(
          `      resize ${label}: panel=${Math.round(panelWidth)}px capture=${stats.width}x${stats.height}`,
        );
      }
    }
    const widths = new Set(sizes.map((s) => s.capture));
    check(widths.size > 1, `resize: the editor followed the canvas (${[...widths].join(', ')})`);
  }
} catch (err) {
  failures.push(`threw: ${err?.message ?? err}`);
  console.error(err);
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\nshots -> ${SHOTS}`);
if (failures.length) {
  console.error(`\noffice-probe FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\noffice-probe: all checks passed');
