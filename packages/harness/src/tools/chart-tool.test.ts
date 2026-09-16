import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeChartSpec as normalize } from '@pi-desktop/charts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import {
  applyEdits,
  CHART_EDIT_TOOL,
  CHART_SIDECAR_SUFFIX,
  CHART_TOOL,
  chartInputFromParams,
  chartSlug,
  describeData,
  registerChartTool,
  summarizeChange,
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

  it('is the chart capability: `chart` with no sub-word, and `chart edit`', () => {
    expect(tools.map((t) => t.name)).toEqual([CHART_TOOL, CHART_EDIT_TOOL]);
    expect(spec?.tools).toEqual([CHART_TOOL, CHART_EDIT_TOOL]);
    expect(commandNameFor('chart')).toBe('chart');
    expect(pathFor('chart', CHART_TOOL)).toEqual([]);
    expect(pathFor('chart', CHART_EDIT_TOOL)).toEqual(['edit']);
  });

  it('`chart edit units.svg --add "Cost: 8, 12" --bars thin` is chart_edit with the file and the changes', () => {
    const r = resolveCli(cli, [
      'chart',
      'edit',
      'units.svg',
      '--add',
      'Cost: 8, 12, 10, 14',
      '--bars',
      'thin',
      '--accent',
      'coral',
    ]);
    expect(r.kind).toBe('call');
    if (r.kind !== 'call') return;
    expect(r.tool).toBe(CHART_EDIT_TOOL);
    expect(r.args).toMatchObject({
      file: 'units.svg',
      add: 'Cost: 8, 12, 10, 14',
      bars: 'thin',
      accent: 'coral',
    });
  });

  it('the look knobs ride the make command too', () => {
    const r = resolveCli(cli, [
      'chart',
      'bar',
      'Units',
      '--labels',
      'a, b',
      '--values',
      '1, 2',
      '--look',
      'editorial',
      '--radius',
      'pill',
    ]);
    expect(r.kind === 'call' && r.args).toMatchObject({ look: 'editorial', radius: 'pill' });
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

  it('salvages data that landed in the type slot as JSON, and a look named in a style string', () => {
    /* MEASURED: a 4B sent `["Units Sold (thousands)", [12, 19, 27, 35]]` under
       an unknown key — the CLI handed it to the first positional — with
       `--style clean/mono`, and got "needs its data" for a call that had it. */
    const got = chartInputFromParams({
      labels: '["2021","2022","2023","2024"]',
      title: 'Units Sold by Year',
      type: '["Units Sold (thousands)",[12,19,27,35]]',
      style: 'clean/mono',
    });
    expect(got.values).toBe('Units Sold (thousands): 12, 19, 27, 35');
    expect(got.type).toBeUndefined();
    expect(got.title).toBe('Units Sold by Year');
    expect(got.style).toEqual({ look: 'clean' });
    expect(chartInputFromParams({ type: '[1, 2, 3]', labels: 'a, b, c' }).values).toEqual([
      1, 2, 3,
    ]);
    expect(chartInputFromParams({ style: 'editorial, pill, thin' }).style).toEqual({
      look: 'editorial',
      radius: 'pill',
      barWidth: 0.4,
    });
  });

  it('reads the look knobs, flat or as a style object, into the spec\u2019s style', () => {
    const flat = chartInputFromParams({
      look: 'soft',
      accent: 'coral',
      bars: 'thin',
      grid: 'none',
    });
    expect(flat.style).toEqual({ look: 'soft', accent: '#F0563C', barWidth: 0.4, grid: 'none' });
    const nested = chartInputFromParams({
      style: '{"radius":"pill","line":"smooth"}',
      font: 'serif',
    });
    expect(nested.style).toEqual({ radius: 'pill', line: 'smooth', font: 'serif' });
    // The categories key is never mistaken for the value-label switch.
    const cats = chartInputFromParams({ labels: 'a, b', values: '1, 2' });
    expect(cats.style).toBeUndefined();
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
    // A chart that named no look got one, baked into the spec (so the file and
    // the card agree), and the result says which.
    const styled = sidecar as unknown as { style?: { look?: string } };
    expect(styled.style?.look).toBeDefined();
    expect(text).toContain(`Look: look ${styled.style?.look}`);
  });

  it('a named look and knobs are kept as given; the SVG wears them', async () => {
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', {
      type: 'bar',
      title: 'Styled',
      labels: 'a, b',
      values: '1, 2',
      look: 'terminal',
      radius: 'pill',
      out: 'styled.svg',
    });
    expect(r.isError).toBeFalsy();
    const svg = readFileSync(path.join(root, 'styled.svg'), 'utf8');
    expect(svg).toContain('fill="#0B0F0A"');
    expect(svg).toContain('Menlo');
    expect(r.content[0]?.text).toContain('Look: look terminal, radius pill');
  });

  it('styles from an image through the app\u2019s decoder: the picture\u2019s colours become the palette', async () => {
    const { pi, tools } = collect();
    // A 16x16 picture: forty red pixels, the rest a near-white ground.
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i += 1) {
      const red = i < 40;
      px[i * 4] = red ? 220 : 250;
      px[i * 4 + 1] = red ? 40 : 250;
      px[i * 4 + 2] = red ? 40 : 250;
      px[i * 4 + 3] = 255;
    }
    const pixels = vi.fn(async () => ({
      width: 4,
      height: 4,
      rgba: Buffer.from(px).toString('base64'),
    }));
    registerChartTool(pi, {
      bridge: { show: async () => ({ ok: true }), preview: async () => ({}), pixels },
      root: () => root,
    });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', {
      title: 'From a picture',
      labels: 'a, b',
      values: '1, 2',
      from_image: 'brand.png',
      out: 'from-image.svg',
    });
    expect(r.isError).toBeFalsy();
    expect(pixels).toHaveBeenCalledWith({ path: path.join(root, 'brand.png'), width: 64 });
    const sidecar = JSON.parse(readFileSync(path.join(root, 'from-image.chart.json'), 'utf8')) as {
      style: { palette: string[]; background?: string };
    };
    expect(sidecar.style.palette[0]).toBe('#DC2828');
    expect(sidecar.style.background).toBe('#FAFAFA');
    expect(r.content[0]?.text).toContain('Colours from brand.png');
  });

  it('without the app, styling from an image says so instead of guessing', async () => {
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', { title: 'x', labels: 'a', values: '1', from_image: 'brand.png' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('needs the app');
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

  it('an untitled chart with one named series takes the name as its title', async () => {
    const { pi, tools } = collect();
    registerChartTool(pi, { bridge: null, root: () => root });
    const exec = tools[0]?.execute as Exec;
    const r = await exec('1', {
      labels: '2021, 2022',
      values: 'Units Sold (thousands): 12, 19',
      out: 'titled.svg',
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('a bar chart "Units Sold (thousands)"');
    expect(r.content[0]?.text).toContain('Data: 2021 12, 2022 19');
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

describe('chart_edit — every change a user asks for', () => {
  const base = {
    type: 'bar',
    title: 'Units Sold by Year',
    labels: ['2021', '2022', '2023', '2024'],
    values: [12, 19, 15, 22],
    style: { look: 'clean' },
  };
  const made = () => {
    const { pi, tools } = collect();
    const show = vi.fn(async () => ({ ok: true }));
    registerChartTool(pi, {
      bridge: { show, preview: async () => ({}) },
      root: () => root,
    });
    return { make: tools[0]?.execute as Exec, edit: tools[1]?.execute as Exec, show };
  };

  it('adds a second series (grouped bars), thins the bars, recolours — and redraws in place', async () => {
    const { make, edit, show } = made();
    await make('1', {
      ...base,
      labels: base.labels.join(', '),
      values: base.values.join(', '),
      out: 'edit-me.svg',
    });
    const r = await edit('2', {
      file: 'edit-me.svg',
      add: 'Cost: 8, 12, 10, 14',
      bars: 'thin',
      accent: 'coral',
    });
    expect(r.isError).toBeFalsy();
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('Changed added Cost, the look');
    expect(text).toContain('Data: Units Sold by Year: 2021 12');
    const sidecar = JSON.parse(readFileSync(path.join(root, 'edit-me.chart.json'), 'utf8')) as {
      series: Array<{ name: string; points: Array<{ value: number }> }>;
      style: { barWidth: number; accent: string; look: string };
    };
    expect(sidecar.series.map((s) => s.name)).toEqual(['Units Sold by Year', 'Cost']);
    expect(sidecar.series[1]?.points.map((p) => p.value)).toEqual([8, 12, 10, 14]);
    expect(sidecar.style).toMatchObject({ look: 'clean', barWidth: 0.4, accent: '#F0563C' });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('sets a value, removes a series, renames, sorts, changes the type and the look', () => {
    const current = normalize({
      ...base,
      values: ['Units: 12, 19, 15, 22', 'Cost: 8, 12, 10, 14'],
    });
    const set = applyEdits(current, { set: '2023: 17, Cost/2024: 9' });
    expect(set.series[0]?.points[2]?.value).toBe(17);
    expect(set.series[1]?.points[3]?.value).toBe(9);
    const removed = applyEdits(current, { remove: 'Cost' });
    expect(removed.series.map((s) => s.name)).toEqual(['Units']);
    const dropped = applyEdits(current, { remove: '2021' });
    expect(dropped.series[0]?.points.map((p) => p.label)).toEqual(['2022', '2023', '2024']);
    const renamed = applyEdits(current, { rename: 'Cost: Costs; 2021: FY21' });
    expect(renamed.series[1]?.name).toBe('Costs');
    expect(renamed.series[0]?.points[0]?.label).toBe('FY21');
    const sorted = applyEdits(current, { sort: 'desc', type: 'hbar' });
    expect(sorted.type).toBe('hbar');
    expect(sorted.series[0]?.points.map((p) => p.label)).toEqual(['2024', '2022', '2023', '2021']);
    expect(sorted.series[1]?.points.map((p) => p.value)).toEqual([14, 12, 10, 8]);
    const relooked = applyEdits(
      { ...current, style: { look: 'clean', barWidth: 0.4 } },
      { look: 'sunset' },
    );
    // A new look resets the old look's knobs…
    expect(relooked.style).toEqual({ look: 'sunset' });
    // …unless they are set again in the same call.
    expect(applyEdits(current, { look: 'sunset', grid: 'dots' }).style).toEqual({
      look: 'sunset',
      grid: 'dots',
    });
    expect(applyEdits(current, { highlight: 'none' }).highlight).toBeUndefined();
    expect(applyEdits(current, { highlight: '2023' }).highlight).toBe('2023');
  });

  it('refuses a series that does not match the categories, and a name that is not there', () => {
    const current = normalize(base);
    expect(() => applyEdits(current, { add: 'Cost: 1, 2' })).toThrow(
      /2 values but the chart has 4/,
    );
    expect(() => applyEdits(current, { set: '2030: 5' })).toThrow(/no category called "2030"/);
    expect(() => applyEdits(current, { remove: 'Profit' })).toThrow(/nothing called "Profit"/);
    expect(summarizeChange(current, current)).toEqual([]);
  });

  it('a chart not made here is refused with the way in', async () => {
    const { edit } = made();
    const r = await edit('1', { file: 'nope.svg', accent: 'coral' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('Make it with chart');
  });

  it('an edit that changes nothing says what an edit can be', async () => {
    const { make, edit } = made();
    await make('1', {
      ...base,
      labels: base.labels.join(', '),
      values: base.values.join(', '),
      out: 'same.svg',
    });
    const r = await edit('2', { file: 'same.svg' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('--add');
  });
});
