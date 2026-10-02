/**
 * What a presented file carries INTO the chat, so the thread can show the thing
 * itself rather than a card that points at the canvas.
 *
 * the user (2026-09-16), Claude's inline chart beside Bobble's canvas picture: "we
 * need to implement a system of some items showing inline cards like anthropic
 * has here, while larger things go to the canvas still … small svgs, but not
 * larger 'drawing' should be shown inline too". Two things qualify:
 *
 *   - a CHART: an .svg with the `chart` tool's (or the office pipeline's)
 *     `<stem>.chart.json` beside it — the spec is the interactive card, the SVG
 *     is the file on disk;
 *   - a SMALL SVG: its markup, when the drawing is icon-sized and its file is
 *     light enough to travel inline (a poster-sized illustration stays a
 *     canvas tab);
 *   - an INTERACTIVE WIDGET: a presented .html that is one self-contained
 *     file (it loads nothing of its own by a relative path), small, with
 *     something to interact with, and not a web page (no nav, no header and
 *     footer, not a stack of sections). the user (2026-09-24): "really clean,
 *     intuitive interactive widgets inline/+canvas, eg. for math explanation
 *     NN inner working visualizations". It runs in the chat's sandboxed frame;
 *     a site stays a canvas tab.
 *
 * Read here, in main, because the renderer has no file system of its own and
 * the present tool must stay electron-free. Pure over an injected reader so
 * the policy is unit-testable.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type DiagramCardPayload, readDiagramCard } from './diagram-card';
import { htmlWidget, type PresentedHtmlWidget } from './html-widget';

export { DIAGRAM_SIDECAR_SUFFIX, type DiagramCardPayload, readDiagramCard } from './diagram-card';

/** The spec beside a chart's SVG: `<stem>.svg` + `<stem>.chart.json`. */
export const CHART_SIDECAR_SUFFIX = '.chart.json';

/** An SVG travels inline up to this many bytes of markup. */
export const INLINE_SVG_MAX_BYTES = 64 * 1024;
/** …and up to this box (the larger of its width and height, in SVG units). */
export const INLINE_SVG_MAX_SIDE = 512;

export interface PresentedSvgInfo {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** The markup, when it is small enough to render inline. */
  readonly text?: string;
}

export interface PresentInlinePayload {
  /** The chart spec, parsed — the card renders from it. */
  chart?: Record<string, unknown>;
  /** A diagram's drawings and source — the card renders them. */
  diagram?: DiagramCardPayload;
  /** The SVG's size and, for a small one, its markup. */
  svg?: PresentedSvgInfo;
  /** An interactive widget's page — the card runs it. */
  html?: PresentedHtmlWidget;
}

export { htmlWidget, INLINE_HTML_MAX_BYTES, type PresentedHtmlWidget } from './html-widget';

/** width/height from the root element: attributes first, else the viewBox. */
export function svgSize(markup: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(markup);
  if (open === null) return null;
  const tag = open[0];
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}="\\s*([\\d.]+)\\s*(?:px)?\\s*"`, 'i').exec(tag);
    if (m === null) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const viewBox = /\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(tag);
  const vbW = viewBox !== null ? Number(viewBox[1]) : null;
  const vbH = viewBox !== null ? Number(viewBox[2]) : null;
  const width = attr('width') ?? (vbW !== null && Number.isFinite(vbW) && vbW > 0 ? vbW : null);
  const height = attr('height') ?? (vbH !== null && Number.isFinite(vbH) && vbH > 0 ? vbH : null);
  if (width === null || height === null) return null;
  return { width, height };
}

/** Icon-sized and light: the drawing belongs beside the words. */
export function svgIsInlineSized(info: { width: number; height: number; bytes: number }): boolean {
  return (
    info.bytes <= INLINE_SVG_MAX_BYTES && Math.max(info.width, info.height) <= INLINE_SVG_MAX_SIDE
  );
}

/**
 * The inline payload for a presented path, or `{}` for a file the card
 * describes and the canvas opens (a deck, a page, a photo).
 */
export async function presentInlinePayload(
  target: string,
  read: (p: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<PresentInlinePayload> {
  const out: PresentInlinePayload = {};
  const ext = path.extname(target).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    try {
      const widget = htmlWidget(await read(target));
      if (widget !== null) out.html = widget;
    } catch {
      /* unreadable: the card describes it and the canvas opens it */
    }
    if (out.html?.explanation === true) {
      // Its raw view is the spec it was drawn from, not 330 KB of page.
      try {
        out.html = {
          ...out.html,
          spec: await read(`${target.replace(/\.html?$/i, '')}.math.json`),
        };
      } catch {
        /* drawn from a spec passed inline: the page alone */
      }
    }
    return out;
  }
  if (ext === '.json' && target.endsWith(CHART_SIDECAR_SUFFIX)) {
    const chart = await readChart(target, read);
    if (chart !== null) out.chart = chart;
    return out;
  }
  if (ext !== '.svg') return out;
  const sidecar = `${target.slice(0, -4)}${CHART_SIDECAR_SUFFIX}`;
  const chart = await readChart(sidecar, read);
  if (chart !== null) out.chart = chart;
  let markup: string;
  try {
    markup = await read(target);
  } catch {
    return out;
  }
  // A diagram's card is its two drawings (the diagram tool's sidecar).
  if (chart === null) {
    const diagram = await readDiagramCard(target, markup, read);
    if (diagram !== null) {
      out.diagram = diagram;
      return out;
    }
  }
  const size = svgSize(markup);
  if (size === null) return out;
  const bytes = Buffer.byteLength(markup, 'utf8');
  const info = { ...size, bytes };
  // A chart's SVG is never inlined as markup — its card is the spec.
  out.svg = svgIsInlineSized(info) && chart === null ? { ...info, text: markup } : info;
  return out;
}

async function readChart(
  sidecar: string,
  read: (p: string) => Promise<string>,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await read(sidecar)) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
