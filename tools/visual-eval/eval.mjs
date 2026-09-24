#!/usr/bin/env node
/**
 * THE VISUAL-QUALITY EVAL — one command, no model, headless (VQ-00).
 *
 *   node tools/visual-eval/eval.mjs [--out DIR] [--only a,b] [--python PY] [--mermaid mermaid.min.js]
 *   pnpm vq:eval
 *
 * Renders every research prompt and variant plus the REAL 4B captures (see
 * cases.mjs), writes contact sheets, and measures every artifact into
 * `report.json`: slides/pages, text set small, text overlaps, text off the
 * canvas, empty regions, dropped items, font families, contrast and palette.
 *
 * `report.json` is DETERMINISTIC — run it twice and diff: no timings, no
 * absolute paths, nothing random. What is not deterministic (timings, which
 * app was in front, tool versions) goes in `run.json`.
 *
 * Headless end to end: QuickLook's `qlmanage -t` and a headless Chromium draw
 * everything, and the frontmost app is read before, between phases and after —
 * the run fails if anything it started ever took the screen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CASES } from './cases.mjs';
import { svgToPng } from './lib/browser-renders.mjs';
import {
  EVAL_ROOT,
  focusComplaint,
  frontmost,
  lastJson,
  launchChromium,
  OFFICE_GEN,
  PY_DIR,
  REPO,
  resolvePython,
  run,
} from './lib/env.mjs';

const t0 = Date.now();
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const OUT = path.resolve(opt('out', path.join(EVAL_ROOT, 'out')));
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const { VQ_MERMAID } = process.env;
const MERMAID = opt('mermaid', VQ_MERMAID ?? '') || null;
const python = resolvePython(opt('python', null));

for (const d of ['files', 'renders', 'sheets', 'work'])
  rmSync(path.join(OUT, d), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const rel = (p) => (p ? path.relative(OUT, p) : null);
const slug = (id) => id.replaceAll('/', path.sep);
const dirOf = (root) => (id) => {
  const d = path.join(OUT, root, slug(id));
  mkdirSync(d, { recursive: true });
  return d;
};
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

const timings = {};
const focus = { before: frontmost(), checks: [] };
const guard = (phase) => {
  const now = frontmost();
  const complaint = focusComplaint(focus.before, now);
  focus.checks.push({ phase, app: now, complaint });
  if (complaint) console.error(`FOCUS: ${complaint} (after ${phase})`);
};

let browser = null;
const ctx = {
  python,
  mermaid: MERMAID && existsSync(MERMAID) ? path.resolve(MERMAID) : null,
  files: dirOf('files'),
  renders: dirOf('renders'),
  work: dirOf('work'),
  readJson,
  browser: async () => {
    browser ??= await launchChromium();
    return browser;
  },
  py: (script, argv) => run(python, [path.join(PY_DIR, script), ...argv], { cwd: REPO }),
  /** office.py against the replay stub; scratch = this case's work dir. */
  officeMake: (id, repliesFile, argv) => {
    const r = spawnSync(
      python,
      [path.join(PY_DIR, 'office_replay.py'), repliesFile, ctx.work(id), ...argv],
      {
        encoding: 'utf8',
        cwd: ctx.work(id),
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const j = lastJson(r.stdout ?? '');
    if (j === null)
      return { ok: false, error: (r.stderr ?? '').trim().split('\n').slice(-3).join(' ') };
    return j;
  },
  /** office.py with no model in the loop (inspect / apply). */
  office: (argv) => {
    const r = spawnSync(python, [path.join(OFFICE_GEN, 'office.py'), ...argv], {
      encoding: 'utf8',
    });
    return lastJson(r.stdout ?? '') ?? { ok: false, error: r.stderr };
  },
};

// ── 1. produce ──────────────────────────────────────────────────────────────
const artifacts = [];
const cases = CASES.filter((c) => ONLY.length === 0 || ONLY.some((o) => c.id.includes(o)));
for (const c of cases) {
  const s = Date.now();
  try {
    const arts = await c.run(ctx, c.id);
    for (const a of arts) artifacts.push({ case: c.id, what: c.what, ...a });
  } catch (err) {
    artifacts.push({
      case: c.id,
      what: c.what,
      id: c.id,
      kind: 'check',
      error: String(err?.message ?? err).split('\n')[0],
    });
  }
  timings[c.id] = Date.now() - s;
}
guard('produce');

// ── 2. render ───────────────────────────────────────────────────────────────
let s = Date.now();
const ql = artifacts.filter((a) => a.file && ['pptx', 'docx', 'pdf'].includes(a.kind));
if (ql.length > 0) {
  const manifest = path.join(OUT, 'work', 'quicklook.json');
  writeFileSync(
    manifest,
    JSON.stringify(
      ql.map((a) => ({ src: a.file, out_dir: ctx.renders(a.id), prefix: path.basename(a.id) })),
    ),
  );
  const pngs = JSON.parse(ctx.py('quicklook.py', [manifest]));
  ql.forEach((a, i) => {
    a.pngs = pngs[i];
  });
}
for (const a of artifacts.filter((x) => x.kind === 'svg' && x.file && !x.pngs)) {
  a.pngs = [await svgToPng(await ctx.browser(), a.file, path.join(ctx.renders(a.id), 'chart.png'))];
}
if (browser) await browser.close();
timings.render = Date.now() - s;
guard('render');

// ── 3. measure ──────────────────────────────────────────────────────────────
s = Date.now();
const measurable = artifacts.filter(
  (a) => a.file && ['pptx', 'docx', 'pdf', 'svg'].includes(a.kind),
);
if (measurable.length > 0) {
  const manifest = path.join(OUT, 'work', 'measure.json');
  writeFileSync(
    manifest,
    JSON.stringify(measurable.map((a) => ({ kind: a.kind, file: a.file, spec: a.spec ?? null }))),
  );
  const res = JSON.parse(ctx.py('measure.py', ['batch', manifest]));
  measurable.forEach((a, i) => {
    a.metrics = res[i];
  });
}
timings.measure = Date.now() - s;

// ── 4. sheets ───────────────────────────────────────────────────────────────
s = Date.now();
const byCase = new Map();
for (const a of artifacts) {
  if (!a.pngs?.length) continue;
  if (!byCase.has(a.case)) byCase.set(a.case, []);
  byCase.get(a.case).push(...a.pngs);
}
const sheetJobs = [...byCase.entries()].map(([id, pngs]) => ({
  id,
  pngs,
  out: path.join(OUT, 'sheets', `${id.replaceAll('/', '--')}.png`),
  title: id,
  cols: id.startsWith('landing-page')
    ? 2
    : id.startsWith('one-page-report')
      ? 3
      : pngs.length >= 7
        ? 4
        : 3,
  tile_w: id.startsWith('landing-page') ? 720 : 640,
}));
const sheetRes = sheetJobs.length
  ? JSON.parse(
      ctx.py('sheets.py', ['batch', writeJson(path.join(OUT, 'work', 'sheets.json'), sheetJobs)]),
    )
  : [];
const sheets = {};
sheetJobs.forEach((j, i) => {
  sheets[j.id] = { file: rel(j.out), nonblank: sheetRes[i].bytes_ok && sheetRes[i].variance_ok };
});
timings.sheets = Date.now() - s;
guard('sheets');

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

// ── 5. report ───────────────────────────────────────────────────────────────
const OFFICE_KEEP = ['ok', 'error', 'kind', 'items', 'theme', 'chart', 'warnings', 'summary'];
const entries = artifacts.map((a) => {
  const e = {
    id: a.id,
    case: a.case,
    what: a.what,
    kind: a.kind,
    file: rel(a.file),
    renders: (a.pngs ?? []).length,
  };
  if (a.office)
    e.office = Object.fromEntries(
      OFFICE_KEEP.filter((k) => k in a.office).map((k) => [k, a.office[k]]),
    );
  if (a.metrics) e.metrics = a.metrics;
  if (a.checks) e.checks = a.checks;
  if (a.error) e.error = a.error;
  if (a.skipped) e.skipped = a.skipped;
  return e;
});
const sum = (f) => entries.reduce((n, e) => n + (f(e) ?? 0), 0);
const focusOk = focus.checks.every((c) => c.complaint === null);
const report = {
  schema: 1,
  artifacts: entries,
  sheets,
  totals: {
    artifacts: entries.length,
    errors: entries.filter((e) => e.error || e.metrics?.error || e.office?.ok === false).length,
    overlaps: sum((e) => e.metrics?.overlaps?.length),
    offcanvas: sum((e) => e.metrics?.offcanvas?.length),
    empty_regions: sum((e) => e.metrics?.empty_regions?.length),
    dropped: sum((e) => e.metrics?.dropped?.length),
    contrast_fails: sum((e) => e.metrics?.palette?.contrast_fails?.length),
    palette_fails: entries.filter(
      (e) => e.metrics?.palette?.categorical && !e.metrics.palette.categorical.ok,
    ).length,
    office_warnings: sum((e) => e.office?.warnings?.length),
    sheets_blank: Object.values(sheets).filter((x) => !x.nonblank).length,
  },
  focus_ok: focusOk,
};
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(stable(report), null, 1)}\n`);
timings.total = Date.now() - t0;
writeFileSync(
  path.join(OUT, 'run.json'),
  `${JSON.stringify({ python, mermaid: ctx.mermaid, out: OUT, timings_ms: timings, focus }, null, 1)}\n`,
);

// ── console summary ─────────────────────────────────────────────────────────
const pad = (s0, n) => String(s0).padEnd(n);
console.log(`\n${pad('artifact', 44)} ${pad('kind', 6)} small%  overlap empty dropped contrast`);
for (const e of entries) {
  const m = e.metrics ?? {};
  if (e.kind === 'check' || e.kind === 'motion') {
    const note = e.error ?? e.skipped ?? JSON.stringify(e.checks ?? m).slice(0, 70);
    console.log(`${pad(e.id, 44)} ${pad(e.kind, 6)} ${note}`);
    continue;
  }
  console.log(
    `${pad(e.id, 44)} ${pad(e.kind, 6)} ${pad(m.text?.small_pct ?? '-', 7)} ${pad(m.overlaps?.length ?? '-', 7)} ${pad(m.empty_regions?.length ?? '-', 5)} ${pad(m.dropped?.length ?? '-', 7)} ${m.palette?.contrast_fails?.length ?? '-'}${e.error || m.error ? `  ERROR ${e.error ?? m.error}` : ''}`,
  );
}
console.log(`\ntotals ${JSON.stringify(report.totals)}`);
console.log(
  `report: ${path.join(OUT, 'report.json')}  sheets: ${path.join(OUT, 'sheets')}  (${(timings.total / 1000).toFixed(1)} s)`,
);
if (!focusOk) {
  console.error('the eval moved focus — see run.json');
  process.exitCode = 1;
}
if (report.totals.errors > 0 || report.totals.sheets_blank > 0) process.exitCode = 1;
