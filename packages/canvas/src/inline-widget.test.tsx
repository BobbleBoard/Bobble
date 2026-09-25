import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InlineWidget, shouldGoToCanvas } from './inline-widget.tsx';
import type { Artifact } from './model.ts';
import { click, render } from './test-utils.tsx';

const svg: Artifact = { id: 'w', content: { kind: 'svg', text: '<svg></svg>' } };

describe('shouldGoToCanvas', () => {
  it('sends non-simple kinds to the canvas', () => {
    expect(shouldGoToCanvas({ id: 'a', content: { kind: 'pdf', text: '' } })).toBe(true);
    expect(shouldGoToCanvas({ id: 'a', content: { kind: 'code', text: 'x' } })).toBe(true);
  });
  it('keeps small svg/html inline but sends oversized ones to the canvas', () => {
    expect(shouldGoToCanvas(svg)).toBe(false);
    const big: Artifact = { id: 'b', content: { kind: 'html', text: 'x'.repeat(5000) } };
    expect(shouldGoToCanvas(big)).toBe(true);
    expect(shouldGoToCanvas(big, { maxInlineChars: 10000 })).toBe(false);
  });
});

describe('InlineWidget', () => {
  it('emits onMoveToCanvas from the move button', async () => {
    const onMoveToCanvas = vi.fn();
    const { container } = await render(
      <InlineWidget artifact={svg} onMoveToCanvas={onMoveToCanvas}>
        <div>widget</div>
      </InlineWidget>,
    );
    await click(container.querySelector('[aria-label="Open in canvas"]'));
    expect(onMoveToCanvas).toHaveBeenCalledWith(svg);
  });

  it('wears the card head: the kind at the left, rendered ⇄ raw, copy and the way out at the right', async () => {
    // the user (2026-09-17, with a reference): "type in top left and copy in top right".
    const { container } = await render(<InlineWidget artifact={svg} />);
    expect(container.querySelector('.pd-inline-widget-kind')?.textContent).toBe('svg');
    const toggle = container.querySelectorAll('.pd-inline-widget-toggle-btn');
    expect(toggle.length).toBe(2);
    expect(container.querySelector('[aria-label="Copy"]')).not.toBeNull();
    expect(container.querySelector('.pd-inline-widget')?.getAttribute('data-view')).toBe(
      'rendered',
    );
    await click(toggle[1] ?? null);
    expect(container.querySelector('.pd-inline-widget')?.getAttribute('data-view')).toBe('raw');
    expect(container.querySelector('.pd-inline-widget-raw')).not.toBeNull();
  });

  it('names the thing and shows its own source as raw when given one (a diagram: "Flowchart", its Mermaid)', async () => {
    const { container } = await render(
      <InlineWidget
        artifact={svg}
        label="Flowchart"
        source={{ text: 'flowchart TD\n  A --> B' }}
      />,
    );
    expect(container.querySelector('.pd-inline-widget-kind')?.textContent).toBe('Flowchart');
    await click(container.querySelector('[aria-label="Raw"]'));
    expect(container.querySelector('.pd-inline-widget-raw')?.textContent).toBe(
      'flowchart TD\n  A --> B',
    );
  });

  it('raw wins over a custom body when the toggle asks for it', async () => {
    const { container } = await render(
      <InlineWidget artifact={svg} source={{ text: 'the source' }}>
        <div className="custom">drawing</div>
      </InlineWidget>,
    );
    expect(container.querySelector('.custom')).not.toBeNull();
    await click(container.querySelector('[aria-label="Raw"]'));
    expect(container.querySelector('.custom')).toBeNull();
    expect(container.querySelector('.pd-inline-widget-raw')?.textContent).toBe('the source');
  });

  it('is size-capped and never scrollable', async () => {
    const { container } = await render(
      <InlineWidget artifact={svg} maxHeight={200}>
        <div>widget</div>
      </InlineWidget>,
    );
    const box = container.querySelector<HTMLElement>('.pd-inline-widget-box');
    expect(box?.style.maxHeight).toBe('200px');
    expect(box?.style.overflow).toBe('hidden');
  });

  it('surfaces an "Open in canvas" affordance instead of scrolling when overflowing', async () => {
    const onMoveToCanvas = vi.fn();
    const { container } = await render(
      <InlineWidget artifact={svg} maxHeight={200} onMoveToCanvas={onMoveToCanvas}>
        <div>tall widget</div>
      </InlineWidget>,
    );
    const box = container.querySelector<HTMLElement>('.pd-inline-widget-box');
    if (!box) throw new Error('missing box');
    // Simulate content taller than the cap (jsdom has zero layout by default).
    Object.defineProperty(box, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    const open = container.querySelector('.pd-inline-widget-open');
    expect(open).toBeTruthy();
    await click(open);
    expect(onMoveToCanvas).toHaveBeenCalledWith(svg);
  });
});
