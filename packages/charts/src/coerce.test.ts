import { describe, expect, it } from 'vitest';
import { coerceChartForm, titleFromData } from './coerce.ts';
import { chartToElements } from './elements.ts';
import { layoutChart } from './layout.ts';
import { ChartDataError } from './numbers.ts';
import { CHART_SIZES, chartCanvas, chartSizeOf } from './sizes.ts';
import { normalizeChartSpec } from './spec.ts';
import { chartToSvg } from './svg.ts';

describe('forms that cannot show the data become ones that can — and say so', () => {
  it('a scatter of named categories (REAL: X, Y, Z, W all drawn at x = 0) is bars', () => {
    const c = coerceChartForm(
      normalizeChartSpec({ type: 'scatter', labels: 'X, Y, Z, W', values: '10, 20, 15, 25' }),
    );
    expect(c.spec.type).toBe('bar');
    expect(c.notes[0]).toBe(
      'drawn as bars instead: a scatter needs a number for x on every point, and "X", "Y", "Z" and "W" are names',
    );
  });

  it('a stack of one series of shares (REAL: "Product Mix", 30/25/20/25 %) is a donut', () => {
    const c = coerceChartForm(
      normalizeChartSpec({
        type: 'stacked',
        labels: 'Electronics, Clothing, Home, Beauty',
        values: '30, 25, 20, 25',
        unit: '%',
      }),
    );
    expect(c.spec.type).toBe('donut');
    expect(c.notes[0]).toMatch(/^drawn as a donut instead: one series of shares adding up to 100/);
    const plain = coerceChartForm(
      normalizeChartSpec({ type: 'stacked', labels: 'a, b', values: '3, 9' }),
    );
    expect(plain.spec.type).toBe('bar');
    expect(plain.notes[0]).toMatch(/a stack needs two or more series/);
  });

  it('a donut of two series, or of a negative, is bars; a two-spoke radar too; a one-point line too', () => {
    expect(
      coerceChartForm(
        normalizeChartSpec({ type: 'donut', labels: 'a, b', values: ['A: 1, 2', 'B: 3, 4'] }),
      ).spec.type,
    ).toBe('bar');
    expect(
      coerceChartForm(normalizeChartSpec({ type: 'pie', labels: 'a, b', values: '5, -2' }))
        .notes[0],
    ).toMatch(/cannot show a negative value/);
    expect(
      coerceChartForm(normalizeChartSpec({ type: 'radar', labels: 'a, b', values: '1, 2' })).spec
        .type,
    ).toBe('bar');
    expect(
      coerceChartForm(normalizeChartSpec({ type: 'line', labels: 'a', values: '1' })).spec.type,
    ).toBe('bar');
  });

  it('a chart that is fine is left alone', () => {
    const spec = normalizeChartSpec({ type: 'line', labels: 'a, b, c', values: '1, 2, 3' });
    const c = coerceChartForm(spec);
    expect(c.spec).toBe(spec);
    expect(c.notes).toEqual([]);
  });
});

describe('an untitled chart is titled from its own words', () => {
  const t = (o: Record<string, unknown>) => titleFromData(normalizeChartSpec(o));
  it('runs of labels as a range; a few categories by name; several series by name', () => {
    expect(t({ labels: 'Q1, Q2, Q3, Q4', values: '1, 2, 3, 4' })).toBe('Q1–Q4');
    expect(t({ labels: '2020, 2021, 2022', values: '1, 2, 3' })).toBe('2020–2022');
    expect(t({ labels: 'Jan, Feb, Mar', values: '1, 2, 3' })).toBe('Jan–Mar');
    expect(t({ labels: 'X, Y, Z', values: '1, 2, 3' })).toBe('X, Y and Z');
    expect(
      t({ labels: 'Engineering, Design, Product, Marketing, Sales', values: '1, 2, 3, 4, 5' }),
    ).toBe('Engineering, Design, Product and 2 more');
    expect(t({ labels: 'a, b', values: ['Revenue: 1, 2', 'Costs: 3, 4'] })).toBe(
      'Revenue and Costs',
    );
  });
});

describe('the tool reads the values strictly — nothing dropped, nothing zeroed', () => {
  it('a value that is not a number is named', () => {
    expect(() =>
      normalizeChartSpec({ labels: 'a, b, c', values: '12, abc, 15' }, { strict: true }),
    ).toThrow(ChartDataError);
    // The card reads a sidecar as forgivingly as ever.
    expect(
      normalizeChartSpec({ labels: 'a, b, c', values: '12, abc, 15' }).series[0]?.points.length,
    ).toBe(3);
  });

  it('a count that does not match the labels is said, per series', () => {
    expect(() =>
      normalizeChartSpec({ labels: 'a, b, c', values: '1, 2' }, { strict: true }),
    ).toThrow(
      'the values have 2 numbers but there are 3 labels (a, b, c): give one value per label',
    );
    expect(() =>
      normalizeChartSpec(
        { labels: 'a, b', values: ['Revenue: 1, 2', 'Costs: 3'] },
        { strict: true },
      ),
    ).toThrow(/series "Costs" has 1 number but there are 2 labels/);
  });

  it('"22M, 3,100" is two values; "$1.2M" carries its dollar into the unit', () => {
    const s = normalizeChartSpec(
      { labels: 'Market, Today', values: '22M, 3,100' },
      { strict: true },
    );
    expect(s.series[0]?.points.map((p) => p.value)).toEqual([22_000_000, 3_100]);
    const r = normalizeChartSpec({ labels: 'Seed, A', values: '$1.2M, $2.4M' }, { strict: true });
    expect(r.unit).toBe('$');
    expect(r.series[0]?.points.map((p) => p.value)).toEqual([1_200_000, 2_400_000]);
    // A unit said outright wins over the written one.
    expect(normalizeChartSpec({ labels: 'a', values: '$5', unit: 'USD' }).unit).toBe('USD');
  });

  it('labels written with ", " keep a comma inside a label', () => {
    const s = normalizeChartSpec({ labels: '1,000-2,000, 2,000-3,000', values: '4, 5' });
    expect(s.series[0]?.points.map((p) => p.label)).toEqual(['1,000-2,000', '2,000-3,000']);
    expect(normalizeChartSpec({ labels: 'A,B,C', values: '1,2,3' }).series[0]?.points.length).toBe(
      3,
    );
  });
});

describe('the file is sized for where it goes', () => {
  it('presets: card, doc, slide, square — read from the words a model uses', () => {
    expect(chartSizeOf('doc')).toBe('doc');
    expect(chartSizeOf('document')).toBe('doc');
    expect(chartSizeOf('presentation')).toBe('slide');
    expect(chartSizeOf('16:9')).toBe('slide');
    expect(chartSizeOf('instagram')).toBe('square');
    expect(chartSizeOf('huge')).toBeUndefined();
    const spec = normalizeChartSpec({ labels: 'a, b', values: '1, 2', size: 'doc' });
    expect(spec.size).toBe('doc');
    expect(chartToSvg(spec)).toContain('width="640" height="400"');
  });

  it('a slide is drawn on a smaller page and scaled up whole: type 1.5× at 1280×720', () => {
    const spec = normalizeChartSpec({ title: 'T', labels: 'a, b', values: '1, 2', size: 'slide' });
    const svg = chartToSvg(spec);
    expect(svg).toContain('width="1280" height="720" viewBox="0 0 853 480"');
    const el = chartToElements(spec);
    expect([el.width, el.height]).toEqual([1280, 720]);
    const title = el.elements.find((e) => e.text === 'T');
    expect(title?.fontSize).toBe(22 * CHART_SIZES.slide.text);
  });

  it('a horizontal bar chart is as tall as its rows (three bars were 560 px tall)', () => {
    const three = normalizeChartSpec({
      type: 'hbar',
      title: 'T',
      labels: 'a, b, c',
      values: '4, 8, 2',
    });
    const thirty = normalizeChartSpec({
      type: 'hbar',
      title: 'T',
      labels: Array.from({ length: 30 }, (_v, i) => `row ${i}`),
      values: Array.from({ length: 30 }, (_v, i) => i + 1),
    });
    expect(chartCanvas(three).height).toBeLessThan(320);
    expect(chartCanvas(thirty).height).toBeGreaterThan(1000);
    expect(chartToSvg(three)).toContain(`height="${chartCanvas(three).height}"`);
    // A slide keeps its 16:9 whatever it holds.
    expect(chartCanvas({ ...thirty, size: 'slide' }).height).toBe(720);
  });
});

describe('lines are named at their ends (2–4 series)', () => {
  const spec = normalizeChartSpec({
    type: 'line',
    labels: '2021, 2022, 2023',
    values: ['Revenue: 1.2, 1.9, 2.8', 'Costs: 1.5, 1.8, 2.2'],
  });
  it('the layout places one label per line, right of the plot, apart from each other', () => {
    const L = layoutChart(spec, { width: 700, height: 380, endLabels: true });
    expect(L.endLabels.map((e) => e.text).sort()).toEqual(['Costs', 'Revenue']);
    for (const e of L.endLabels) expect(e.x).toBeGreaterThan(L.plot.x + L.plot.w);
    const [a, b] = [...L.endLabels].sort((x, y) => x.y - y.y);
    expect((b?.y ?? 0) - (a?.y ?? 0)).toBeGreaterThanOrEqual(14);
  });

  it('only when asked (the card has hover), and not for one line or for five', () => {
    expect(layoutChart(spec, { width: 700, height: 380 }).endLabels).toEqual([]);
    const five = normalizeChartSpec({
      type: 'line',
      labels: 'a, b',
      values: ['A: 1, 2', 'B: 2, 3', 'C: 3, 4', 'D: 4, 5', 'E: 5, 6'],
    });
    expect(layoutChart(five, { width: 700, height: 380, endLabels: true }).endLabels).toEqual([]);
  });

  it('the file draws them', () => {
    const svg = chartToSvg(spec);
    expect(svg).toMatch(/font-weight="600" fill="#1D1D1F" text-anchor="start">Revenue</);
  });
});
