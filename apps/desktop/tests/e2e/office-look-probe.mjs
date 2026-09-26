/**
 * THE MODEL'S LOOK AT AN OFFICE FILE — every slide, opened wide.
 *
 * `present` hands the model a picture of the document it made. It used to be a
 * photograph of the canvas editor at the pane's width (MEASURED: slide 1 of 8
 * at 29% zoom; a workbook's first three columns). This asks main for the look
 * office-look.ts takes on its own hidden editor, for each file given, and
 * saves it for looking at.
 *
 *   FILES=deck.pptx,budget.xlsx,report.docx OUT=/tmp/office-look \
 *     node apps/desktop/tests/e2e/office-look-probe.mjs
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const FILES = (process.env.FILES ?? '').split(',').filter(Boolean);
const OUT = process.env.OUT ?? '/tmp/office-look';
mkdirSync(OUT, { recursive: true });
if (FILES.length === 0) throw new Error('FILES=a.pptx,b.xlsx,… is required');

const home = probeHome('office-look');
const { app, page, check, finish } = await launchApp('office-look', {
  env: { HOME: home },
  timeout: 120_000,
});
// The app's own log beside the looks — office-look.ts says where it found each slide.
for (const s of [app.process().stderr, app.process().stdout]) {
  s?.on('data', (c) => appendFileSync(path.join(OUT, 'app.log'), c));
}
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  for (const file of FILES) {
    const t0 = Date.now();
    const look = await app.evaluate(async (_electron, p) => {
      const fn = /** @type {any} */ (globalThis).__pdOfficeLook;
      if (typeof fn !== 'function') return { error: 'no __pdOfficeLook hook' };
      const r = await fn(p);
      return r === null ? { error: 'null look' } : r;
    }, file);
    const ms = Date.now() - t0;
    const name = path.basename(file);
    if (look.error !== undefined) {
      check(false, `${name}: ${look.error}`);
      continue;
    }
    const png = Buffer.from(look.dataUrl.slice(look.dataUrl.indexOf(',') + 1), 'base64');
    const out = path.join(OUT, `${name}.png`);
    writeFileSync(out, png);
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    console.log(JSON.stringify({ file: name, ms, width: w, height: h, note: look.note, out }));
    check(w >= 900, `${name}: the look is only ${w}px wide`);
  }
} finally {
  await finish();
}
