import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { ChartSurface, ChartView, chartArtifactSvg, specFromText } from './chart-surface.tsx';

// jsdom lays nothing out: give the chart box a width and a ResizeObserver.
const sizes = { width: 640, height: 320 };
let widthDesc: PropertyDescriptor | undefined;
let heightDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => sizes.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => sizes.height,
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDesc);
  if (heightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', heightDesc);
});

const UNITS = {
  type: 'bar',
  title: 'Units Sold by Year',
  subtitle: 'Annual totals',
  labels: ['2021', '2022', '2023', '2024'],
  values: [12, 19, 15, 22],
  highlight: '2024',
  note: 'Source: the brief',
};

function hoverBand(container: HTMLElement, index: number): Promise<void> {
  const band = container.querySelectorAll('.pd-chart-band')[index];
  if (!(band instanceof SVGElement)) throw new Error('band not found');
  // React synthesises onMouseEnter from the bubbling mouseover pair.
  return act(async () => {
    band.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

describe('ChartView', () => {
  it('draws the bars with the title and the note, one bar per value', async () => {
    const spec = specFromText(JSON.stringify(UNITS));
    if ('error' in spec) throw new Error(spec.error);
    const { container } = await render(<ChartView spec={spec} />);
    const view = container.querySelector('[data-testid="chart-view"]');
    expect(view?.getAttribute('data-chart-type')).toBe('bar');
    expect(container.querySelector('.pd-chart-title')?.textContent).toBe('Units Sold by Year');
    expect(container.querySelector('.pd-chart-subtitle')?.textContent).toBe('Annual totals');
    expect(container.querySelectorAll('.pd-chart-bar').length).toBe(4);
    expect(container.querySelector('.pd-chart-note')?.textContent).toBe('Source: the brief');
    // The highlighted bar takes the look's accent, the rest its primary — and
    // a bar is a path with rounded outer corners, not a square rect.
    const fills = [...container.querySelectorAll('.pd-chart-bar')].map((b) =>
      b.getAttribute('fill'),
    );
    expect(fills[3]).toBe('#DD6A1A'); // clean's accent, re-stepped by VQ-03 (was #E8863A)
    expect(fills[0]).toBe('#2F6FE4');
    expect(container.querySelector('.pd-chart-bar')?.tagName.toLowerCase()).toBe('path');
    expect(container.querySelector('.pd-chart-bar')?.getAttribute('d')).toContain('a8 8');
  });

  it('reads the hovered category out in a tooltip (Claude-style "2022 · 19")', async () => {
    const spec = specFromText(JSON.stringify(UNITS));
    if ('error' in spec) throw new Error(spec.error);
    const { container } = await render(<ChartView spec={spec} />);
    expect(container.querySelector('[data-testid="chart-tooltip"]')).toBeNull();
    await hoverBand(container, 1);
    const tip = container.querySelector('[data-testid="chart-tooltip"]');
    expect(tip?.querySelector('.pd-chart-tooltip-title')?.textContent).toBe('2022');
    expect(tip?.querySelector('.pd-chart-tooltip-value')?.textContent).toBe('19');
    // The other bars dim while one is read.
    const bars = container.querySelectorAll('.pd-chart-bar');
    expect(bars[0]?.getAttribute('opacity')).toBe('0.55');
    expect(bars[1]?.getAttribute('opacity')).toBe('1');
  });

  it('toggles to a table of the same rows and back', async () => {
    const spec = specFromText(JSON.stringify(UNITS));
    if ('error' in spec) throw new Error(spec.error);
    const { container } = await render(<ChartView spec={spec} />);
    await click(container.querySelector('button[aria-label="Table"]'));
    const table = container.querySelector('[data-testid="chart-table"]');
    expect(table).not.toBeNull();
    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ['2021', '12'],
      ['2022', '19'],
      ['2023', '15'],
      ['2024', '22'],
    ]);
    expect(
      container.querySelector('[data-testid="chart-view"]')?.getAttribute('data-chart-view'),
    ).toBe('table');
    await click(container.querySelector('button[aria-label="Chart"]'));
    expect(container.querySelectorAll('.pd-chart-bar').length).toBe(4);
  });

  it('renders every chart type from the same spec shape', async () => {
    for (const type of ['line', 'area', 'hbar', 'stacked', 'donut', 'scatter']) {
      const spec = specFromText(JSON.stringify({ ...UNITS, type }));
      if ('error' in spec) throw new Error(spec.error);
      const { container, unmount } = await render(<ChartView spec={spec} />);
      expect(container.querySelector('svg.pd-chart-svg')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="chart-view"]')?.getAttribute('data-chart-type'),
      ).toBe(type);
      await unmount();
    }
  });

  it('places the corner controls beside the toggle', async () => {
    const spec = specFromText(JSON.stringify(UNITS));
    if ('error' in spec) throw new Error(spec.error);
    const { container } = await render(
      <ChartView spec={spec} corner={<button type="button" data-testid="corner" />} />,
    );
    expect(container.querySelector('.pd-chart-controls [data-testid="corner"]')).not.toBeNull();
  });
});

describe('ChartSurface', () => {
  it('renders a chart artifact (its text is the JSON spec) filling the tab', async () => {
    const { container } = await render(
      <ChartSurface content={{ kind: 'chart', text: JSON.stringify(UNITS) }} streaming={false} />,
    );
    expect(container.querySelector('.pd-chart--fill')).not.toBeNull();
    expect(container.querySelectorAll('.pd-chart-bar').length).toBe(4);
  });

  it('says what is wrong with an unreadable spec instead of a blank tab', async () => {
    const { container } = await render(
      <ChartSurface content={{ kind: 'chart', text: '{"title": "no data"}' }} streaming={false} />,
    );
    expect(container.textContent).toContain('could not be read');
  });

  it('exports the static SVG of the same chart', () => {
    const svg = chartArtifactSvg(JSON.stringify(UNITS));
    expect(svg).toContain('<svg');
    expect(svg).toContain('Units Sold by Year');
    expect(chartArtifactSvg('not json')).toBeNull();
  });
});

describe('the look', () => {
  it('a fixed-ground look paints its own paper and ink on the card; a theme-following one does not', async () => {
    const slate = specFromText(JSON.stringify({ ...UNITS, look: 'slate' }));
    if ('error' in slate) throw new Error(slate.error);
    const { container, unmount } = await render(<ChartView spec={slate} />);
    const root = container.querySelector('[data-testid="chart-view"]') as HTMLElement;
    expect(root.getAttribute('data-chart-look')).toBe('slate');
    expect(root.hasAttribute('data-chart-ground')).toBe(true);
    expect(root.style.getPropertyValue('--chart-paper')).toBe('#1C1F26');
    expect(root.style.getPropertyValue('--chart-font')).toContain('Helvetica');
    await unmount();
    const soft = specFromText(JSON.stringify({ ...UNITS, look: 'soft' }));
    if ('error' in soft) throw new Error(soft.error);
    const { container: c2 } = await render(<ChartView spec={soft} />);
    const r2 = c2.querySelector('[data-testid="chart-view"]') as HTMLElement;
    expect(r2.hasAttribute('data-chart-ground')).toBe(false);
    expect(r2.style.getPropertyValue('--chart-paper')).toBe('');
    // Pill bars: the radius is half the bar's width.
    const d = c2.querySelector('.pd-chart-bar')?.getAttribute('d') ?? '';
    expect(/a(\d+(?:\.\d+)?) \1/.test(d)).toBe(true);
  });

  it('a bold look writes the values on the bars even inline; a grid-less look draws only the zero line', async () => {
    const bold = specFromText(JSON.stringify({ ...UNITS, look: 'bold' }));
    if ('error' in bold) throw new Error(bold.error);
    const { container } = await render(<ChartView spec={bold} />);
    expect(container.querySelectorAll('.pd-chart-text--value').length).toBe(4);
    expect(container.querySelectorAll('.pd-chart-grid').length).toBe(0);
    expect(container.querySelectorAll('.pd-chart-axis').length).toBe(1);
  });

  it('a smooth area chart draws a gradient under a curve', async () => {
    const ocean = specFromText(JSON.stringify({ ...UNITS, type: 'area', look: 'ocean' }));
    if ('error' in ocean) throw new Error(ocean.error);
    const { container } = await render(<ChartView spec={ocean} />);
    expect(container.querySelector('linearGradient')).not.toBeNull();
    const line = [...container.querySelectorAll('path')].find(
      (p) => p.getAttribute('stroke-width') === '3',
    );
    expect(line?.getAttribute('d')).toContain('C');
  });
});
