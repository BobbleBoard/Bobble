import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EffortSlider, pointerToIndex } from './effort-slider.tsx';

/**
 * EffortSlider (round-12 #6, restyled round-16): the pointer-drag math is pure +
 * tested directly; the presentational contract (the accent-lit header readout,
 * the "Faster"/"Smarter" flanks, the heat fill width, the Auto toggle state, and
 * the slider aria) is asserted through static markup so no DOM is needed.
 */
describe('pointerToIndex', () => {
  it('maps a 0..1 track fraction to the nearest of `steps` detents', () => {
    expect(pointerToIndex(0, 4)).toBe(0);
    expect(pointerToIndex(1, 4)).toBe(3);
    expect(pointerToIndex(0.5, 4)).toBe(2); // 1.5 → 2
    expect(pointerToIndex(0.33, 4)).toBe(1); // 0.99 → 1
    expect(pointerToIndex(0.66, 4)).toBe(2); // 1.98 → 2
  });

  it('clamps out-of-range + degenerate inputs to the ends / 0', () => {
    expect(pointerToIndex(-1, 4)).toBe(0);
    expect(pointerToIndex(2, 4)).toBe(3);
    expect(pointerToIndex(Number.NaN, 4)).toBe(0);
    expect(pointerToIndex(0.5, 1)).toBe(0);
    expect(pointerToIndex(0.5, 0)).toBe(0);
  });
});

describe('EffortSlider render', () => {
  it('auto mode: the header carries the accent readout, the Auto toggle is active, the fill follows the tier', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        steps={4}
        value={1}
        fill={1 / 3}
        auto
        label="Effort · Auto"
        valueText="Effort, Auto"
        onLevelChange={() => {}}
        onToggleAuto={() => {}}
        data-testid="fx"
      />,
    );
    expect(html).toContain('pd-effort-name'); // the accent-lit header readout
    expect(html).toContain('Effort · Auto'); // …carrying the label
    expect(html).toContain('pd-effort-help'); // the "?" help affordance
    expect(html).toContain('data-active=""'); // the switch is on
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    /*
     * AND NO SLIDER AT ALL. the user: the Auto toggle "just removes the slider while
     * toggled on". A slider that tracks the routed tier and refuses to be
     * dragged is a control lying about being one, so in Auto there is none —
     * which means no track, no thumb, no detents, and no end labels either.
     */
    expect(html).not.toContain('role="slider"');
    expect(html).not.toContain('pd-effort-track');
    expect(html).not.toContain('pd-effort-dot');
    expect(html).not.toContain('Faster');
    expect(html).not.toContain('Smarter');
  });

  it('level mode: the header shows the pinned level, the Auto toggle is an inactive reset, the fill is explicit', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        steps={4}
        value={3}
        fill={1}
        auto={false}
        label="Effort · Max"
        onLevelChange={() => {}}
        onToggleAuto={() => {}}
      />,
    );
    expect(html).toContain('pd-effort-name');
    expect(html).toContain('Effort · Max'); // the pinned level readout
    expect(html).toContain('>Auto<'); // the switch's label (autoLabel default)
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('data-active'); // the switch is off
    // The slider is back, with its end labels, because there is a level to set.
    expect(html).toContain('role="slider"');
    expect(html).toContain('Faster');
    expect(html).toContain('Smarter');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('--pd-effort-pos:1');
    // Every dot is behind the knob at Max, so every one is lit.
    expect(html.match(/data-on=""/g)?.length).toBe(4);
  });
});
