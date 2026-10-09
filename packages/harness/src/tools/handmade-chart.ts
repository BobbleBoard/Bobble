/**
 * A CHART DRAWN BY HAND WHILE `chart` IS ONE CALL AWAY.
 *
 * The user (2026-09-16): "we need parity on these datavisuals … it's a common use
 * case and very formulaic". The chart tool draws an interactive card in the
 * chat from the numbers. What a model does instead, MEASURED across the deep
 * tasks: paints the chart with image generation (caught in gen-tools), runs
 * the office pipeline for one picture, writes a matplotlib script into a
 * heredoc, or types the bars as `<rect>`s into a `.svg` by hand — each a
 * habit it brought with it, each slower and worse than the tool.
 *
 * Same shape as handmade-media.ts and handwritten-svg.ts: the refusal happens
 * at the moment of the action, names the command with the exact call, and has
 * an exit — the identical command or file again goes through, because a
 * plotting SCRIPT can be the thing the user asked for ("write me a script
 * that plots…"), and a fence that cannot be crossed is the wrong kind.
 *
 * Narrow on purpose: a plotting library imported AND a figure drawn or saved
 * (reading a CSV with pandas is not a chart), an SVG that has the anatomy of a
 * chart (several bars or a polyline AND numeric labels — a logo with three
 * rectangles is not one).
 */

const PLOT_LIBS = [
  /\bimport\s+matplotlib\b|\bfrom\s+matplotlib\b/,
  /\bimport\s+plotly\b|\bfrom\s+plotly\b/,
  /\bimport\s+seaborn\b|\bfrom\s+seaborn\b/,
  /\bimport\s+altair\b|\bfrom\s+altair\b/,
  /\bimport\s+bokeh\b|\bfrom\s+bokeh\b/,
  /\bimport\s+pygal\b|\bfrom\s+pygal\b/,
] as const;

/** …and it draws a figure, not merely imports the library. */
const DRAWS_FIGURE = [
  /\b(?:plt|ax|axes|sns|df|data|series)\s*\.\s*(?:bar|barh|plot|pie|scatter|hist|stackplot|fill_between|area|lineplot|barplot)\s*\(/,
  /\bpx\.(?:bar|line|pie|scatter|area|histogram)\s*\(/,
  /\bgo\.(?:Bar|Scatter|Pie|Figure)\s*\(/,
  /\.savefig\s*\(|\.write_image\s*\(|\.write_html\s*\(|\bplt\.show\s*\(/,
  /\balt\.Chart\s*\(/,
  /\bpygal\.(?:Bar|Line|Pie|HorizontalBar|StackedBar)\s*\(/,
] as const;

/** Installing the library is the first step of the same road. */
const INSTALLS_PLOT_LIB =
  /\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b[^\n|;&]*\b(matplotlib|plotly|seaborn|altair|bokeh|pygal)\b/i;

export type HandmadeChart = 'script' | 'svg';

/** Does this script draw a chart with a plotting library? */
export function isPlottingScript(content: string): boolean {
  if (INSTALLS_PLOT_LIB.test(content)) return true;
  if (!PLOT_LIBS.some((re) => re.test(content))) return false;
  return DRAWS_FIGURE.some((re) => re.test(content));
}

/**
 * Does this SVG markup have the anatomy of a chart? Several bars (or a
 * polyline / a path of L-segments) AND several numeric text labels — the
 * axis ticks and values a chart cannot do without and a drawing rarely has.
 */
export function looksLikeChartSvg(content: string): boolean {
  if (!/<svg[\s>]/i.test(content)) return false;
  const rects = (content.match(/<rect\b/gi) ?? []).length;
  const polyline =
    /<polyline\b/i.test(content) || /<path\b[^>]*\bd="[^"]*\bL\b[^"]*\bL\b/i.test(content);
  const circles = (content.match(/<circle\b/gi) ?? []).length;
  const numericLabels = (content.match(/<text\b[^>]*>\s*[$€£]?\d[\d,.]*%?\s*<\/text>/gi) ?? [])
    .length;
  const shapes = rects >= 3 || polyline || circles >= 4;
  return shapes && numericLabels >= 3;
}

export function isHandmadeChart(input: {
  path?: string;
  content: string;
  chartAvailable: boolean;
}): HandmadeChart | null {
  if (!input.chartAvailable) return null;
  if (input.path !== undefined && /\.svg$/i.test(input.path.trim())) {
    return looksLikeChartSvg(input.content) ? 'svg' : null;
  }
  return isPlottingScript(input.content) ? 'script' : null;
}

/**
 * The refusal: what this was, the command that does it, the exact shape, and
 * the exit for the case where the script or the markup is the deliverable.
 */
export function handmadeChartRefusal(
  what: HandmadeChart,
  opts: { cli: boolean; edit?: boolean; path?: string },
): string {
  const call = opts.cli
    ? 'chart bar "Units Sold by Year" --labels "2021, 2022, 2023, 2024" --values "12, 19, 15, 22"'
    : 'chart { type: "bar", title: "Units Sold by Year", labels: "2021, 2022, 2023, 2024", values: "12, 19, 15, 22" }';
  const was =
    what === 'script'
      ? 'this plots data with a plotting library'
      : `${opts.path ?? 'this file'} is a chart drawn by hand as SVG markup`;
  const verb = what === 'script' ? 'run' : opts.edit === true ? 'edited' : 'written';
  return [
    `Not ${verb}: ${was}, and this app draws charts itself — the \`chart\` tool puts an interactive chart (hover reads the values, chart/table toggle, Open in canvas) straight into the chat, in a second, with the numbers on the axes. Draw it with:`,
    `  ${call}`,
    'Types: bar, stacked, hbar, line, area, scatter, donut. Several series: --values "Revenue: 4, 5, 6; Cost: 3, 3, 4". Add --unit "$", --highlight "2024", --note "Source: …". It writes the .svg into the project too, for a page or a document.',
    '',
    what === 'script'
      ? 'If the user asked for the SCRIPT itself (code that plots, not a chart), run it again UNCHANGED.'
      : `If this exact markup is wanted as written, ${opts.edit === true ? 'apply the same edit' : 'write the same file'} again UNCHANGED.`,
  ].join('\n');
}
