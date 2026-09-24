/**
 * THE REAL CHART CALLS, REPLAYED — what each one wrote, and what it looks like
 * (VQ-02's before/after).
 *
 * "demo all your dataviz skills" (the user's session, 2026-09-17): the 4B made 17
 * `chart` calls through bash. Twelve had no title, and all twelve were written
 * to `bar-chart.svg`, one over the other; `--chart-type=line` was ignored; its
 * closing message claimed "10 different charts". This replays those 17 lines
 * EXACTLY — bash splits them, the app's `protectShimDollars` runs first, the
 * harness's own `buildCli`/`resolveCli` map them onto the registered `chart`
 * tool (this tree's SOURCE, bundled at the top of the run) — plus the
 * visual-quality brief's calls and the inputs that used to corrupt data
 * ("22M, 3,100", "$1.2M"). Then it renders every file that exists at the end
 * into a sheet, in an offscreen window of the hidden app, captioned with the
 * line that asked for it and the tool's reply.
 *
 *   SHOT_DIR=/tmp/chart-calls node tests/e2e/chart-calls-look.mjs
 *
 * Checks (they fail on the code before VQ-02, which is the point of a before
 * picture): the 17 calls leave 17 files; every requested type is honoured or
 * coerced with a note; the corrupting inputs parse.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, launchApp, REPO_ROOT } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'chart-calls');
mkdirSync(OUT, { recursive: true });

// ── the source under test, bundled (the harness imports its files as .js) ──
const esbuild = [
  path.join(APP_ROOT, 'node_modules/.bin/esbuild'),
  path.join(REPO_ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild'),
].find((p) => existsSync(p));
if (esbuild === undefined) throw new Error('esbuild not found (run pnpm install)');
const H = path.join(REPO_ROOT, 'packages/harness/src');
const entry = path.join(OUT, 'probe-entry.mjs');
writeFileSync(
  entry,
  [
    `export { registerChartTool } from ${JSON.stringify(path.join(H, 'tools/chart-tool.ts'))};`,
    `export { buildCli, resolveCli } from ${JSON.stringify(path.join(H, 'tools/tool-cli.ts'))};`,
    `export { protectShimDollars } from ${JSON.stringify(path.join(H, 'tools/tool-cli-bridge.ts'))};`,
    `export { CAPABILITIES } from ${JSON.stringify(path.join(H, 'presets/capabilities.ts'))};`,
  ].join('\n'),
);
const bundle = path.join(OUT, 'probe-bundle.mjs');
execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${bundle}`,
    '--external:@mariozechner/*',
    '--external:electron',
    '--log-level=error',
  ],
  { cwd: APP_ROOT },
);
const src = await import(pathToFileURL(bundle).href);

/** The 17 lines the 4B ran, verbatim (~/.pi/agent/sessions/…/2026-09-17T03-43-34-931Z_….jsonl). */
const REAL = [
  'chart "--labels=[\\"Q1\\",\\"Q2\\",\\"Q3\\",\\"Q4\\"]" "--values=[12500,28750,19600,31200]" --style=candy',
  'chart "--labels=[\\"2020\\",\\"2021\\",\\"2022\\",\\"2023\\",\\"2024\\"]" "--values=[45000,52000,48000,61000,73000]" --style=terminal',
  'chart "--labels=[\\"Engineering\\",\\"Design\\",\\"Product\\",\\"Marketing\\",\\"Sales\\"]" "--values=[35,28,22,15,20]" --style=ocean',
  'chart "--labels=[\\"Low (<50)\\",\\"Moderate (50-100)\\",\\"High (100-150)\\",\\"Very High (>150)\\"]" "--values=[28,35,22,15]" --style=forest',
  'chart "--labels=[\\"January\\",\\"February\\",\\"March\\",\\"April\\",\\"May\\",\\"June\\"]" "--values=[850,1200,1800,2100,2450,3200]" --style=sunset',
  'chart "--labels=[\\"2020\\",\\"2021\\",\\"2022\\",\\"2023\\",\\"2024\\"]" "--values=[100,150,120,180,200]" --style=terminal',
  'chart "--labels=[\\"X\\",\\"Y\\",\\"Z\\"]" "--values=[10,20,15]" --style=terminal',
  'chart "--labels=[\\"Series A\\",\\"Series B\\",\\"Series C\\"]" "--values=[100,80,60]" --style=terminal',
  'chart "--labels=[\\"Jan\\",\\"Feb\\",\\"Mar\\",\\"Apr\\",\\"May\\",\\"Jun\\"]" "--values=[100,150,120,180,200,160]" --style=terminal --chart-type=line',
  'chart "--labels=[\\"Jan\\",\\"Feb\\",\\"Mar\\",\\"Apr\\",\\"May\\",\\"Jun\\"]" "--values=[100,150,120,180,200,160]" --style=terminal --chart-type=area',
  'chart "--labels=[\\"Red\\",\\"Green\\",\\"Blue\\",\\"Yellow\\"]" "--values=[35,25,40,20]" --style=candy --chart-type=donut',
  'chart "--labels=[\\"X\\",\\"Y\\",\\"Z\\",\\"W\\"]" "--values=[10,20,15,25]" --style=terminal --chart-type=scatter',
  'chart --title "Revenue Growth Trend" --labels "2020,2021,2022,2023,2024" --values "45000,52000,48000,61000,73000" --unit "$" --look=sunset --type=line',
  'chart --title "Market Share Distribution" --labels "Company A,Company B,Company C,Company D" --values "35,25,20,20" --unit "%" --look=clean --type=donut',
  'chart --title "Features by Priority" --labels "Critical,High,Medium,Low" --values "4,8,12,6" --unit "features" --look=terminal --type=hbar',
  'chart --title "Product Mix" --labels "Electronics,Clothing,Home,Beauty" --values "30,25,20,25" --unit "%" --look=ocean --type=stacked',
  'chart --title "User Engagement Metrics" --labels "X,Y,Z,W" --values "10,20,15,25" --look=forest --type=scatter',
];
/** What each real call asked for, by its --chart-type / --type (bar when it named none). */
const REQUESTED = [
  'bar',
  'bar',
  'bar',
  'bar',
  'bar',
  'bar',
  'bar',
  'bar',
  'line',
  'area',
  'donut',
  'scatter',
  'line',
  'donut',
  'hbar',
  'stacked',
  'scatter',
];

/** The visual-quality brief (chart-set) and the inputs that corrupted data. */
const BRIEF = [
  'chart bar "MAU more than doubled in 2025" --labels "Q1, Q2, Q3, Q4" --values "48k, 61k, 79k, 102k" --subtitle "Monthly active users by quarter, 2025" --highlight Q4 --out brief/mau-2025.svg',
  'chart line "Revenue passed costs in 2022" --labels "2021, 2022, 2023, 2024, 2025" --values "Revenue: 1.2, 1.9, 2.8, 4.1, 5.6; Costs: 1.5, 1.8, 2.2, 2.9, 3.4" --unit "$M" --subtitle "Annual revenue and costs" --out brief/revenue-vs-costs.svg',
  'chart bar "Market and today" --labels "Market, Today" --values "22M, 3,100" --unit units --out brief/market.svg',
  'chart bar "Raised" --labels "Seed, Series A" --values "$1.2M, $2.4M" --out brief/raised.svg',
  'chart hbar "Tickets by team" --labels "Billing, Accounts, Shipping" --values "412, 288, 97" --out brief/tickets.svg',
];

const work = mkdtempSync(path.join(tmpdir(), 'chart-calls-'));
const tools = [];
src.registerChartTool({ registerTool: (t) => tools.push(t) }, { bridge: null, root: () => work });
const chartCap = src.CAPABILITIES.find((c) => c.name === 'chart');
const cli = src.buildCli(
  chartCap === undefined ? [] : [chartCap],
  tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
);

/** One line as the app runs it: dollars protected, bash splits, the CLI resolves, the tool runs. */
async function run(line) {
  const argv = execFileSync('bash', [
    '-c',
    `f(){ printf '%s\\0' "$@"; }; f ${src.protectShimDollars(line, ['chart'])}`,
  ])
    .toString()
    .split('\0')
    .slice(0, -1);
  const r = src.resolveCli(cli, argv);
  if (r.kind !== 'call') return { line, error: true, text: `[${r.kind}] ${r.text}`, args: null };
  const tool = tools.find((t) => t.name === r.tool);
  const res = await tool.execute('call', r.args, undefined, undefined, { cwd: work });
  return {
    line,
    args: r.args,
    error: res.isError === true,
    text: res.content.map((c) => c.text).join('\n'),
  };
}

const results = [];
for (const line of [...REAL, ...BRIEF]) results.push(await run(line));
writeFileSync(path.join(OUT, 'replies.json'), JSON.stringify(results, null, 1));

/** Every .svg the calls left behind (the sidecars name their charts). */
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.svg')) files.push(p);
  }
};
walk(work);
files.sort();
const realFiles = files.filter((f) => !f.includes(`${path.sep}brief${path.sep}`));
const wrote = (r) => /: ([^\s(]+\.svg) \(/.exec(r.text)?.[1] ?? null;
const specOf = (svg) => {
  try {
    return JSON.parse(readFileSync(svg.replace(/\.svg$/, '.chart.json'), 'utf8'));
  } catch {
    return null;
  }
};

const { app, check, finish, shotDir } = await launchApp('chart-calls', { waitFor: null });
try {
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`\n${realFiles.length} files from the 17 real calls:`);
  for (const f of realFiles) console.log(`  ${path.relative(work, f)}`);
  check(realFiles.length === 17, `the 17 real calls left ${realFiles.length} files, not 17`);
  REAL.forEach((_line, i) => {
    const r = results[i];
    const file = wrote(r);
    const spec = file === null ? null : specOf(path.join(work, file));
    const got = spec?.type ?? '(none)';
    const want = REQUESTED[i];
    // A scatter of named categories and a one-series stack are coerced — and say so.
    const coerced =
      (want === 'scatter' && got === 'bar') ||
      (want === 'stacked' && (got === 'donut' || got === 'bar'));
    const said = /\bdrawn as\b|\binstead\b/i.test(r.text);
    console.log(
      `#${String(i + 1).padStart(2)} asked ${want.padEnd(7)} got ${got.padEnd(7)} ${file ?? r.text.slice(0, 80)}`,
    );
    check(
      !r.error && (got === want || (coerced && said)),
      `call ${i + 1} asked for ${want} and got ${got}${coerced && !said ? ' without a note' : ''}`,
    );
  });
  const brief = results.slice(REAL.length);
  const market = specOf(path.join(work, 'brief/market.svg'));
  check(
    JSON.stringify(market?.series?.[0]?.points?.map((p) => p.value)) === '[22000000,3100]',
    `"22M, 3,100" parsed as ${JSON.stringify(market?.series?.[0]?.points?.map((p) => p.value))}`,
  );
  const raised = specOf(path.join(work, 'brief/raised.svg'));
  check(
    raised?.unit === '$' &&
      JSON.stringify(raised?.series?.[0]?.points?.map((p) => p.value)) === '[1200000,2400000]',
    `"$1.2M, $2.4M" → ${brief[3]?.text.split('\n')[0]}`,
  );

  // ── the sheet: every file that exists, captioned ──────────────────────────
  const cellFor = (file) => {
    const svg = readFileSync(file, 'utf8');
    const rel = path.relative(work, file);
    const asked = results.filter((r) => wrote(r) === rel).map((r) => r.line);
    const last = results.filter((r) => wrote(r) === rel).at(-1);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<figure><div class="svg">${svg}</div><figcaption><b>${esc(rel)}</b>${
      asked.length > 1
        ? ` <span class="warn">written ${asked.length}× — each call overwrote the last</span>`
        : ''
    }<code>${esc(asked.at(-1) ?? '')}</code><span class="reply">${esc((last?.text ?? '').split('\n').slice(0, 2).join(' '))}</span></figcaption></figure>`;
  };
  const errors = results
    .filter((r) => r.error)
    .map(
      (r) =>
        `<li><code>${r.line.replace(/</g, '&lt;')}</code><br>${r.text.split('\n')[0].replace(/</g, '&lt;')}</li>`,
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: #E9E9EC; font-family: -apple-system, sans-serif; }
    body { padding: 14px; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: repeat(4, 470px); gap: 12px; }
    figure { margin: 0; background: #fff; border-radius: 12px; padding: 10px; }
    .svg svg { width: 450px; height: auto; display: block; }
    figcaption { font-size: 11px; color: #333; margin-top: 6px; line-height: 1.35; }
    figcaption code { display: block; color: #555; font-size: 10px; word-break: break-all; margin-top: 3px; }
    .warn { color: #B3261E; font-weight: 700; }
    .reply { display: block; color: #1D5E3A; margin-top: 3px; }
    ul { font-size: 11px; background: #fff; border-radius: 12px; padding: 10px 26px; }
  </style></head><body><h1>${realFiles.length} files from the 17 real calls; ${files.length - realFiles.length} from the brief</h1>
  <div class="grid">${files.map(cellFor).join('')}</div>${errors !== '' ? `<h1>Refused</h1><ul>${errors}</ul>` : ''}</body></html>`;
  writeFileSync(path.join(OUT, 'sheet.html'), html);
  const rows = Math.ceil(files.length / 4);
  const width = 28 + 4 * 470 + 3 * 12;
  const height =
    60 + rows * 470 + (errors !== '' ? 60 + 60 * results.filter((r) => r.error).length : 0);
  const b64 = await app.evaluate(
    async ({ BrowserWindow }, [file, w, h]) => {
      const win = new BrowserWindow({
        width: w,
        height: h,
        show: false,
        frame: false,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
      });
      try {
        win.webContents.setZoomFactor(1);
        await win.loadFile(file);
        await new Promise((r) => setTimeout(r, 400));
        const image = await win.webContents.capturePage();
        const size = image.getSize();
        return (size.width > w ? image.resize({ width: w, quality: 'best' }) : image)
          .toPNG()
          .toString('base64');
      } finally {
        win.destroy();
      }
    },
    [path.join(OUT, 'sheet.html'), width, height],
  );
  writeFileSync(path.join(shotDir, 'sheet.png'), Buffer.from(b64, 'base64'));
  console.log(`sheet: ${path.join(shotDir, 'sheet.png')}`);
} finally {
  await finish();
}
