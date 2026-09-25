/**
 * A diagram's drawing in its card — the live card's and the finished card's
 * alike — through DiagramMorph, so a new frame moves in instead of blinking.
 *
 * The host is the svg surface's own box (`pd-canvas-svg`), sanitised the same
 * way (sanitizeSvg), so the drawing sits in a diagram card exactly as the
 * registry's svg surface would have put it: the finished card that takes
 * over from a live one lays the same picture out to the same pixel.
 */
import { sanitizeSvg } from '@pi-desktop/canvas';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DiagramMorph } from './diagram-morph';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  );
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

export function useDataMode(): 'light' | 'dark' {
  const [mode, setMode] = useState(readDataMode);
  useEffect(() => {
    const mo = new MutationObserver(() => setMode(readDataMode()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    return () => mo.disconnect();
  }, []);
  return mode;
}

export function DiagramDrawing({
  svg,
  live = false,
  from = null,
}: {
  /** The frame to show; null before the first. */
  svg: string | null;
  /**
   * A live card: every frame moves into the next, the first builds in. A
   * finished card is still — a theme switch just swaps its drawing — unless
   * it starts `from` a live card's last frame, which it moves on from.
   */
  live?: boolean;
  from?: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const morph = useRef<DiagramMorph | null>(null);
  const first = useRef(true);
  // The morph lives as long as the card; `from` is where it starts, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mounted once, by design
  useLayoutEffect(() => {
    const el = host.current;
    if (el === null) return undefined;
    const m = new DiagramMorph(el, { sanitize: sanitizeSvg, reducedMotion: prefersReducedMotion });
    morph.current = m;
    if (from !== null) m.show(from, false);
    return () => {
      m.dispose();
      morph.current = null;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new frame is the only thing that moves it
  useLayoutEffect(() => {
    const m = morph.current;
    if (m === null || svg === null) return;
    const isFirst = first.current;
    first.current = false;
    m.show(svg, live || (isFirst && from !== null));
  }, [svg]);
  return <div ref={host} className="pd-canvas-svg pd-scroll" data-testid="diagram-drawing" />;
}
