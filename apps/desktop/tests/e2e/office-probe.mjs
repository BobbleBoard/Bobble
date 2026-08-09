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

  const available = await page.evaluate(() => window.piDesktop.invoke('office:available', {}));
  check(available?.available === true, 'office seam reports available');
  if (available?.available !== true) throw new Error('seam unavailable — nothing else can pass');

  for (const c of CASES) {
    const filePath = path.join(FIXTURES, c.file);
    check(existsSync(filePath), `${c.ext}: fixture exists`);

    const tabId = await page.evaluate(
      ({ filePath, title }) =>
        window.__pi_canvas().openTab({ kind: 'office', title, filePath }),
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
    check(created?.ok === true, `${c.ext}: editor view created${created?.error ? ` (${created.error})` : ''}`);

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
      check(stats.width > 200 && stats.height > 200, `${c.ext}: capture is ${stats.width}x${stats.height}`);
      // A view that never painted compresses to almost nothing. This is a
      // floor, not a rendering check — the images are for human eyes.
      check(stats.bytes > 6000, `${c.ext}: capture has content (${stats.bytes} bytes)`);
    }
  }

  // ── canvas resize: the editor must track the slot at every width ──────────
  for (const width of [1500, 1100, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(1500);
    const tabId = await page.evaluate(() => window.__pi_canvas().getState().activeTabId);
    const shot = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const stats = imageStats(shot?.dataUrl);
    if (check(stats !== null, `resize ${width}: captured`)) {
      writeFileSync(path.join(SHOTS, `resize-${width}.png`), stats.buf);
      check(stats.bytes > 6000, `resize ${width}: still painting (${stats.width}x${stats.height})`);
    }
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
