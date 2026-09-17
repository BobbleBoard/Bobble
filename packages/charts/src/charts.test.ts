import { describe, expect, it } from 'vitest';
import { chartToElements } from './elements.ts';
import { layoutChart, niceStep } from './layout.ts';
import { formatValue, normalizeChartSpec, pointCount } from './spec.ts';
import { chartToSvg } from './svg.ts';

const UNITS = {
  title: 'Units sold by year',
  labels: ['2021', '2022', '2023', '2024'],
  values: [12, 19, 27, 35],
};

describe('normalizeChartSpec — every shape a model actually writes', () => {
  it('labels + values (the flat form)', () => {
    const s = normalizeChartSpec({ ...UNITS, type: 'bar', y_label: 'Units (thousands)' });
    expect(s.type).toBe('bar');
    expect(s.yLabel).toBe('Units (thousands)');
    expect(s.series[0]?.points.map((p) => p.value)).toEqual([12, 19, 27, 35]);
    expect(pointCount(s)).toBe(4);
  });

  it('numbers_data, pairs, items, and a label→value object', () => {
    expect(
      normalizeChartSpec({ labels: ['a', 'b'], numbers_data: [1, 2] }).series[0]?.points,
    ).toHaveLength(2);
    expect(
      normalizeChartSpec({
        items: [
          ['a', 1],
          ['b', 2],
        ],
      }).series[0]?.points[1]?.value,
    ).toBe(2);
    expect(
      normalizeChartSpec({ points: [{ label: 'a', value: '1,200' }] }).series[0]?.points[0]?.value,
    ).toBe(1200);
    expect(
      normalizeChartSpec({ data: { a: 3, b: 4 } }).series[0]?.points.map((p) => p.label),
    ).toEqual(['a', 'b']);
  });

  it('several series from "Name: v1, v2" strings, and type aliases', () => {
    const s = normalizeChartSpec({
      type: 'column chart',
      labels: 'Q1, Q2, Q3',
      values: ['Revenue: 4.2, 5.1, 6.4', 'Cost: 3.1, 3.4, 3.9'],
    });
    expect(s.type).toBe('bar');
    expect(s.series.map((x) => x.name)).toEqual(['Revenue', 'Cost']);
    expect(s.series[1]?.points[2]?.value).toBe(3.9);
    // A pie is its own type now (a donut with no hole; the user wants pies that
    // "expand smoothly"); a radar has three spellings.
    expect(normalizeChartSpec({ type: 'pie', ...UNITS }).type).toBe('pie');
    expect(normalizeChartSpec({ type: 'doughnut', ...UNITS }).type).toBe('donut');
    expect(normalizeChartSpec({ type: 'spider', ...UNITS }).type).toBe('radar');
    expect(normalizeChartSpec({ type: 'horizontal', ...UNITS }).type).toBe('hbar');
  });

  it('refuses a chart with no data, saying what is missing', () => {
    expect(() => normalizeChartSpec({ title: 'Nothing' })).toThrow(/needs its data/);
  });

  it('formats values with the unit', () => {
    expect(formatValue(1200)).toBe('1,200');
    expect(formatValue(4.2, '$')).toBe('$4.2');
    expect(formatValue(35, '%')).toBe('35%');
    expect(formatValue(1850, 'GW')).toBe('1,850 GW');
  });
});

describe('layoutChart', () => {
  it('nice ticks and a zero line', () => {
    expect(niceStep(35)).toBe(10);
    expect(niceStep(6.4)).toBe(2);
    const L = layoutChart(normalizeChartSpec(UNITS), { width: 600, height: 300 });
    expect(L.ticks.map((t) => t.value)).toEqual([0, 10, 20, 30, 40]);
    expect(L.bars).toHaveLength(4);
    // Bars sit on the zero line and grow with the value.
    const [a, d] = [L.bars[0], L.bars[3]];
    expect(a !== undefined && d !== undefined && d.h > a.h).toBe(true);
    expect(Math.round((a?.y ?? 0) + (a?.h ?? 0))).toBe(Math.round(L.zero));
    // One hover band per category, spanning the plot height.
    expect(L.categories).toHaveLength(4);
    expect(L.categories[1]?.band.h).toBe(L.plot.h);
  });

  it('grouped bars, stacked bars, lines, hbar, donut and scatter all lay out', () => {
    const two = normalizeChartSpec({ labels: ['Q1', 'Q2'], values: ['A: 1, 2', 'B: 3, 4'] });
    expect(layoutChart({ ...two, type: 'bar' }, { width: 400, height: 200 }).bars).toHaveLength(4);
    const stacked = layoutChart({ ...two, type: 'stacked' }, { width: 400, height: 200 });
    expect(stacked.ticks.at(-1)?.value).toBeGreaterThanOrEqual(6); // 2 + 4
    const line = layoutChart({ ...two, type: 'line' }, { width: 400, height: 200 });
    expect(line.lines).toHaveLength(2);
    expect(line.lines[0]?.d.startsWith('M')).toBe(true);
    const h = layoutChart(normalizeChartSpec({ type: 'hbar', ...UNITS }), {
      width: 400,
      height: 200,
    });
    expect(h.bars[3]?.w).toBeGreaterThan(h.bars[0]?.w ?? 0);
    const donut = layoutChart(normalizeChartSpec({ type: 'donut', ...UNITS }), {
      width: 400,
      height: 200,
    });
    expect(donut.slices).toHaveLength(4);
    expect(Math.abs(donut.slices.reduce((n, s) => n + s.fraction, 0) - 1)).toBeLessThan(1e-9);
    const sc = layoutChart(
      normalizeChartSpec({
        type: 'scatter',
        series: [
          {
            name: 'p',
            points: [
              { label: 'a', x: 1, value: 2 },
              { label: 'b', x: 3, value: 5 },
            ],
          },
        ],
      }),
      { width: 400, height: 200 },
    );
    expect(sc.scatter).toHaveLength(2);
    expect(sc.xTicks.length).toBeGreaterThan(1);
  });
});

describe('chartToSvg', () => {
  it('writes a complete document with the values on the bars', () => {
    const svg = chartToSvg(
      normalizeChartSpec({ ...UNITS, subtitle: 'thousands', note: 'Source: the request' }),
    );
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('Units sold by year');
    expect(svg).toContain('>35<');
    expect(svg).toContain('Source: the request');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    // Every type renders without throwing.
    for (const type of ['stacked', 'hbar', 'line', 'area', 'donut'] as const) {
      expect(chartToSvg(normalizeChartSpec({ ...UNITS, type }))).toContain('</svg>');
    }
  });

  it('escapes what a title could carry', () => {
    const svg = chartToSvg(normalizeChartSpec({ ...UNITS, title: 'A <b> & "c"' }));
    expect(svg).toContain('A &lt;b&gt; &amp; &quot;c&quot;');
    expect(svg).not.toContain('<b>');
  });
});

describe('the donut hole', () => {
  it('reads the total with its unit, or the leading share when the values are shares', () => {
    const counts = layoutChart(
      normalizeChartSpec({ type: 'donut', labels: ['a', 'b'], values: [30, 10], unit: '$' }),
      { width: 600, height: 300 },
    );
    expect(counts.donut?.centre).toEqual({ big: '$40', small: 'total' });
    const shares = layoutChart(
      normalizeChartSpec({
        type: 'donut',
        labels: ['Acme', 'Globex'],
        values: [62, 38],
        unit: '%',
      }),
      { width: 600, height: 300 },
    );
    expect(shares.donut?.centre).toEqual({ big: '62%', small: 'Acme' });
    const highlighted = layoutChart(
      normalizeChartSpec({
        type: 'donut',
        labels: ['Acme', 'Globex'],
        values: [62, 38],
        unit: '%',
        highlight: 'Globex',
      }),
      { width: 600, height: 300 },
    );
    expect(highlighted.donut?.centre).toEqual({ big: '38%', small: 'Globex' });
  });
});

describe('pie and radar', () => {
  const skills = {
    title: 'Profile',
    labels: ['Speed', 'Power', 'Range', 'Cost', 'Style'],
    values: ['Ours: 8, 6, 9, 4, 7', 'Theirs: 5, 8, 6, 7, 5'],
  };

  it('a pie is a donut with no hole and nothing written in the middle', () => {
    const spec = normalizeChartSpec({ type: 'pie', labels: ['a', 'b', 'c'], values: [1, 2, 3] });
    const L = layoutChart(spec, { width: 600, height: 360 });
    expect(L.donut?.ring).toBe(L.donut?.r);
    expect(L.donut?.centre).toEqual({ big: '', small: '' });
    // Every slice path closes at the centre, not on an inner arc.
    for (const s of L.slices) expect(s.d).toMatch(/L300(\.\d)? \d+(\.\d)? Z$|A\d/);
    const svg = chartToSvg(spec);
    expect(svg).not.toContain('>6<');
  });

  it('a radar lays one polygon per series round a spoke per category', () => {
    const spec = normalizeChartSpec({ type: 'radar', ...skills });
    expect(spec.type).toBe('radar');
    const L = layoutChart(spec, { width: 600, height: 400 });
    expect(L.radar?.axes.map((a) => a.label)).toEqual(['Speed', 'Power', 'Range', 'Cost', 'Style']);
    expect(L.radar?.shapes).toHaveLength(2);
    expect(L.radar?.shapes[0]?.points).toHaveLength(5);
    // The first spoke points straight up; the strongest value sits on the rim.
    const top = L.radar?.axes[0];
    expect(top?.x).toBeCloseTo(L.radar?.cx ?? 0, 3);
    expect((top?.y ?? 0) < (L.radar?.cy ?? 0)).toBe(true);
    const range = L.radar?.shapes[0]?.points[2];
    const d = Math.hypot(
      (range?.x ?? 0) - (L.radar?.cx ?? 0),
      (range?.y ?? 0) - (L.radar?.cy ?? 0),
    );
    expect(d).toBeCloseTo(L.radar?.r ?? 0, 3);
    const svg = chartToSvg(spec);
    expect(svg).toContain('Speed');
    expect((svg.match(/<circle/g) ?? []).length).toBe(10);
    const els = chartToElements(spec);
    expect(els.elements.some((e) => e.tag === 'polygon')).toBe(true);
    expect(els.elements.filter((e) => e.tag === 'circle')).toHaveLength(10);
  });
});
