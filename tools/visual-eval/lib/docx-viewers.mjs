/**
 * A .docx as the app's two in-canvas viewers read it — for checking that a
 * rendered document's links survive the trip (WF-06), no model, headless.
 *
 *   node tools/visual-eval/lib/docx-viewers.mjs <file.docx> <out-dir>
 *
 * 1. mammoth, exactly as packages/canvas/src/surfaces/doc-surface.tsx calls it
 *    (the read-only preview, sanitized with DOMPurify as the surface does), to
 *    HTML and a full-page PNG in headless Chromium. Every page, where QuickLook
 *    draws only the first.
 * 2. GenOffice's docx parser (vendor/genoffice/packages/docx-engine — the
 *    editor behind a docx canvas tab), loaded from its TypeScript source: the
 *    runs it reads as links and the bookmarks it reads as anchors. It needs
 *    the vendored tree's own node_modules (jszip), which a fresh worktree
 *    does not have: VQ_GENOFFICE names a checkout that has run its install.
 *
 * Prints one JSON object: what each viewer found.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { importTs, launchChromium, REPO } from './env.mjs';

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('usage: docx-viewers.mjs <file.docx> <out-dir>');
  process.exit(64);
}
mkdirSync(outDir, { recursive: true });
const req = createRequire(path.join(REPO, 'packages', 'canvas', 'package.json'));
const mammoth = req('mammoth');
const bytes = readFileSync(file);

// ── 1. mammoth + DOMPurify, as the doc surface does ─────────────────────────
const converted = await mammoth.convertToHtml({ buffer: bytes });
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
const purifyPath = req.resolve('dompurify/dist/purify.min.js');
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ path: purifyPath });
const clean = await page.evaluate((html) => window.DOMPurify.sanitize(html), converted.value);
const styled = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 15px/1.5 -apple-system, Helvetica, sans-serif; margin: 32px 48px; color: #1c1c1c; background: #fff; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 8px; }
  a { color: #1f3a5f; } sup a { text-decoration: none; }
</style></head><body>${clean}</body></html>`;
writeFileSync(path.join(outDir, 'mammoth.html'), styled);
await page.setContent(styled);
const links = await page.evaluate(() =>
  [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent,
    target: a.getAttribute('href').startsWith('#')
      ? document.getElementById(a.getAttribute('href').slice(1)) !== null
      : null,
  })),
);
await page.screenshot({ path: path.join(outDir, 'mammoth.png'), fullPage: true });
await browser.close();

// ── 2. GenOffice's own parser ────────────────────────────────────────────────
let genoffice = null;
const { VQ_GENOFFICE } = process.env;
try {
  const root = VQ_GENOFFICE ?? path.join(REPO, 'vendor', 'genoffice');
  const engine = await importTs(path.join(root, 'packages', 'docx-engine', 'src', 'parse.ts'));
  const parse = engine.parseDocx ?? engine.parse ?? engine.default;
  if (typeof parse === 'function') {
    const doc = await parse(bytes);
    const runs = [];
    const bookmarks = [];
    const walk = (v) => {
      if (Array.isArray(v)) for (const x of v) walk(x);
      else if (v && typeof v === 'object') {
        if (typeof v.text === 'string' && v.link?.href)
          runs.push({ text: v.text, href: v.link.href });
        else if (typeof v.text === 'string' && typeof v.href === 'string')
          runs.push({ text: v.text, href: v.href });
        for (const k of ['bookmarks', 'hiddenBookmarks'])
          if (Array.isArray(v[k])) bookmarks.push(...v[k]);
        for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x);
      }
    };
    walk(doc);
    genoffice = { runs, bookmarks: [...new Set(bookmarks)] };
  } else {
    genoffice = { error: `no parse export (have: ${Object.keys(engine).join(', ')})` };
  }
} catch (err) {
  genoffice = { error: String(err?.message ?? err).split('\n')[0] };
}

console.log(
  JSON.stringify({
    mammoth: { links, messages: converted.messages.map((m) => m.message) },
    genoffice,
  }),
);
