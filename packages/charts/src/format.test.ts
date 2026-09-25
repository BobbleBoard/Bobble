import { describe, expect, it } from 'vitest';
import { formatTick, formatValue, unitParts } from './format.ts';
import { layoutChart, niceStep } from './layout.ts';
import { normalizeChartSpec } from './spec.ts';

describe('a unit is what goes before and after the number', () => {
  it('"$M" is "$5.6M", not "5.6 $M" (the research’s revenue chart)', () => {
    expect(formatValue(5.6, '$M')).toBe('$5.6M');
    expect(formatValue(1.2, '€bn')).toBe('€1.2bn');
    expect(formatValue(38, '$k')).toBe('$38k');
    expect(formatValue(22, 'M')).toBe('22M');
  });

  it('keeps the forms that were right: $4, 12%, 5 GW, 19 units', () => {
    expect(formatValue(4, '$')).toBe('$4');
    expect(formatValue(12, '%')).toBe('12%');
    expect(formatValue(5, 'GW')).toBe('5 GW');
    expect(formatValue(19, 'units')).toBe('19 units');
    expect(formatValue(22_000_000)).toBe('22,000,000');
  });

  it('a minus goes before the currency', () => {
    expect(formatValue(-5, '$')).toBe('-$5');
    expect(formatValue(-2.5, '$M')).toBe('-$2.5M');
  });

  it('knows which units are words (said once, not on every tick)', () => {
    expect(unitParts('units').word).toBe(true);
    expect(unitParts('features').word).toBe(true);
    expect(unitParts('GW').word).toBe(false);
    expect(unitParts('$').word).toBe(false);
  });
});

describe('ticks carry the unit and stay short', () => {
  it('money, percent, magnitudes and short units ride every tick', () => {
    expect(formatTick(2, '$M')).toBe('$2M');
    expect(formatTick(0, '$M')).toBe('$0'); // zero needs no magnitude
    expect(formatTick(0, '%')).toBe('0%');
    expect(formatTick(40, '%')).toBe('40%');
    expect(formatTick(20, 'GW')).toBe('20 GW');
    expect(formatTick(2_000_000, '$')).toBe('$2M');
  });

  it('a word unit stays off the ticks; big numbers are compact, thousands keep their comma', () => {
    expect(formatTick(20, 'units')).toBe('20');
    expect(formatTick(15_000_000)).toBe('15M');
    expect(formatTick(2_500_000)).toBe('2.5M');
    expect(formatTick(40_000)).toBe('40,000');
  });

  it('the layout’s value axis is labelled that way ("$0, $1M … " for "$1.2M, $2.4M")', () => {
    const spec = normalizeChartSpec(
      { labels: 'Seed, Series A', values: '$1.2M, $2.4M' },
      { strict: true },
    );
    expect(spec.unit).toBe('$');
    const L = layoutChart(spec, { width: 600, height: 300 });
    expect(L.ticks.map((t) => t.label)).toEqual(['$0', '$0.5M', '$1M', '$1.5M', '$2M', '$2.5M']);
  });

  it('a word unit becomes the value axis’ title instead', () => {
    const spec = normalizeChartSpec({
      type: 'hbar',
      labels: 'Critical, High',
      values: '4, 8',
      unit: 'features',
    });
    const L = layoutChart(spec, { width: 600, height: 300 });
    expect(L.unitTitle).toBe('features');
    expect(L.ticks.every((t) => !t.label.includes('features'))).toBe(true);
  });
});

describe('whole numbers get whole ticks', () => {
  it('4, 8, 12, 6 features: 0, 2, 4 … — never 2.5, 7.5', () => {
    expect(niceStep(12, 5, true)).toBe(5);
    expect(niceStep(12, 5, false)).toBe(2.5);
    expect(niceStep(3, 5, true)).toBe(1);
    const L = layoutChart(
      normalizeChartSpec({ type: 'hbar', labels: 'a, b, c, d', values: '4, 8, 12, 6' }),
      { width: 600, height: 300 },
    );
    expect(L.ticks.every((t) => Number.isInteger(t.value))).toBe(true);
  });

  it('fractional data keeps its fine steps', () => {
    const L = layoutChart(normalizeChartSpec({ labels: 'a, b', values: '0.2, 0.9' }), {
      width: 600,
      height: 300,
    });
    expect(L.ticks.some((t) => !Number.isInteger(t.value))).toBe(true);
  });
});
