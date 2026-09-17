import { describe, expect, it } from 'vitest';
import { chartToElements, cssRgb, linePoints, over } from './elements.ts';
import { normalizeChartSpec } from './spec.ts';

describe('chartToElements — the chart as the office pipeline measures a page', () => {
  it('a bar chart is boxes, labels and gridlines in the chart’s own pixels', () => {
    const el = chartToElements(
      normalizeChartSpec({
        title: 'Units Sold by Year',
        labels: ['2021', '2022', '2023', '2024'],
        values: [12, 19, 15, 22],
        highlight: '2024',
        look: 'clean',
      }),
    );
    expect(el.width).toBe(960);
    expect(el.look).toBe('clean');
    const bars = el.elements.filter((e) => e.tag === 'div' && (e.h ?? 0) > 20 && e.radius === 8);
    expect(bars).toHaveLength(4);
    expect(bars[3]?.bg).toBe(cssRgb('#E8863A'));
    const title = el.elements.find((e) => e.text === 'Units Sold by Year');
    expect(title).toMatchObject({ tag: 'span', fontSize: 22, fontWeight: '600' });
    const cats = el.elements.filter((e) => e.tag === 'span' && /^202\d$/.test(e.text ?? ''));
    expect(cats).toHaveLength(4);
    expect(cats[0]?.align).toBe('center');
    // A theme-following look draws on the page: no ground element.
    expect(el.elements[0]?.tag).not.toBe('div');
  });

  it('a fixed-ground look brings its paper first; a smooth area is a sampled polygon and polyline', () => {
    const el = chartToElements(
      normalizeChartSpec({
        type: 'area',
        labels: ['a', 'b', 'c'],
        values: [1, 3, 2],
        look: 'slate',
        line: 'smooth',
      }),
    );
    expect(el.elements[0]).toMatchObject({ tag: 'div', x: 0, y: 0, w: 960, h: 560 });
    const line = el.elements.find((e) => e.tag === 'polyline');
    const area = el.elements.find((e) => e.tag === 'polygon');
    expect(line?.points?.split(' ').length).toBeGreaterThan(20);
    expect(area?.fillC?.startsWith('rgb(')).toBe(true);
    expect(el.elements.filter((e) => e.tag === 'circle').length).toBeGreaterThanOrEqual(3);
  });

  it('a donut is polygons per slice with the legend beside', () => {
    const el = chartToElements(
      normalizeChartSpec({ type: 'donut', labels: ['A', 'B'], values: [62, 38], unit: '%' }),
    );
    expect(el.elements.filter((e) => e.tag === 'polygon')).toHaveLength(2);
    expect(el.elements.find((e) => e.text === '62%')).toBeDefined();
  });

  it('linePoints samples a curve, keeps straight lines, and squares a step', () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
    ];
    expect(linePoints(pts, 'straight')).toHaveLength(3);
    expect(linePoints(pts, 'smooth')).toHaveLength(25);
    expect(linePoints(pts, 'step')).toHaveLength(7);
    expect(over('#000000', '#FFFFFF', 0.5)).toBe('rgb(128, 128, 128)');
  });
});
