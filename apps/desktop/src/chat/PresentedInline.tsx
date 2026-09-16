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
 * while the tab is open the card collapses to a stub ("Units Sold by Year —
 * in the canvas · Show here"), and closing the tab — from the stub, or from
 * the tab's own Show-in-chat — brings the card back. The move either way runs
 * inside a view transition (view-transition.ts) under the shared name, so the
 * card grows into the panel and the panel shrinks back into the card.
 */
import {
  ChartView,
  IconChart,
  IconExpand,
  IconInline,
  InlineWidget,
  inlineTransitionStyle,
  useCanvasTabs,
} from '@pi-desktop/canvas';
import { IconButton } from '@pi-desktop/ui';
import type { CSSProperties, ReactNode } from 'react';
import { useCanvasStore } from '../state/canvas-store';
import { openPresented, type PresentedRecord, presentTabKey } from '../state/present-store';
import { withViewTransition } from './canvas/view-transition';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** The row a card leaves behind while it is showing in the canvas. */
function InlineStub({
  icon,
  title,
  onShowHere,
}: {
  icon: ReactNode;
  title: string;
  onShowHere: () => void;
}) {
  return (
    <div className="pd-inline-stub" data-testid="inline-stub">
      <span className="pd-inline-stub-icon">{icon}</span>
      <span className="pd-inline-stub-title">{title}</span>
      <span className="pd-inline-stub-where">in the canvas</span>
      <button
        type="button"
        className="pd-btn pd-btn--secondary pd-btn--sm"
        data-testid="inline-stub-show"
        onClick={onShowHere}
      >
        <IconInline size={14} />
        Show here
      </button>
    </div>
  );
}

export function PresentedInline({ item }: { item: PresentedRecord }) {
  const { tabs, controller } = useCanvasTabs();
  const key = presentTabKey(item.path);
  const open = tabs.find((t) => t.key === key);
  const name =
    item.chart?.title !== undefined && item.chart.title !== ''
      ? item.chart.title
      : baseName(item.path);

  const moveToCanvas = (): void => {
    withViewTransition(() => {
      void openPresented(controller as never, item);
      useCanvasStore.getState().setCanvasOpen(true);
    });
  };
  const showHere = (): void => {
    if (open === undefined) return;
    withViewTransition(() => controller.closeTab(open.id));
  };
  const reveal = (): void => {
    void window.piDesktop.invoke('canvas:reveal', { path: item.path });
  };

  if (open !== undefined) {
    return (
      <InlineStub
        icon={item.chart !== undefined ? <IconChart size={14} /> : <IconExpand size={14} />}
        title={name}
        onShowHere={showHere}
      />
    );
  }

  const transition = inlineTransitionStyle(key) as CSSProperties;

  if (item.chart !== undefined) {
    return (
      <div className="flex flex-col gap-1" data-testid="presented-chart">
        <div className="pd-inline-chart" style={transition}>
          <ChartView
            spec={item.chart}
            corner={
              <IconButton
                size="sm"
                className="pd-inline-chart-move"
                aria-label="Open in canvas"
                title="Open in canvas"
                data-testid="inline-chart-move"
                onClick={moveToCanvas}
              >
                <IconExpand size={14} />
              </IconButton>
            }
          />
        </div>
        <div className="pd-inline-file">
          <button type="button" onClick={reveal} title={item.path}>
            {baseName(item.path)}
          </button>
        </div>
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
      <div className="pd-inline-file">
        <button type="button" onClick={reveal} title={item.path}>
          {baseName(item.path)}
        </button>
      </div>
    </div>
  );
}
