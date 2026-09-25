/**
 * OFFICE RENDER PROBE — the render path's files (WF-06) in the app's own canvas
 * editors: a report with citations and a Sources block, a deck with "Sources:"
 * lines and a sources slide, a workbook with a Sources sheet. No model.
 *
 * The files come from `office.py render` on tools/office-gen/tests/fixtures/
 * render — the same specs the pytest suite holds to the XML — and open in the
 * vendored GenOffice editors exactly as a file the model made would. Each view
 * is captured (the native editor laid over the DOM, as office-embed-probe
 * does). Which links the docs editor READS is tools/visual-eval/lib/
 * docx-viewers.mjs's job (GenOffice's own parser, no app needed).
 *
 * HEADLESS: launchApp's hidden window, never PI_E2E_HEADED. The flicker and
 * focus guards run as in every probe.
 *
 *   SHOT_DIR=/tmp/office-render node apps/desktop/tests/e2e/office-render-probe.mjs
 *
 * OFFICE_PY names a Python with the office libraries (default: the repo's
 * tools/office-gen/.venv, then the app's office venv in the real cache). The
 * vendored editors must be built (vendor/genoffice/embed/out and each app's
 * out/); without them the canvas falls back to its read-only preview, which
 * the probe reports.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { watchFlicker } from './flicker.mjs';
import { launchApp, probeHome, REAL_CACHE } from './harness.mjs';
import { compositePng, decodePng } from './png.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(here, '..', '..', '..', '..');
const OFFICE_GEN = path.join(REPO, 'tools', 'office-gen');
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/office-render';
mkdirSync(SHOT_DIR, { recursive: true });

const PY = [
  process.env.OFFICE_PY,
  path.join(OFFICE_GEN, '.venv', 'bin', 'python'),
  path.join(REAL_CACHE, 'engines', 'office-venv', 'bin', 'python'),
].find((p) => p && existsSync(p));
if (!PY) {
  console.error(
    'no Python with the office libraries (OFFICE_PY, tools/office-gen/.venv or the office venv)',
  );
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];
const note = (name, pass, detail = '') => {
  findings.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── the files, drawn by the render path ─────────────────────────────────────
const home = probeHome('office-render');
const dir = realpathSync(path.join(home));
const work = path.join(dir, 'Bobble', 'research');
mkdirSync(work, { recursive: true });
const files = {};
for (const [kind, name] of [
  ['docx', 'report'],
  ['pptx', 'deck'],
  ['xlsx', 'workbook'],
]) {
  const out = path.join(work, `${name}.${kind}`);
  const reply = execFileSync(
    PY,
    [
      path.join(OFFICE_GEN, 'office.py'),
      'render',
      kind,
      '--spec',
      path.join(OFFICE_GEN, 'tests', 'fixtures', 'render', `${name}.json`),
      '--out',
      out,
    ],
    { encoding: 'utf8', env: { ...process.env, PI_OFFICE_GEN_SCRATCH: path.join(dir, 'scratch') } },
  );
  const r = JSON.parse(reply.trim().split('\n').pop());
  note(
    `office.py render ${kind}`,
    r.ok === true && existsSync(out),
    r.error ?? `${r.sources} sources`,
  );
  files[kind] = out;
}

const { app, page, finish } = await launchApp('office-render', {
  env: { HOME: home },
  timeout: 120_000,
});

const png = (dataUrl) =>
  typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')
    ? Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
    : null;
/** A capture is not blank: enough distinct greys that something was drawn. */
const drawn = (buf) => {
  try {
    const img = decodePng(buf);
    const seen = new Set();
    const ch = img.data.length / (img.width * img.height);
    for (let i = 0; i < img.data.length; i += ch * 97) seen.add(img.data[i]);
    return seen.size > 8;
  } catch {
    return false;
  }
};
/** The DOM screenshot with the native editor's capture laid over its slot. */
const composite = async (tabId, label) => {
  const dom = await page.screenshot();
  const r = await page.evaluate(
    (id) => window.piDesktop.invoke('office:capture', { tabId: id }),
    tabId,
  );
  const view = png(r?.dataUrl);
  const geom = await page.evaluate(() => {
    const b = document.querySelector('.pd-office-slot')?.getBoundingClientRect();
    return b ? { x: b.x, y: b.y, w: b.width, h: b.height, dpr: window.devicePixelRatio } : null;
  });
  const file = path.join(SHOT_DIR, `${label}.png`);
  if (view === null || geom === null) {
    writeFileSync(file, dom);
    note(`${label}: the editor captured`, false, r?.error ?? 'no capture or no slot');
    return null;
  }
  const d = geom.dpr;
  writeFileSync(
    file,
    compositePng(dom, view, {
      x: geom.x * d,
      y: geom.y * d,
      width: geom.w * d,
      height: geom.h * d,
    }),
  );
  writeFileSync(path.join(SHOT_DIR, `${label}-editor.png`), view);
  note(`${label}: the editor drew something`, drawn(view), `${view.length} bytes`);
  return view;
};
const KIND = { pptx: 'slides', docx: 'docs', xlsx: 'sheets' };
const openOffice = async (file) => {
  const title = path.basename(file);
  const tabId = await page.evaluate(
    ({ filePath, title, key }) =>
      window.__pi_canvas().upsertTab(key, { kind: 'office', key, title, filePath }),
    { filePath: file, title, key: `file:${file}` },
  );
  await sleep(1000);
  await page.evaluate(
    ({ tabId, filePath, kind }) =>
      window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
    { tabId, filePath: file, kind: KIND[file.split('.').pop()] },
  );
  return tabId;
};
const view = (tabId, state) =>
  page.evaluate(
    ({ tabId, state }) => window.piDesktop.invoke('office:view-state', { tabId, state }),
    {
      tabId,
      state,
    },
  );

try {
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));
  const available = await page.evaluate(() => window.piDesktop.invoke('office:available', {}));
  note('office editors available', available?.available === true, JSON.stringify(available));
  const guard = await watchFlicker(page, { dir: SHOT_DIR, label: 'render' });

  // ── the report ────────────────────────────────────────────────────────────
  let first = true;
  const widen = async () => {
    if (!first) return;
    first = false;
    const handle = page.locator('[data-testid="canvas-rail-handle"]');
    for (let i = 0; i < 3; i++) {
      const box = await handle.boundingBox();
      if (!box) break;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 320, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await sleep(600);
    }
    await sleep(2000);
  };

  const doc = await openOffice(files.docx);
  await sleep(7000);
  await widen();
  await composite(doc, 'report-top');
  // The app is light: so is the editor's chrome — also after a trip to dark
  // and back with the document open. Its theme sheets used to pile up, and the
  // dark ones outranked the light: a light app's report wore a black status
  // bar (2026-09-25).
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('dark'));
  await sleep(1500);
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));
  await sleep(1500);
  const statusBg = await app.evaluate(async ({ webContents }) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!/\/apps\/docs\//.test(wc.getURL())) continue;
      const bg = await wc
        .executeJavaScript(
          "(() => { const b = document.querySelector('.status-bar'); return b ? getComputedStyle(b).backgroundColor : null; })()",
          true,
        )
        .catch(() => null);
      if (bg) return bg;
    }
    return null;
  });
  const lum = (() => {
    const m = /rgba?\(([^)]+)\)/.exec(statusBg ?? '');
    if (!m) return null;
    const [r, g, b] = m[1].split(',').map((v) => Number.parseFloat(v));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  })();
  note('a light app’s report has a light status bar', lum !== null && lum > 0.7, String(statusBg));
  // …and a dark app's has a dark one (the swap takes sheets out in both directions).
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('dark'));
  await sleep(1500);
  const darkBg = await app.evaluate(async ({ webContents }) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!/\/apps\/docs\//.test(wc.getURL())) continue;
      const bg = await wc
        .executeJavaScript(
          "(() => { const b = document.querySelector('.status-bar'); return b ? getComputedStyle(b).backgroundColor : null; })()",
          true,
        )
        .catch(() => null);
      if (bg) return bg;
    }
    return null;
  });
  const darkLum = (() => {
    const m = /rgba?\(([^)]+)\)/.exec(darkBg ?? '');
    if (!m) return null;
    const [r, g, b] = m[1].split(',').map((v) => Number.parseFloat(v));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  })();
  note(
    'a dark app’s report has a dark status bar',
    darkLum !== null && darkLum < 0.3,
    String(darkBg),
  );
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));
  await sleep(1500);
  for (const [label, top] of [
    ['report-middle', 900],
    ['report-sources', 99999],
  ]) {
    await view(doc, { scrollTop: top });
    await sleep(1800);
    await composite(doc, label);
  }
  await page.evaluate((id) => window.__pi_canvas().closeTab(id), doc);
  await sleep(800);

  // ── the deck ──────────────────────────────────────────────────────────────
  const deck = await openOffice(files.pptx);
  await sleep(6000);
  for (const n of [2, 3, 4, 6]) {
    await view(deck, { slide: n - 1 });
    await sleep(1600);
    await composite(deck, `deck-slide${n}`);
  }
  await page.evaluate((id) => window.__pi_canvas().closeTab(id), deck);
  await sleep(800);

  // ── the workbook ──────────────────────────────────────────────────────────
  const book = await openOffice(files.xlsx);
  await sleep(7000);
  for (const sheet of ['Findings', 'Data', 'Sources']) {
    await view(book, { sheet, row: 0, column: 0 });
    await sleep(1800);
    await composite(book, `workbook-${sheet.toLowerCase()}`);
  }
  await page.evaluate((id) => window.__pi_canvas().closeTab(id), book);
  await sleep(800);

  const flick = await guard.stop();
  note(
    'no flicker while the three files were open',
    flick.flickers.length === 0,
    `${flick.frames} frames`,
  );
} catch (err) {
  note('probe ran to the end', false, String(err?.message ?? err).split('\n')[0]);
}

writeFileSync(path.join(SHOT_DIR, 'findings.json'), `${JSON.stringify(findings, null, 1)}\n`);
const failed = findings.filter((f) => !f.pass);
log(`${findings.length - failed.length}/${findings.length} passed — shots in ${SHOT_DIR}`);
if (failed.length > 0) process.exitCode = 1;
await finish();
