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
    // The highlighted bar takes the accent, the rest the primary.
    const fills = [...container.querySelectorAll('.pd-chart-bar')].map((b) =>
      b.getAttribute('fill'),
    );
    expect(fills[3]).toBe('#E8863A');
    expect(fills[0]).toBe('var(--pd-accent-primary)');
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
