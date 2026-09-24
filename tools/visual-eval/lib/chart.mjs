/**
 * Charts, the two ways a chat makes them, with no app and no model:
 *
 *  - a `chart …` COMMAND LINE run exactly as the app's bash-CLI mode runs it:
 *    bash splits the line (so quoting is real), the app escapes `$digit` in
 *    lines that call its own shims (tool-cli-bridge.ts protectShimDollars),
 *    the harness's buildCli/resolveCli map it onto the chart tool's schema,
 *    and the REGISTERED chart tool writes .svg + .chart.json + .chart.elements.json;
 *  - a saved `.chart.json` drawn again by today's renderer (packages/charts).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importTs } from './env.mjs';

const TOOLS = 'packages/harness/src/tools/';

/** Run `lines` in `outdir` (one shared folder, so a name reused is a file overwritten). */
export async function runChartLines(outdir, lines) {
  mkdirSync(outdir, { recursive: true });
  const { registerChartTool } = await importTs(`${TOOLS}chart-tool.ts`);
  const { buildCli, resolveCli } = await importTs(`${TOOLS}tool-cli.ts`);
  const { protectShimDollars } = await importTs(`${TOOLS}tool-cli-bridge.ts`);
  const tools = [];
  registerChartTool({ registerTool: (t) => tools.push(t) }, { bridge: null, root: () => outdir });
  const cli = buildCli(
    [{ name: 'chart', summary: 'charts', tools: ['chart', 'chart_edit'] }],
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  );
  const calls = [];
  for (const line of lines) {
    const argv = execFileSync('bash', [
      '-c',
      `f(){ printf '%s\\0' "$@"; }; f ${protectShimDollars(line, ['chart'])}`,
    ])
      .toString()
      .split('\0')
      .slice(0, -1);
    const r = resolveCli(cli, argv);
    if (r.kind !== 'call') {
      calls.push({ line, kind: r.kind, error: true, reply: r.text });
      continue;
    }
    const tool = tools.find((t) => t.name === r.tool);
    const res = await tool.execute('call', r.args, undefined, undefined, { cwd: outdir });
    const reply = res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    calls.push({ line, kind: 'call', args: r.args, error: res.isError === true, reply });
  }
  const svgs = readdirSync(outdir)
    .filter((f) => f.endsWith('.svg'))
    .sort()
    .map((f) => path.join(outdir, f));
  return { calls, svgs };
}

/** Draw saved `.chart.json` specs again with today's packages/charts. */
export async function renderChartSpecs(outdir, specFiles, readJson) {
  mkdirSync(outdir, { recursive: true });
  const charts = await importTs('packages/charts/src/index.ts');
  const out = [];
  for (const file of specFiles) {
    const name = path.basename(file).replace(/\.chart\.json$/, '');
    const dst = path.join(outdir, `${name}.svg`);
    try {
      const spec = charts.normalizeChartSpec(readJson(file));
      writeFileSync(dst, charts.chartToSvg(spec));
      out.push({ name, svg: dst, error: null });
    } catch (err) {
      out.push({ name, svg: null, error: String(err?.message ?? err) });
    }
  }
  return out;
}
