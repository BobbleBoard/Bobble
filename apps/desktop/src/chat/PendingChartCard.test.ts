import { describe, expect, it } from 'vitest';
import { pendingChartArgs, pendingChartSpec, skeletonShape } from './PendingChartCard';

/*
 * the user (2026-09-17): "when a chart is generating show a skeleton card with
 * shimmering items as a preview that builds live". The card is drawn from
 * the call's own arguments as they stream — native or CLI.
 */
describe('pendingChartArgs — what a chart call has said so far', () => {
  it('reads the closed keys out of a streaming native call', () => {
    expect(
      pendingChartArgs({ name: 'chart', arguments: {}, argsText: '{"type": "bar", "title": "Un' }),
    ).toEqual({ type: 'bar', title: 'Un' });
    expect(
      pendingChartArgs({
        name: 'chart',
        arguments: {},
        argsText: '{"type": "line", "title": "Signups", "labels": "Jan, Feb", "values": "120, 1',
      }),
    ).toEqual({ type: 'line', title: 'Signups', labels: 'Jan, Feb', values: '120, 1' });
    expect(pendingChartArgs({ name: 'chart', arguments: {}, argsText: '{"ty' })).toBeNull();
  });

  it('reads the finalised arguments, and the CLI form through bash', () => {
    expect(
      pendingChartArgs({
        name: 'chart',
        arguments: { type: 'donut', title: 'Share', labels: 'A, B', values: '1, 2' },
      }),
    ).toEqual({ type: 'donut', title: 'Share', labels: 'A, B', values: '1, 2' });
    expect(
      pendingChartArgs({
        name: 'bash',
        arguments: { command: 'chart bar "Units Sold" --labels "2021, 2022" --values "12, 19"' },
      }),
    ).toEqual({ type: 'bar', title: 'Units Sold', labels: '2021, 2022', values: '12, 19' });
    expect(
      pendingChartArgs({
        name: 'bash',
        arguments: {},
        argsText:
          '{"command": "chart --type=radar --title=\\"Profile\\" --labels=\\"a, b, c\\" --val',
      }),
    ).toEqual({ type: 'radar', title: 'Profile', labels: 'a, b, c' });
    expect(pendingChartArgs({ name: 'bash', arguments: { command: 'ls -la' } })).toBeNull();
    expect(
      pendingChartArgs({
        name: 'bash',
        arguments: { command: 'chart edit units.svg --look soft' },
      }),
    ).toBeNull();
  });
});

describe('pendingChartSpec — the chart those arguments already describe', () => {
  it('draws once there are labels and at least one value, and not before', () => {
    expect(pendingChartSpec({ type: 'bar', title: 'T', labels: 'a, b' })).toBeNull();
    const spec = pendingChartSpec({ type: 'bar', title: 'T', labels: 'a, b, c', values: '1, 2' });
    expect(spec?.type).toBe('bar');
    // The label whose value has not arrived stands at zero until it does.
    expect(spec?.series[0]?.points.map((p) => p.value)).toEqual([1, 2, 0]);
    // A half-typed number is a number so far: the bar is drawn and grows.
    expect(pendingChartSpec({ labels: 'a', values: '1' })?.series[0]?.points[0]?.value).toBe(1);
  });
});

describe('skeletonShape — the placeholder for a type word still being typed', () => {
  it('picks the shape from the first letters', () => {
    expect(skeletonShape('bar')).toBe('bars');
    expect(skeletonShape('hbar')).toBe('hbars');
    expect(skeletonShape('lin')).toBe('line');
    expect(skeletonShape('area')).toBe('line');
    expect(skeletonShape('pie')).toBe('ring');
    expect(skeletonShape('donut')).toBe('ring');
    expect(skeletonShape('rad')).toBe('web');
    expect(skeletonShape('scatter')).toBe('dots');
    expect(skeletonShape(undefined)).toBe('bars');
  });
});
