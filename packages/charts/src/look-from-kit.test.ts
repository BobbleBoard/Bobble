import { describe, expect, it } from 'vitest';
import { dressInKit, type KitForChart, lookFromKit } from './look-from-kit.ts';
import { normalizeChartSpec } from './spec.ts';
import { resolveStyle } from './style.ts';
import { chartToSvg } from './svg.ts';

/** A kit as design-kit exports it, reduced to what a chart reads (Paper & teal). */
const PAPER_TEAL: KitForChart = {
  id: 'paper-teal',
  light: {
    series: ['#0F7B74', '#D0661C', '#0056AA', '#6C6158', '#0096AF', '#992641'],
    highlight: '#D0661C',
  },
  dark: {
    series: ['#3BB3A9', '#F09A57', '#3280DD', '#8C857C', '#5DC1DB', '#CB4F73'],
    highlight: '#F09A57',
  },
  chart: { base: 'clean', radius: 8, grid: 'lines', line: 'smooth', font: 'system' },
};

describe('lookFromKit', () => {
  it('dresses a chart in the kit: its series, its highlight, its knobs, its dark steps', () => {
    const style = lookFromKit(PAPER_TEAL);
    expect(style.look).toBe('clean');
    expect(style.palette?.[0]).toBe('#0F7B74');
    expect(style.accent).toBe('#D0661C');
    expect(style.line).toBe('smooth');
    expect(style.kit).toBe('paper-teal');
    const light = resolveStyle(style, 'clean', { theme: 'light' });
    const dark = resolveStyle(style, 'clean', { theme: 'dark' });
    expect(light.palette).toEqual(PAPER_TEAL.light.series);
    // In a dark chat: the kit's own dark steps, not the light ones lifted by formula.
    expect(dark.palette).toEqual(PAPER_TEAL.dark.series);
    expect(dark.accent).toBe('#F09A57');
  });

  it('an unknown base look falls back to clean rather than failing', () => {
    expect(lookFromKit({ ...PAPER_TEAL, chart: { ...PAPER_TEAL.chart, base: 'neon' } }).look).toBe(
      'clean',
    );
  });

  it('survives a trip through the spec file (the chart tool writes it, the card reads it)', () => {
    const spec = normalizeChartSpec({
      labels: ['a', 'b'],
      values: [1, 2],
      style: lookFromKit(PAPER_TEAL),
    });
    expect(spec.style?.dark?.palette).toEqual(PAPER_TEAL.dark.series);
    expect(spec.style?.kit).toBe('paper-teal');
    expect(chartToSvg(spec)).toContain('#0F7B74');
  });
});

describe('dressInKit — the chart’s own knobs over the kit', () => {
  const kit = lookFromKit(PAPER_TEAL);

  it('a knob sits on top and the kit stays', () => {
    const s = dressInKit(kit, { radius: 'pill' });
    expect(s.radius).toBe('pill');
    expect(s.kit).toBe('paper-teal');
    expect(s.dark).toBeDefined();
  });

  it('a colour set by hand replaces the kit’s colours in both modes', () => {
    const s = dressInKit(kit, { accent: '#F0563C' });
    expect(s.accent).toBe('#F0563C');
    expect(s.dark).toBeUndefined();
    expect(s.kit).toBeUndefined();
    expect(resolveStyle(s, 'clean', { theme: 'dark' }).accent).not.toBe('#F09A57');
  });

  it('a named look replaces the kit outright', () => {
    expect(dressInKit(kit, { look: 'sunset' })).toEqual({ look: 'sunset' });
  });
});
