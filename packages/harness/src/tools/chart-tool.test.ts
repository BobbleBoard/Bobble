import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import {
  CHART_SIDECAR_SUFFIX,
  CHART_TOOL,
  chartInputFromParams,
  chartSlug,
  describeData,
  registerChartTool,
} from './chart-tool.js';
import { buildCli, commandNameFor, pathFor, resolveCli } from './tool-cli.js';

/** A pi that only records what was registered. */
function collect() {
  const tools: Array<Record<string, unknown>> = [];
  return { pi: { registerTool: (d: never) => tools.push(d) } as never, tools };
}

type Exec = (
  id: string,
  p: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: { cwd?: string },
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

const root = mkdtempSync(path.join(tmpdir(), 'chart-tool-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the chart command, as a person types it', () => {
  const { pi, tools } = collect();
  registerChartTool(pi, { bridge: null, root: () => root });
  const cliTools = tools.map((t) => ({
    name: t.name as string,
    description: t.description as string,
    parameters: t.parameters as never,
  }));
  const spec = CAPABILITIES.find((c) => c.name === 'chart');
  const cli = buildCli(spec === undefined ? [] : [spec], cliTools);

  it('is the one tool of the chart capability, reached as `chart` with no sub-word', () => {
    expect(tools.map((t) => t.name)).toEqual([CHART_TOOL]);
    expect(spec?.tools).toEqual([CHART_TOOL]);
    expect(commandNameFor('chart')).toBe('chart');
    expect(pathFor('chart', CHART_TOOL)).toEqual([]);
  });

  it('`chart bar "Units Sold by Year" --labels … --values …` fills type, title and the data', () => {
    const r = resolveCli(cli, [
      'chart',
      'bar',
      'Units Sold by Year',
      '--labels',
      '2021, 2022, 2023, 2024',
      '--values',
      '12, 19, 15, 22',
    ]);
    expect(r.kind).toBe('call');
    if (r.kind !== 'call') return;
    expect(r.tool).toBe(CHART_TOOL);
    expect(r.args).toMatchObject({
      type: 'bar',
      title: 'Units Sold by Year',
      labels: '2021, 2022, 2023, 2024',
      values: '12, 19, 15, 22',
    });
  });

  it('a line without the type still reaches the tool (the type is worked out there)', () => {
    const r = resolveCli(cli, [
      'chart',
      '--title',
      'Share',
      '--labels',
      'A, B',
      '--values',
      '1, 2',
    ]);
    expect(r.kind).toBe('call');
  });
});

describe('chart — an untitled chart is a chart', () => {
  it('a line without a title reaches the tool', () => {
    /* MEASURED: a 4B's first call was `chart "--labels=[…]" "--values=[…]"`
       and "missing --title" cost it a second call for a chart it could have had. */
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const cliTools = tools.map((t) => ({
      name: t.name as string,
      description: t.description as string,
      parameters: t.parameters as never,
    }));
    const spec = CAPABILITIES.find((c) => c.name === 'chart');
    const cli = buildCli(spec === undefined ? [] : [spec], cliTools);
    const r = resolveCli(cli, ['chart', '--labels=["2021","2022"]', '--values=[12,19]']);
    expect(r.kind).toBe('call');
    if (r.kind !== 'call') return;
    expect(r.args).toMatchObject({ labels: '["2021","2022"]', values: '[12,19]' });
  });
});

describe('chartInputFromParams — forgiving where a small model is loose', () => {
  it('swaps a title typed in the type slot', () => {
    const input = chartInputFromParams({ type: 'Units Sold by Year', title: 'bar' });
    expect(input).toMatchObject({ type: 'bar', title: 'Units Sold by Year' });
    const alone = chartInputFromParams({ type: 'Units Sold by Year' });
    expect(alone).toMatchObject({ title: 'Units Sold by Year' });
    expect(alone.type).toBeUndefined();
  });

  it('reads a JSON list typed as a string, and several named series', () => {
    expect(chartInputFromParams({ labels: '["a","b"]', values: '[1, 2]' })).toMatchObject({
      labels: ['a', 'b'],
      values: [1, 2],
    });
    expect(chartInputFromParams({ values: 'Revenue: 4, 5; Cost: 3, 3' }).values).toEqual([
      'Revenue: 4, 5',
      'Cost: 3, 3',
    ]);
  });

  it('takes the whole spec in data, flat fields on top', () => {
    const input = chartInputFromParams({
      data: '{"type":"donut","title":"Share","items":[{"label":"A","value":3}]}',
      title: 'Market share',
    });
    expect(input).toMatchObject({ type: 'donut', title: 'Market share' });
    expect(Array.isArray(input.items)).toBe(true);
  });

  it('names the file from the title', () => {
    expect(chartSlug('Units Sold by Year', 'bar')).toBe('units-sold-by-year');
    expect(chartSlug('', 'donut')).toBe('donut-chart');
  });
});

describe('chart — the tool', () => {
  it('writes the SVG and the spec beside it, presents the SVG, and reads the data back', async () => {
    const { pi, tools } = collect();
    const show = vi.fn(async () => ({ ok: true }));
    registerChartTool(pi, {
      bridge: { show, preview: async () => ({}) },
      root: () => root,
    });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', {
      type: 'bar',
      title: 'Units Sold by Year',
      labels: '2021, 2022, 2023, 2024',
      values: '12, 19, 15, 22',
      highlight: '2024',
      unit: 'units',
    });
    expect(r.isError).toBeFalsy();
    const text = r.content[0]?.text ?? '';
    const svgPath = path.join(root, 'units-sold-by-year.svg');
    expect(text).toContain(svgPath);
    expect(text).toContain('Data: 2021 12 units, 2022 19 units, 2023 15 units, 2024 22 units');
    expect(text).toContain('ONE sentence');
    expect(show).toHaveBeenCalledWith({
      path: svgPath,
      note: expect.stringContaining('bar chart'),
    });
    const svg = readFileSync(svgPath, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Units Sold by Year');
    const sidecar = JSON.parse(
      readFileSync(`${svgPath.slice(0, -4)}${CHART_SIDECAR_SUFFIX}`, 'utf8'),
    ) as { type: string; highlight: string; series: Array<{ points: unknown[] }> };
    expect(sidecar.type).toBe('bar');
    expect(sidecar.highlight).toBe('2024');
    expect(sidecar.series[0]?.points.length).toBe(4);
  });

  it('puts the file where it was asked, and a .json out still means the pair', async () => {
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', {
      title: 'Share',
      labels: 'A, B',
      values: '1, 3',
      type: 'donut',
      out: 'charts/share.chart.json',
    });
    expect(r.isError).toBeFalsy();
    const svgPath = path.join(root, 'charts', 'share.svg');
    expect(r.content[0]?.text).toContain(svgPath);
    expect(readFileSync(svgPath, 'utf8')).toContain('<svg');
  });

  it('refuses with what was missing when there is no data', async () => {
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', { type: 'bar', title: 'Nothing' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('--labels');
  });

  it('a scatter with numeric labels takes them as x', async () => {
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', {
      type: 'scatter',
      title: 'Height vs weight',
      labels: '150, 160, 170',
      values: '50, 60, 70',
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('(150, 50)');
  });

  it('describeData names the series when there are several', () => {
    expect(
      describeData({
        type: 'line',
        title: '',
        series: [
          { name: 'Revenue', points: [{ label: 'Q1', value: 4 }] },
          { name: 'Cost', points: [{ label: 'Q1', value: 3 }] },
        ],
        unit: '$',
      }),
    ).toBe('Revenue: Q1 $4 | Cost: Q1 $3');
  });
});
