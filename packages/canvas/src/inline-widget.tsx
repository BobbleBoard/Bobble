import { normalizeChartSpec, pointCount } from '@pi-desktop/charts';
import {
  highlightCode,
  IconButton,
  IconCheck,
  IconCode,
  IconCopy,
  IconEye,
  useCopyFeedback,
} from '@pi-desktop/ui';
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Artifact } from './model.ts';
import { defaultSurfaceRegistry, type SurfaceRegistry } from './registry.ts';
import { ensureDefaultSurfaces } from './surfaces/register-builtins.tsx';
import { IconToCanvas } from './tab-icons.tsx';

/** Kinds that MAY live inline in the chat when small (everything else → canvas). */
const INLINE_ELIGIBLE_KINDS = new Set(['svg', 'html', 'widget', 'chart']);
/** A chart stays inline up to this many points; a wider dataset opens beside the chat. */
const MAX_INLINE_CHART_POINTS = 60;
/** Default char budget before an inline-eligible artifact is pushed to canvas. */
const DEFAULT_MAX_INLINE_CHARS = 2000;

export interface ShouldGoToCanvasOptions {
  /** Character budget for an inline-eligible artifact before it moves to canvas. */
  maxInlineChars?: number;
}

/**
 * `shouldGoToCanvas` — the inline-vs-canvas routing helper (THEME 2). Returns
 * `true` for anything that belongs in the canvas: any non-simple kind, or a
 * simple svg/html/widget whose content exceeds the inline size budget. The app
 * calls this to decide whether to render an `InlineWidget` in the thread or to
 * `openTab` a canvas surface.
 */
export function shouldGoToCanvas(
  artifact: Artifact,
  options: ShouldGoToCanvasOptions = {},
): boolean {
  const max = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  if (!INLINE_ELIGIBLE_KINDS.has(artifact.content.kind)) return true;
  if (artifact.content.kind === 'chart') {
    // The spec's size is not the picture's: judge a chart by its points.
    try {
      return (
        pointCount(normalizeChartSpec(JSON.parse(artifact.content.text))) > MAX_INLINE_CHART_POINTS
      );
    } catch {
      return true;
    }
  }
  return (artifact.content.text?.length ?? 0) > max;
}

export interface InlineWidgetProps {
  artifact: Artifact;
  /** Registry used to render the resolved surface (svg/html); default process-wide. */
  registry?: SurfaceRegistry;
  /** Height cap in px. Content beyond is NOT scrolled — the overflow affordance shows. */
  maxHeight?: number;
  /**
   * Emitted by the always-present "Move to canvas" button AND the overflow
   * "Open in canvas" affordance — the app opens the artifact as a NEW canvas tab.
   */
  onMoveToCanvas?: (artifact: Artifact) => void;
  /** Custom widget to render instead of the registry-resolved surface. */
  children?: ReactNode;
  className?: string;
  /**
   * The head's name for the thing, when the content kind's is not it — a
   * diagram is drawn as `svg` but is a "flowchart".
   */
  label?: string;
  /**
   * What the raw view shows and Copy copies, when that is not the rendered
   * content's own text: a diagram's Mermaid, not the SVG it was drawn into
   * (VQ-10). Its presence also turns the rendered ⇄ raw toggle on.
   */
  source?: { text: string; language?: string };
}

/**
 * InlineWidget — the size-capped, NEVER-scrollable chat wrapper for simple
 * widgets (small svg/html). It caps height with `overflow: hidden` (no
 * scrollbar, ever); when the content overflows the cap it fades the bottom and
 * surfaces an "Open in canvas" button instead of scrolling. A "Move to canvas"
 * button is always present. Both emit `onMoveToCanvas(artifact)`.
 */
export function InlineWidget({
  artifact,
  registry,
  maxHeight = 320,
  onMoveToCanvas,
  children,
  className,
  label,
  source,
}: InlineWidgetProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  if (!registry) ensureDefaultSurfaces();
  const activeRegistry = registry ?? defaultSurfaceRegistry;

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    // overflow:hidden means scrollHeight is the full content height; clientHeight
    // is the capped box — taller content is what we must NOT scroll.
    setOverflowing(box.scrollHeight > box.clientHeight + 1);
  }, []);

  useLayoutEffect(() => {
    measure();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      if (boxRef.current) observer.observe(boxRef.current);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  /*
   * THE CARD'S HEAD — the reference the user sent (2026-09-17): the type at the
   * top left; at the top right a rendered ⇄ raw toggle when the kind can be
   * read either way, the copy, and the way out to the canvas. All visible at
   * rest (the expand used to appear on hover, and the card had no name).
   */
  const kind = artifact.content.kind;
  const toggles = kind === 'svg' || kind === 'html' || source !== undefined;
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const { copied, copy } = useCopyFeedback();
  const rawText = source?.text ?? artifact.content.text;
  const rawLanguage = source !== undefined ? (source.language ?? 'plaintext') : kind;
  const raw = useMemo(
    () => (toggles && view === 'raw' ? highlightCode(rawText, rawLanguage) : null),
    [toggles, view, rawText, rawLanguage],
  );

  // The raw view wins over a custom body too — it is what the toggle asked for.
  let body: ReactNode = raw === null ? children : undefined;
  if (body === undefined && raw !== null) {
    body = (
      <pre className="pd-inline-widget-raw pd-scroll">
        <code
          className="hljs"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output — the source is escaped, the only markup is its class spans
          dangerouslySetInnerHTML={{ __html: raw.html }}
        />
      </pre>
    );
  }
  if (body === undefined) {
    const resolved = activeRegistry.resolve(artifact);
    if (resolved) {
      const Surface = resolved.component;
      body = <Surface content={artifact.content} streaming={false} />;
    }
  }

  const rootClass = ['pd-inline-widget', className].filter(Boolean).join(' ');
  return (
    <div
      className={rootClass}
      data-overflowing={overflowing || undefined}
      data-kind={kind}
      data-view={toggles ? view : undefined}
      data-testid="inline-widget"
    >
      {kind === 'chart' ? null : (
        <div className="pd-inline-widget-head">
          <span className="pd-inline-widget-kind">{label ?? kind}</span>
          <span className="pd-inline-widget-actions">
            {toggles ? (
              <span className="pd-inline-widget-toggle">
                <button
                  type="button"
                  className="pd-inline-widget-toggle-btn pd-focusable"
                  aria-pressed={view === 'rendered'}
                  aria-label="Rendered"
                  title="Rendered"
                  onClick={() => setView('rendered')}
                >
                  <IconEye size={16} />
                </button>
                <button
                  type="button"
                  className="pd-inline-widget-toggle-btn pd-focusable"
                  aria-pressed={view === 'raw'}
                  aria-label="Raw"
                  title="Raw"
                  onClick={() => setView('raw')}
                >
                  <IconCode size={16} />
                </button>
              </span>
            ) : null}
            {/* the user (2026-09-21): "top right buttons on inline blocks sizes
                need to be increased" — the controls are the default 28px
                square with 16px glyphs now, not the 26px/14px small pair. */}
            <IconButton
              className="pd-inline-widget-copy"
              aria-label={copied ? 'Copied' : 'Copy'}
              title={copied ? 'Copied' : 'Copy'}
              onClick={() => copy(rawText)}
            >
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </IconButton>
            <IconButton
              className="pd-inline-widget-move"
              aria-label="Open in canvas"
              title="Open in canvas"
              onClick={() => onMoveToCanvas?.(artifact)}
            >
              <IconToCanvas size={16} />
            </IconButton>
          </span>
        </div>
      )}
      <div ref={boxRef} className="pd-inline-widget-box" style={{ maxHeight, overflow: 'hidden' }}>
        {body}
      </div>
      {overflowing ? (
        <div className="pd-inline-widget-overflow">
          <button
            type="button"
            className="pd-btn pd-btn--secondary pd-btn--sm pd-inline-widget-open"
            onClick={() => onMoveToCanvas?.(artifact)}
          >
            Open in canvas
          </button>
        </div>
      ) : null}
    </div>
  );
}
