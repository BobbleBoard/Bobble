/**
 * A presented thing shown IN the thread — a chart's interactive card, a small
 * SVG — with the corner control that moves it to the canvas and back.
 *
 * the user (2026-09-16), Claude's inline chart beside Bobble's canvas picture:
 * "we need to implement a system of some items showing inline cards like
 * anthropic has here, while larger things go to the canvas still … a quick
 * button in the canvas and on the inline items to with a smooth animation
 * have an inline thing either resize and move over smoothly leaving the
 * inline chat to become the canvas and show there, or a tab in the canvas
 * dropping out and becoming an inline card."
 *
 * The card and its canvas tab are ONE thing: the tab's key is the card's, so
 * while the tab is open the card is NOT in the thread at all — the canvas tab
 * IS the card — and closing the tab (the tab's own Show-in-chat) brings it
 * back. It used to leave a one-line stub behind ("Units Sold by Year — in the
 * canvas · Show here"); with several charts up that was a stack of thin rows
 * saying the same thing, and the user (2026-09-17): "don't show the thin cards
 * that say 'showing charts in canvas' at all." The move either way runs
 * inside a view transition (view-transition.ts) under the shared name, so the
 * card grows into the panel and the panel shrinks back into the card.
 *
 * Nor a file name under the card: the chart's title is on it and the file is
 * the canvas tab's business ("don't show a little thing below it that say
 * the filename").
 */
import {
  ChartView,
  IconToCanvas,
  InlineWidget,
  inlineTransitionStyle,
  useCanvasTabs,
} from '@pi-desktop/canvas';
import { IconButton } from '@pi-desktop/ui';
import { type CSSProperties, useEffect, useState } from 'react';
import { useCanvasStore } from '../state/canvas-store';
import { openPresented, type PresentedRecord, presentTabKey } from '../state/present-store';
import { withViewTransition } from './canvas/view-transition';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * The app's mode as the theme sheet keys it (`data-mode` on the root), watched
 * — a diagram has a light and a dark drawing, and a theme switch swaps them
 * without a remount (the chart card reads the same attribute).
 */
function readDataMode(): 'light' | 'dark' {
  return typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-mode') === 'dark'
    ? 'dark'
    : 'light';
}

function useDataMode(): 'light' | 'dark' {
  const [mode, setMode] = useState(readDataMode);
  useEffect(() => {
    const mo = new MutationObserver(() => setMode(readDataMode()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    return () => mo.disconnect();
  }, []);
  return mode;
}

/** A diagram's head label: "Flowchart", "Sequence diagram". */
function kindLabel(kind: string): string {
  return kind === '' ? 'Diagram' : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

export function PresentedInline({ item }: { item: PresentedRecord }) {
  const { tabs, controller } = useCanvasTabs();
  const mode = useDataMode();
  const key = presentTabKey(item.path);
  const open = tabs.find((t) => t.key === key);
  const name =
    item.chart?.title !== undefined && item.chart.title !== ''
      ? item.chart.title
      : item.diagram?.title !== undefined && item.diagram.title !== ''
        ? item.diagram.title
        : baseName(item.path);

  const moveToCanvas = (): void => {
    withViewTransition(() => {
      void openPresented(controller as never, item);
      useCanvasStore.getState().setCanvasOpen(true);
    });
  };
  // In the canvas: the tab is the card. Nothing stands in for it here.
  if (open !== undefined) return null;

  const transition = inlineTransitionStyle(key) as CSSProperties;

  if (item.chart !== undefined) {
    return (
      <div className="flex flex-col gap-1" data-testid="presented-chart">
        <div className="pd-inline-chart" style={transition}>
          <ChartView
            spec={item.chart}
            corner={
              <IconButton
                className="pd-inline-chart-move"
                aria-label="Open in canvas"
                title="Open in canvas"
                data-testid="inline-chart-move"
                onClick={moveToCanvas}
              >
                <IconToCanvas size={16} />
              </IconButton>
            }
          />
        </div>
      </div>
    );
  }

  /*
   * A DIAGRAM (VQ-10): its drawing for the chat's theme, in the card every
   * other visual wears (the code block's frame, head and corner controls), on
   * the drawing's own paper so the card and the diagram are one surface. The
   * raw view is the Mermaid it was drawn from, and Copy copies that. Wide
   * drawings scale to the card; the canvas is where a big one is read.
   */
  if (item.diagram !== undefined) {
    const drawing = mode === 'dark' ? item.diagram.dark : item.diagram.light;
    const style = {
      ...transition,
      ...(drawing.paper !== undefined ? { '--pd-diagram-paper': drawing.paper } : {}),
    } as CSSProperties;
    return (
      <div
        className="flex flex-col gap-1 pd-inline-diagram"
        data-testid="presented-diagram"
        data-mode={mode}
        style={style}
      >
        <InlineWidget
          artifact={{
            id: key,
            title: name,
            filename: baseName(item.path),
            content: { kind: 'svg', text: drawing.svg },
          }}
          label={kindLabel(item.diagram.kind)}
          source={{ text: item.diagram.source }}
          maxHeight={560}
          onMoveToCanvas={moveToCanvas}
        />
      </div>
    );
  }

  const text = item.svg?.text ?? '';
  return (
    <div className="flex flex-col gap-1" data-testid="presented-svg" style={transition}>
      <InlineWidget
        artifact={{
          id: key,
          title: name,
          filename: baseName(item.path),
          content: { kind: 'svg', text },
        }}
        onMoveToCanvas={moveToCanvas}
      />
    </div>
  );
}
