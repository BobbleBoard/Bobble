/**
 * THE SIZE OF THE CHART FILE (VQ-02).
 *
 * The static SVG was 960×560 whatever it held and wherever it went: three bars
 * came out 3.5 in tall in a Word document, with ~8 pt labels, because a 960 px
 * picture set 6.5 in wide shrinks its 11 px type by half. A chart is made for a
 * place — the chat card, a document column, a slide, a square tile — and the
 * place decides the canvas and the type scale. A horizontal bar chart's height
 * follows its rows, so three bars are a short picture and thirty a tall one.
 *
 * The interactive card ignores all of this: it lays itself out at the width of
 * the thread. This is the file on disk, and what a deck or document embeds.
 */

import type { ChartSpec } from './spec.ts';

export type ChartSize = 'card' | 'doc' | 'slide' | 'square';

export const CHART_SIZE_NAMES: readonly ChartSize[] = ['card', 'doc', 'slide', 'square'];

export interface ChartCanvas {
  readonly width: number;
  readonly height: number;
  /** Type scale: 1 on screen and in a document, larger on a slide read across a room. */
  readonly text: number;
}

export const CHART_SIZES: Readonly<
  Record<ChartSize, ChartCanvas & { readonly about: string; readonly fixedHeight: boolean }>
> = {
  card: {
    width: 960,
    height: 560,
    text: 1,
    fixedHeight: false,
    about: 'the chat and web pages, 960×560',
  },
  doc: {
    width: 640,
    height: 400,
    text: 1,
    fixedHeight: false,
    about: 'a document column, 640×400',
  },
  slide: {
    width: 1280,
    height: 720,
    text: 1.5,
    fixedHeight: true,
    about: 'a 16:9 slide, 1280×720, type 1.5×',
  },
  square: {
    width: 800,
    height: 800,
    text: 1.2,
    fixedHeight: true,
    about: 'a square tile, 800×800',
  },
};

/** "Doc", "document", "A4 page" → doc; "16:9", "deck", "presentation" → slide; … */
export function chartSizeOf(v: unknown): ChartSize | undefined {
  if (typeof v !== 'string') return undefined;
  const k = v.trim().toLowerCase();
  if ((CHART_SIZE_NAMES as readonly string[]).includes(k)) return k as ChartSize;
  if (/^(document|docx?|page|report|word|pdf|a4|letter|column)$/.test(k)) return 'doc';
  if (/^(slides?|deck|pptx?|presentation|16:9|widescreen)$/.test(k)) return 'slide';
  if (/^(social|instagram|tile|1:1|thumbnail)$/.test(k)) return 'square';
  if (/^(chat|web|page-card|default|screen)$/.test(k)) return 'card';
  return undefined;
}

/**
 * The canvas a spec is drawn on: its size preset (card by default), with a
 * horizontal bar chart's height following its rows where the preset's height
 * is not fixed — about 36 px of row per category (× the type scale) plus the
 * title, legend, axis and note around them.
 */
export function chartCanvas(spec: ChartSpec): ChartCanvas {
  const preset = CHART_SIZES[spec.size ?? 'card'];
  if (spec.type !== 'hbar' || preset.fixedHeight) {
    return { width: preset.width, height: preset.height, text: preset.text };
  }
  const rows = Math.max(1, spec.series[0]?.points.length ?? 1);
  const seriesRows = Math.max(1, spec.series.length);
  const rowPx = (seriesRows > 1 ? 22 * seriesRows + 14 : 36) * preset.text;
  const chrome =
    (32 + // top pad
      (spec.title !== '' ? 22 : 0) +
      (spec.subtitle !== undefined ? 20 : 0) +
      14 + // gap under the heading
      (spec.series.length > 1 ? 22 : 0) + // legend
      30 + // the value axis
      (spec.note !== undefined ? 22 : 0) +
      32) * // bottom pad
    preset.text;
  const height = Math.round(Math.min(1600, Math.max(220, chrome + rows * rowPx)));
  return { width: preset.width, height, text: preset.text };
}
