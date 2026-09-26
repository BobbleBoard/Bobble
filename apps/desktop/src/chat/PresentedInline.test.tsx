// @vitest-environment jsdom
/**
 * The inline chart card and its canvas twin are ONE thing: the card's corner
 * control lifts it into a chart tab and leaves nothing behind; the tab's own
 * Show-in-chat closes the tab and the card is back.
 */
import { CanvasProvider, createCanvasController } from '@pi-desktop/canvas';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../state/canvas-store';
import { presentedFor, presentTabKey, UNSAVED_CHAT, usePresentStore } from '../state/present-store';
import { PresentedInline } from './PresentedInline';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function render(
  node: ReactNode,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(el: Element | null): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('element not found');
  await act(async () => {
    el.click();
  });
}

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
  (window as unknown as { piDesktop: unknown }).piDesktop = {
    invoke: vi.fn(async () => ({})),
  };
  usePresentStore.getState().clear();
  useCanvasStore.getState().setCanvasOpen(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDesc);
  if (heightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', heightDesc);
});

const RAW = {
  type: 'bar',
  title: 'Units Sold by Year',
  labels: ['2021', '2022', '2023', '2024'],
  values: [12, 19, 15, 22],
};

describe('PresentedInline', () => {
  it('renders the chart card in the thread, lifts it to a chart tab, and brings it back', async () => {
    usePresentStore.getState().add({ path: '/ws/units.svg', chart: RAW });
    const [item] = presentedFor(usePresentStore.getState(), UNSAVED_CHAT);
    if (item === undefined) throw new Error('no record');
    const controller = createCanvasController();
    const { container } = await render(
      <CanvasProvider controller={controller}>
        <PresentedInline item={item} />
      </CanvasProvider>,
    );
    // The card: title, bars, the corner control beside the chart/table toggle.
    expect(container.querySelector('[data-testid="presented-chart"]')).not.toBeNull();
    expect(container.querySelector('.pd-chart-title')?.textContent).toBe('Units Sold by Year');
    expect(container.querySelectorAll('.pd-chart-bar').length).toBe(4);
    expect(container.querySelector('[data-testid="inline-stub"]')).toBeNull();
    // Named for the view transition.
    const card = container.querySelector('.pd-inline-chart') as HTMLElement;
    expect(card.style.getPropertyValue('view-transition-name')).toMatch(/^pd-inline-/);

    // No file name under the card (the user: "don't show a little thing below it
    // that say the filename").
    expect(container.querySelector('.pd-inline-file')).toBeNull();
    expect(container.textContent).not.toContain('units.svg');

    // Corner → the canvas: a chart tab keyed as the card, the panel opened, and
    // NOTHING left in the thread — no stub row (the user: "don't show the thin
    // cards that say 'showing charts in canvas' at all").
    await click(container.querySelector('[data-testid="inline-chart-move"]'));
    const tab = controller.getState().tabs.find((t) => t.key === presentTabKey('/ws/units.svg'));
    expect(tab).toMatchObject({ kind: 'chart', inline: true, filePath: '/ws/units.svg' });
    expect(useCanvasStore.getState().canvasOpen).toBe(true);
    expect(container.querySelector('[data-testid="inline-stub"]')).toBeNull();
    expect(container.querySelector('.pd-chart-bar')).toBeNull();
    expect(container.textContent).toBe('');

    // The tab's Show-in-chat (closing the tab) → the card is back where it was.
    await act(async () => {
      controller.closeTab(tab?.id ?? '');
    });
    expect(controller.getState().tabs).toHaveLength(0);
    expect(container.querySelectorAll('.pd-chart-bar').length).toBe(4);
  });

  it('a small SVG renders inline as a widget with the same move-over', async () => {
    usePresentStore.getState().add({
      path: '/ws/icon.svg',
      svg: { width: 64, height: 64, bytes: 80, text: '<svg><circle r="4"/></svg>' },
    });
    const [item] = presentedFor(usePresentStore.getState(), UNSAVED_CHAT);
    if (item === undefined) throw new Error('no record');
    const controller = createCanvasController();
    const { container } = await render(
      <CanvasProvider controller={controller}>
        <PresentedInline item={item} />
      </CanvasProvider>,
    );
    expect(container.querySelector('[data-testid="inline-widget"]')).not.toBeNull();
    await click(container.querySelector('.pd-inline-widget-move'));
    expect(controller.getState().tabs[0]).toMatchObject({ kind: 'svg', inline: true });
    expect(container.querySelector('[data-testid="inline-stub"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  /*
   * VQ-10: a diagram card — the drawing for the chat's theme, on its own
   * paper, named for what it is, with its Mermaid as the raw view — and the
   * same move to the canvas as every other card.
   */
  it('a diagram renders its drawing for the theme, its kind, its source, and moves to the canvas', async () => {
    usePresentStore.getState().add({
      path: '/ws/flow.svg',
      diagram: {
        title: 'Order fulfilment',
        kind: 'flowchart',
        kit: 'paper-blue',
        source: 'flowchart LR\n  A([Order placed]) --> B{Payment ok?}',
        light: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text>light</text></svg>',
          width: 40,
          height: 20,
          paper: '#FBFAF7',
        },
        dark: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text>dark</text></svg>',
          width: 40,
          height: 20,
          paper: '#191816',
        },
      },
    });
    const [item] = presentedFor(usePresentStore.getState(), UNSAVED_CHAT);
    if (item === undefined) throw new Error('no record');
    const controller = createCanvasController();
    const { container } = await render(
      <CanvasProvider controller={controller}>
        <PresentedInline item={item} />
      </CanvasProvider>,
    );
    const card = container.querySelector('[data-testid="presented-diagram"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.style.getPropertyValue('--pd-diagram-paper')).toBe('#FBFAF7');
    expect(card.style.getPropertyValue('view-transition-name')).toMatch(/^pd-inline-/);
    expect(container.querySelector('.pd-inline-widget-kind')?.textContent).toBe('Flowchart');
    expect(container.querySelector('.pd-inline-widget-box svg text')?.textContent).toBe('light');
    // The theme flips: the other drawing, the other paper.
    await act(async () => {
      document.documentElement.setAttribute('data-mode', 'dark');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('.pd-inline-widget-box svg text')?.textContent).toBe('dark');
    expect(
      (
        container.querySelector('[data-testid="presented-diagram"]') as HTMLElement
      ).style.getPropertyValue('--pd-diagram-paper'),
    ).toBe('#191816');
    document.documentElement.removeAttribute('data-mode');
    // Raw is the Mermaid it was drawn from.
    await click(container.querySelector('[aria-label="Raw"]'));
    expect(container.querySelector('.pd-inline-widget-raw')?.textContent).toContain(
      'A([Order placed])',
    );
    // …and the corner lifts it into the canvas as its drawing.
    await click(container.querySelector('.pd-inline-widget-move'));
    expect(controller.getState().tabs[0]).toMatchObject({
      kind: 'svg',
      inline: true,
      title: 'Order fulfilment',
      filePath: '/ws/flow.svg',
    });
    expect(container.textContent).toBe('');
  });
});
