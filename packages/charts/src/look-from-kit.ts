/**
 * A CHART IN A KIT'S CLOTHES (VQ-04).
 *
 * The research found a deck, its charts and its title card dressed by three
 * unrelated systems (visual-quality.md D29: "The chart tool's look and the
 * document's font are unrelated unless set by hand"). A design kit
 * (@pi-desktop/design-kit) is the one system; this reads the part a chart
 * needs — the series colours, the highlight, the typeface family and the
 * geometry knobs — into a ChartStyle every renderer here already understands.
 *
 * The kit is read by SHAPE, not imported: design-kit validates its colours
 * with this package's palette checks, so a dependency back from here would be
 * a cycle. Any object with these fields is a kit to a chart.
 *
 * Both modes come along: the light colours are the chart's palette, and the
 * kit's own dark steps ride in `dark`, so a kit chart in a dark chat wears the
 * colours the kit validated for a dark ground — not the light ones lifted by
 * formula (resolveStyle, style.ts).
 */
import {
  type ChartStyle,
  type FontChoice,
  type GridMode,
  type LineStyle,
  lookByName,
} from './style.ts';

/** The colours of one kit mode that a chart reads. */
export interface KitChartColours {
  readonly series: readonly string[];
  readonly highlight: string;
}

/** A design kit as far as a chart is concerned. */
export interface KitForChart {
  readonly id: string;
  readonly light: KitChartColours;
  readonly dark: KitChartColours;
  readonly chart: {
    readonly base: string;
    readonly radius: number | 'pill';
    readonly grid: GridMode;
    readonly line: LineStyle;
    readonly font: FontChoice;
  };
}

/**
 * The style a chart takes from a kit: the kit's base look for the geometry
 * nobody set, and the kit's colours, typeface family and knobs over it. The
 * caller merges the model's own knobs on top — a chart that names `--accent
 * coral` in a teal project still gets coral.
 */
export function lookFromKit(kit: KitForChart): ChartStyle {
  const base = lookByName(kit.chart.base)?.name ?? 'clean';
  return {
    look: base,
    palette: [...kit.light.series],
    accent: kit.light.highlight,
    dark: { palette: [...kit.dark.series], accent: kit.dark.highlight },
    radius: kit.chart.radius,
    grid: kit.chart.grid,
    line: kit.chart.line,
    font: kit.chart.font,
    kit: kit.id,
  };
}

/**
 * A chart's own knobs over the kit's style. A LOOK named for the chart
 * replaces the kit outright — "make it sunset" means sunset's colours, not
 * sunset's corners in the kit's teal. A colour set by hand — a palette, an
 * accent — replaces the kit's colours in BOTH modes: the kit's dark steps were
 * made for the kit's colours, so they go too (and the chart no longer says it
 * is dressed in the kit). Anything else (a radius, a grid) just sits on top.
 */
export function dressInKit(kitStyle: ChartStyle, own: ChartStyle | undefined): ChartStyle {
  if (own === undefined) return kitStyle;
  if (own.look !== undefined && own.look !== kitStyle.look) return own;
  const merged: ChartStyle = { ...kitStyle, ...own };
  if (own.palette === undefined && own.accent === undefined) return merged;
  const { dark: _dark, kit: _kit, ...rest } = merged;
  return rest;
}
