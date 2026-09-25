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
  HtmlSurface,
  IconToCanvas,
  InlineWidget,
  inlineTransitionStyle,
  sanitizeSvg,
  useCanvasTabs,
} from '@pi-desktop/canvas';
import { IconButton, PresentCard, type PresentCardProps } from '@pi-desktop/ui';
import { type CSSProperties, useContext, useLayoutEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../state/canvas-store';
import {
  earlierVersion,
  openPresented,
  type PresentedRecord,
  presentTabKey,
  usePresentStore,
} from '../state/present-store';
import { useSvgLive } from '../state/svg-live';
import { withViewTransition } from './canvas/view-transition';
import { DiagramDrawing, useDataMode } from './DiagramDrawing';
import { firstArrival, hadLiveChart, liveFrameFor, PresentedCallContext } from './live-handover';
import { DIAGRAM_CARD_MAX_HEIGHT, kindLabel } from './PendingDiagramCard';

/** How tall a widget grows in the chat before its page scrolls inside. */
const WIDGET_CARD_MAX_HEIGHT = 560;

import { drawIn } from './svg-draw-in';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  );
}

/**
 * Whether this card was handed over just now (live-handover's firstArrival) —
 * read once, on mount, so a card builds in as it arrives and is simply there
 * when its chat is switched back to or it is scrolled back into being.
 */
export function useArrival(item: PresentedRecord): boolean {
  const [arriving] = useState(() =>
    firstArrival(
      `${presentTabKey(item.path)}|${item.afterMessageId ?? ''}|${item.at}`,
      item.shownAt,
    ),
  );
  return arriving;
}

/**
 * A file's card (a document, a folder — PresentCard) that comes up into place
 * when it is handed over, the inline canvas's fade and 6 px rise: the one
 * build a row with nothing to draw can have. Filmed 2026-09-25, the rest of
 * the chat's arrivals built themselves in and this one simply appeared.
 */
export function ArrivingPresentCard(props: PresentCardProps & { item: PresentedRecord }) {
  const arriving = useArrival(props.item);
  return <PresentCard {...props} {...(arriving ? { className: 'pd-arrive' } : {})} />;
}

/**
 * A small drawing in its card — the svg surface's own box, sanitised the same
 * way — that draws itself in on arrival (svg-draw-in.ts).
 */
function ArrivingSvg({ text, arrive }: { text: string; arrive: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef(false);
  useLayoutEffect(() => {
    const el = host.current;
    if (el === null) return;
    el.innerHTML = sanitizeSvg(text);
    const svg = el.querySelector('svg');
    if (arrive && !drawn.current && svg !== null && !prefersReducedMotion()) drawIn(svg);
    drawn.current = true;
  }, [text, arrive]);
  return <div ref={host} className="pd-canvas-svg pd-scroll" />;
}

export function PresentedInline({ item }: { item: PresentedRecord }) {
  const { tabs, controller } = useCanvasTabs();
  const mode = useDataMode();
  /* A card that takes over from its live card (live-handover.ts): a diagram
     starts from the live card's last frame and moves on from there; a chart
     does not grow its bars from the axis a second time, it only comes up out
     of the live card's dimmed build. Read once, on mount: a theme switch later
     swaps a diagram's drawing still. */
  const callId = useContext(PresentedCallContext);
  const key = presentTabKey(item.path);
  /* …and a card that ARRIVES without one builds itself in, once: a diagram
     moves on from the file's previous version (a diagram_edit a turn later)
     or, if it has none, builds from nothing; a small drawing draws itself in
     — unless the svg tool already drew it live (LiveSvgCard). A card scrolled
     back to, or brought back from a transcript, is simply there. */
  const arriving = useArrival(item);
  const [start] = useState(() => {
    if (item.diagram !== undefined) {
      const live = liveFrameFor(callId, mode);
      if (live !== null) return { from: live, buildIn: false, arriving };
      if (!arriving) return { from: null, buildIn: false, arriving };
      const earlier = earlierVersion(usePresentStore.getState(), item)?.diagram;
      const was =
        earlier === undefined ? null : mode === 'dark' ? earlier.dark.svg : earlier.light.svg;
      return { from: was, buildIn: was === null, arriving };
    }
    const drawnLive = useSvgLive.getState().outputs.some((o) => o.path === item.path);
    return { from: null, buildIn: false, arriving: arriving && !drawnLive };
  });
  const [tookOver] = useState(() => item.chart !== undefined && hadLiveChart(callId));
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
            enter={!tookOver}
            {...(tookOver ? { className: 'pd-chart--landed' } : {})}
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
          maxHeight={DIAGRAM_CARD_MAX_HEIGHT}
          onMoveToCanvas={moveToCanvas}
        >
          <DiagramDrawing
            svg={drawing.svg}
            from={start.from}
            buildIn={start.buildIn}
            version={`${item.diagram.title}\n${item.diagram.source}`}
          />
        </InlineWidget>
      </div>
    );
  }

  /*
   * AN INTERACTIVE WIDGET (html-widget.ts): the page runs in the chat's
   * sandboxed frame, as tall as it says up to a cap and scrolling inside past
   * it; the raw view is its HTML; the corner opens it in the canvas, where a
   * page has room.
   */
  if (item.html !== undefined) {
    return (
      <div className="flex flex-col gap-1" data-testid="presented-widget" style={transition}>
        <InlineWidget
          artifact={{
            id: key,
            title: item.html.title ?? name,
            filename: baseName(item.path),
            content: { kind: 'html', text: item.html.text },
          }}
          label="Interactive"
          source={{ text: item.html.text, language: 'html' }}
          maxHeight={WIDGET_CARD_MAX_HEIGHT + 64}
          onMoveToCanvas={moveToCanvas}
        >
          <HtmlSurface
            content={{ kind: 'html', text: item.html.text }}
            streaming={false}
            fitMax={WIDGET_CARD_MAX_HEIGHT}
          />
        </InlineWidget>
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
      >
        <ArrivingSvg text={text} arrive={start.arriving} />
      </InlineWidget>
    </div>
  );
}
