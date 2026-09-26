/**
 * `chart` — a data visual, drawn in the chat in a second — and `chart_edit`,
 * the same chart changed.
 *
 * the user (2026-09-16), with Claude's inline bar chart beside the one Bobble made
 * through the office pipeline: "this was way quicker and is a much stronger
 * result from claude here, we need parity on these datavisuals, it's a common
 * use case and very formulaic and doable … not just bar charts, all
 * datavisuals". Claude's is an interactive card in the thread — hover a bar
 * and the value reads out, a chart ⇄ table toggle in the corner, one line of
 * insight under it. Bobble's was a 15-second pipeline run through a second
 * model that turned a brief back into numbers, and a static picture on the
 * canvas.
 *
 * The formula is the whole point: the model already HAS the numbers, so the
 * tool takes them flat — a type, a title, the labels, the values — and draws.
 * No second model, no brief, nothing invented. It writes the spec beside a
 * static SVG of the same layout (`@pi-desktop/charts`, the one renderer the
 * chat card and the file share), and presents the SVG; the app reads the spec
 * beside it and renders the interactive card inline, with an Open-in-canvas
 * corner for the larger view.
 *
 *   chart bar "Units Sold by Year" --labels "2021, 2022, 2023, 2024" --values "12, 19, 15, 22"
 *
 * is the whole call. Then the user, seeing the first ones: "square not rounded
 * looks bad. can it style them on its own? … we CANNOT have 'all charts from
 * bobble look the same generic'" and "say the user asks for edits to the
 * chart in any way, eg. color, thinning bars, adding a second bar for each
 * year … it all needs to work. styling from image etc." So:
 *
 *   - every chart has a LOOK (style.ts in @pi-desktop/charts): the model
 *     names one (`--look editorial`) or sets the knobs (`--palette`,
 *     `--accent coral`, `--radius pill`, `--bars thin`, `--grid none`,
 *     `--line smooth`, `--font serif`), and a chart that names none gets one
 *     picked from its title — a rotation through the everyday looks, so the
 *     charts in one conversation differ on their own;
 *   - `--from_image photo.png` reads the picture's colours (and its ground)
 *     into the chart's palette;
 *   - `chart edit <file> …` changes a chart that exists — its data (`--add
 *     "Cost: 8, 12, 10, 14"`, `--set "2023: 17"`, `--remove Cost`,
 *     `--values …`), its words, its look — and redraws it in place.
 *
 * `office make chart` stays for a chart inside a document flow; this is the
 * chart the chat asks for.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  ACCEPTED_NUMBER_FORMS,
  CHART_SIZE_NAMES,
  CHART_SIZES,
  CHART_TYPES,
  ChartDataError,
  type ChartSpec,
  type ChartStyle,
  type ChartType,
  chartCanvas,
  chartToElements,
  chartToSvg,
  coerceChartForm,
  dressInKit,
  formatValue,
  type KitForChart,
  LOOK_NAMES,
  LOOKS,
  type LookName,
  lookByName,
  lookFromKit,
  normalizeChartSpec,
  normalizeStyle,
  paletteFromPixels,
  parseNumber,
  parseNumberList,
  pickLook,
  pointCount,
  rgbaFromBase64,
  titleFromData,
} from '@pi-desktop/charts';
import { loadProjectKit } from '@pi-desktop/design-kit';
import { Type } from '@sinclair/typebox';
import type { PresentBridge } from './present.js';
import { pathForModel } from './workspace-relative.js';

export const CHART_TOOL = 'chart';
export const CHART_EDIT_TOOL = 'chart_edit';
export const CHART_TOOL_NAMES = [CHART_TOOL, CHART_EDIT_TOOL] as const;
/** The spec written beside the SVG: `<stem>.svg` + `<stem>.chart.json`. */
export const CHART_SIDECAR_SUFFIX = '.chart.json';
/**
 * The chart as measured elements, beside the SVG: `<stem>.chart.elements.json`.
 * The office pipeline reads it to put the chart INTO a deck, a document, a
 * workbook or a PDF as native shapes (`office edit … --chart <svg>`).
 */
export const CHART_ELEMENTS_SUFFIX = '.chart.elements.json';

export interface ChartToolDeps {
  readonly bridge: PresentBridge | null;
  /** The workspace root a relative path is resolved against. */
  readonly root: (ctxCwd: string | undefined) => string;
  /**
   * The design kit in force for this project, or null for none (VQ-04). A
   * chart that names no look wears it; with none, charts keep their per-chat
   * looks. See `projectChartKit`.
   */
  readonly kit?: (root: string) => Promise<KitForChart | null>;
  /** Injected for tests. */
  readonly writeFileImpl?: (p: string, text: string) => Promise<void>;
  readonly readFileImpl?: (p: string) => Promise<string>;
}

/**
 * THE KIT A CHART WEARS, WHEN ONE IS IN FORCE (VQ-04): the project's own
 * `.bobble/brand.md`, or the kit the Design setting names while that setting
 * is on (`PI_DESKTOP_DESIGN_KIT`). With neither — every install today, until
 * the Design panel ships (VQ-14) — there is none, and a chart keeps its
 * per-chat look: the user, "we CANNOT have 'all charts from bobble look the same
 * generic'", and the house default kit for every chart would be exactly that.
 * One kit per PROJECT is the other half of the same rule — variety across
 * projects, a deck and its charts belonging together inside one.
 */
export async function projectChartKit(
  root: string,
  opts: {
    readonly kitName?: string;
    readonly readFile?: (p: string) => Promise<string>;
  } = {},
): Promise<KitForChart | null> {
  const project = await loadProjectKit({
    root,
    kitName: opts.kitName ?? process.env.PI_DESKTOP_DESIGN_KIT,
    readFile: opts.readFile ?? ((p) => readFile(p, 'utf8')),
  });
  return project.source === 'default' ? null : project.kit;
}

const TYPE_WORD = new Set<string>([
  ...CHART_TYPES,
  'bars',
  'column',
  'columns',
  'pie',
  'doughnut',
  'ring',
  'horizontal',
  'ranked',
  'trend',
  'points',
  'xy',
  'stack',
  'grouped',
]);

/** A file name from the title: "Units Sold by Year" → units-sold-by-year. */
export function chartSlug(title: string, type: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug !== '' ? slug : `${type}-chart`;
}

/** "[1, 2]" → the list; anything else as it came. */
function jsonListIfAny(v: unknown): unknown {
  if (typeof v === 'string' && /^\s*\[/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** The style keys a call may carry, flat — read by normalizeStyle. */
const STYLE_KEYS = [
  'look',
  'palette',
  'accent',
  'radius',
  'bars',
  'bar_width',
  'grid',
  'line',
  'markers',
  'area',
  'font',
  'value_labels',
  'ring',
  'background',
  'ink',
] as const;

/**
 * A JSON list of SERIES — `[{"name":"Organic","values":[12,14,…]}, …]`, the
 * shape Chart.js calls datasets and the one a 4B reaches for first. MEASURED
 * (visual suite, 2026-09-25): given as `--data` or as a bare argument it was
 * read as a list of points, and "chart needs its data" came back twice before
 * the model found "Organic: 12, 14; …".
 */
function looksLikeSeriesList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => {
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
      const o = x as Record<string, unknown>;
      const nums = o.values ?? o.data;
      return (
        (typeof o.name === 'string' || typeof o.label === 'string') &&
        Array.isArray(nums) &&
        nums.length > 0
      );
    })
  );
}

/** A JSON blob in the type/title slot, read as data (see chartInputFromParams). */
function salvageJson(p: Record<string, unknown>): {
  type?: unknown;
  title?: unknown;
  values?: unknown;
  labels?: unknown;
  extra?: Record<string, unknown>;
} {
  const out: {
    type?: unknown;
    title?: unknown;
    values?: unknown;
    labels?: unknown;
    extra?: Record<string, unknown>;
  } = { type: p.type, title: p.title };
  for (const key of ['type', 'title'] as const) {
    const v = p[key];
    if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      const numbers = parsed.filter((x) => typeof x === 'number');
      if (numbers.length === parsed.length && numbers.length > 0) {
        out.values = numbers;
      } else if (
        parsed.length === 2 &&
        typeof parsed[0] === 'string' &&
        Array.isArray(parsed[1]) &&
        (parsed[1] as unknown[]).every((x) => typeof x === 'number')
      ) {
        // ["Units Sold", [12, 19]] — a named series.
        out.values = `${parsed[0]}: ${(parsed[1] as number[]).join(', ')}`;
      } else if (parsed.every((x) => typeof x === 'string')) {
        out.labels = parsed;
      } else {
        out.extra = looksLikeSeriesList(parsed) ? { series: parsed } : { items: parsed };
      }
      out[key] = undefined;
    } else if (parsed !== null && typeof parsed === 'object') {
      out.extra = { ...out.extra, ...(parsed as Record<string, unknown>) };
      out[key] = undefined;
    }
  }
  return out;
}

/** "clean/mono", "editorial, pill, no grid" → the knobs those words name. */
function styleFromWords(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const words = text
    .toLowerCase()
    .split(/[\s,/;+&]+/)
    .filter((w) => w !== '');
  for (const w of words) {
    if ((LOOK_NAMES as readonly string[]).includes(w)) {
      // The first look named wins; "mono" here is the look, not the typeface.
      if (out.look === undefined) out.look = w;
    } else if (w === 'pill' || w === 'rounded' || w === 'square') out.radius = w;
    else if (w === 'thin' || w === 'wide') out.bars = w;
    else if (w === 'smooth' || w === 'curved' || w === 'step') out.line = w;
    else if (w === 'serif' || w === 'mono' || w === 'rounded-font')
      out.font = w === 'rounded-font' ? 'rounded' : w;
    else if (w === 'dots' || w === 'dotted') out.grid = 'dots';
  }
  return out;
}

/**
 * The flat call → the object `normalizeChartSpec` reads.
 *
 * Forgiving where a small model is loose: the positional order swapped
 * (`chart "Units Sold" bar`), a JSON list typed as a string, several series
 * as "Revenue: 4, 5; Cost: 3, 3", the whole spec handed in `data`, the style
 * as flat knobs or as a `style` JSON object.
 */
export function chartInputFromParams(input: Record<string, unknown>): Record<string, unknown> {
  let p = input;
  let base: Record<string, unknown> = {};
  if (typeof p.data === 'string' && p.data.trim() !== '') {
    try {
      const parsed = JSON.parse(p.data) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      } else if (Array.isArray(parsed)) {
        base = looksLikeSeriesList(parsed) ? { series: parsed } : { items: parsed };
      }
    } catch {
      /* not JSON — the flat fields carry the chart */
    }
  } else if (p.data !== null && typeof p.data === 'object') {
    base = Array.isArray(p.data)
      ? looksLikeSeriesList(p.data)
        ? { series: p.data }
        : { items: p.data }
      : { ...(p.data as Record<string, unknown>) };
  }
  // A JSON blob that landed in the type or title slot — MEASURED, a 4B sent
  // its data as `["Units Sold (thousands)", [12, 19, 27, 35]]` under an
  // unknown key, which the CLI handed to the first positional — is data.
  const salvaged = salvageJson(p);
  const rawType = typeof salvaged.type === 'string' ? salvaged.type.trim() : '';
  let type = rawType.toLowerCase();
  let title = typeof salvaged.title === 'string' ? salvaged.title.trim() : '';
  if (salvaged.values !== undefined && (p.values === undefined || p.values === '')) {
    p = { ...p, values: salvaged.values };
  }
  if (salvaged.labels !== undefined && (p.labels === undefined || p.labels === '')) {
    p = { ...p, labels: salvaged.labels };
  }
  if (salvaged.extra !== undefined) base = { ...salvaged.extra, ...base };
  // `chart "Units Sold by Year" bar` — the words in the other order.
  if (type !== '' && !TYPE_WORD.has(type.replace(/\s+chart$/, ''))) {
    if (title === '' || TYPE_WORD.has(title.toLowerCase())) {
      const swapped = title;
      title = rawType;
      type = swapped.toLowerCase();
    }
  }
  let values: unknown = jsonListIfAny(p.values);
  if (typeof values === 'string' && values.includes(':')) {
    // Several named series: "Revenue: 4, 5, 6; Cost: 3, 3, 4".
    const groups = values
      .split(/\s*;\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    values = groups.length > 1 ? groups : values;
  }
  const out: Record<string, unknown> = { ...base };
  if (type !== '') out.type = type;
  if (title !== '') out.title = title;
  if (p.labels !== undefined && p.labels !== '') out.labels = jsonListIfAny(p.labels);
  if (values !== undefined && values !== '') out.values = values;
  for (const key of [
    'subtitle',
    'x_label',
    'y_label',
    'unit',
    'highlight',
    'note',
    'size',
  ] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  // The look: a `style` JSON object, and/or the flat knobs on top of it.
  const styleInput: Record<string, unknown> = {};
  if (typeof p.style === 'string' && p.style.trim().startsWith('{')) {
    try {
      Object.assign(styleInput, JSON.parse(p.style) as Record<string, unknown>);
    } catch {
      /* an unreadable style is no style */
    }
  } else if (typeof p.style === 'string' && p.style.trim() !== '') {
    // `--style clean/mono`, `--style "editorial, pill"`: the words that are
    // look names or knob values, read as such.
    Object.assign(styleInput, styleFromWords(p.style));
  } else if (p.style !== null && typeof p.style === 'object') {
    Object.assign(styleInput, p.style as Record<string, unknown>);
  }
  for (const key of STYLE_KEYS) {
    const v = p[key];
    if (v !== undefined && v !== null && v !== '') styleInput[key] = v;
  }
  const style = normalizeStyle(styleInput);
  if (style !== undefined) out.style = { ...(base.style as object | undefined), ...style };
  return out;
}

/** A scatter given numeric labels: the label IS the x. */
function withScatterX(spec: ChartSpec): ChartSpec {
  if (spec.type !== 'scatter') return spec;
  return {
    ...spec,
    series: spec.series.map((s) => ({
      ...s,
      points: s.points.map((pt) => {
        if (pt.x !== undefined) return pt;
        const x = Number(pt.label.replace(/[,\s]/g, ''));
        return Number.isFinite(x) ? { ...pt, x } : pt;
      }),
    })),
  };
}

/**
 * An untitled chart with one named series is titled by it: "Units Sold
 * (thousands)" was the name a 4B gave its only series, and the card wants a
 * title more than a legend of one.
 */
export function withTitle(spec: ChartSpec): ChartSpec {
  const only = spec.series.length === 1 ? spec.series[0] : undefined;
  if (spec.title !== '' || only === undefined || only.name === '') return spec;
  return { ...spec, title: only.name, series: [{ ...only, name: '' }] };
}

/**
 * A chart that names no look gets one — baked INTO the spec, so the file on
 * disk, the card in the chat and every later edit agree.
 *
 * THE LOOK IS STICKY (VQ-02). It used to be picked from each chart's title, so
 * the charts of one answer came out in different clothes on purpose (the
 * research's D29: the MAU bars and the revenue line of one brief in two unrelated
 * looks). Now a conversation's first chart takes the look it names, or one
 * picked from its title, and every later chart that names none wears the same
 * — variety comes across conversations, and a chart that names a look gets it.
 * `sticky` is that conversation's look, when it has one.
 */
export function withLook(spec: ChartSpec, sticky?: LookName, kit?: KitForChart | null): ChartSpec {
  if (spec.style?.look !== undefined) return spec;
  // A kit in force dresses every chart that named no look — its colours, its
  // knobs, its dark steps — under whatever the chart set itself (dressInKit).
  if (kit !== undefined && kit !== null)
    return { ...spec, style: dressInKit(lookFromKit(kit), spec.style) };
  const look = sticky ?? pickLook(spec.title !== '' ? spec.title : describeData(spec));
  return { ...spec, style: { ...spec.style, look } };
}

/**
 * The look each conversation's charts wear, by session (or, with no session to
 * key on, by folder). pi imports the extension per session, so this map is
 * per conversation in practice; after a restart the newest chart in the folder
 * carries the look forward (a Bobble chat has a folder of its own).
 */
const conversationLooks = new Map<string, LookName>();

function conversationKey(
  ctx: { sessionManager?: { getSessionId?: () => string } } | undefined,
  dir: string,
): string {
  let id: string | undefined;
  try {
    id = ctx?.sessionManager?.getSessionId?.();
  } catch {
    id = undefined;
  }
  return typeof id === 'string' && id !== '' ? `session:${id}` : `dir:${dir}`;
}

/** The look of the newest chart already in `dir`, if any (read from its spec). */
async function lookOfNewestChart(dir: string): Promise<LookName | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(CHART_SIDECAR_SUFFIX));
  } catch {
    return undefined;
  }
  let newest: { at: number; file: string } | null = null;
  for (const n of names.slice(0, 400)) {
    const file = path.join(dir, n);
    try {
      const at = (await stat(file)).mtimeMs;
      if (newest === null || at > newest.at) newest = { at, file };
    } catch {
      /* gone meanwhile */
    }
  }
  if (newest === null) return undefined;
  try {
    const look = (JSON.parse(await readFile(newest.file, 'utf8')) as { style?: { look?: unknown } })
      .style?.look;
    return typeof look === 'string' ? lookByName(look)?.name : undefined;
  } catch {
    return undefined;
  }
}

/** The look a call asked for by name (`--look`, `--style clean`, a style JSON), valid or not. */
function lookAskedFor(p: Record<string, unknown>): string | undefined {
  if (typeof p.look === 'string' && p.look.trim() !== '') return p.look.trim();
  if (typeof p.style === 'string') {
    const t = p.style.trim();
    if (t.startsWith('{')) {
      try {
        const look = (JSON.parse(t) as { look?: unknown }).look;
        return typeof look === 'string' ? look : undefined;
      } catch {
        return undefined;
      }
    }
    // `--style=terminal`: a single word that is not a knob is a look's name.
    if (
      /^[a-z][a-z-]*$/i.test(t) &&
      !/^(pill|rounded|square|thin|wide|smooth|curved|step|serif|dots|dotted)$/i.test(t)
    ) {
      return t;
    }
  }
  return undefined;
}

/** "drawn as bars instead: …" → "Drawn as bars instead: ….": a note as a sentence. */
function sentence(note: string): string {
  const t = note.trim();
  const s = `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * Where a chart may be written without destroying another one.
 *
 * REAL: twelve untitled charts were all written to `bar-chart.svg`, each over
 * the last, and the model then said it had made "10 different charts". A file
 * is overwritten only by the SAME chart made again — the same title and labels
 * when the title was the model's own, the same data when it came from the data
 * (a retry). Anything else — another chart, or a file the chart tool did not
 * write — keeps its name, and this one takes the next free "-2", "-3".
 */
async function placeChart(
  deps: ChartToolDeps,
  target: string,
  spec: ChartSpec,
  titleWasGiven: boolean,
): Promise<string> {
  const read = deps.readFileImpl ?? ((f: string) => readFile(f, 'utf8'));
  const stem = target.slice(0, -4);
  for (let n = 1; n < 200; n += 1) {
    const candidate = n === 1 ? target : `${stem}-${n}.svg`;
    let there = true;
    try {
      await stat(candidate);
    } catch {
      there = false;
    }
    if (!there) return candidate;
    let existing: ChartSpec | null = null;
    try {
      existing = normalizeChartSpec(
        JSON.parse(await read(`${candidate.slice(0, -4)}${CHART_SIDECAR_SUFFIX}`)),
      );
    } catch {
      existing = null; // a file the chart tool did not write is never overwritten
    }
    if (existing !== null && sameChart(existing, spec, titleWasGiven)) return candidate;
  }
  return `${stem}-${Date.now()}.svg`;
}

/**
 * Whether a chart on disk is this chart made again (see placeChart): the same
 * kind of chart, and the same title and categories — or, for a chart titled
 * from its data, the same data. REAL: the demo drew the same six months as a
 * line and then as an area; those are two charts, not one remade.
 */
function sameChart(a: ChartSpec, b: ChartSpec, titleWasGiven: boolean): boolean {
  if (a.type !== b.type) return false;
  const labels = (s: ChartSpec): string => JSON.stringify(s.series[0]?.points.map((p) => p.label));
  if (titleWasGiven) return a.title === b.title && labels(a) === labels(b);
  const data = (s: ChartSpec): string =>
    JSON.stringify(s.series.map((x) => [x.name, x.points.map((p) => [p.label, p.value])]));
  return data(a) === data(b);
}

/** The data, read back in one line so the model can check it against the ask. */
export function describeData(spec: ChartSpec): string {
  const lines = spec.series.map((s) => {
    const pts = s.points
      .map((pt) =>
        spec.type === 'scatter' && pt.x !== undefined
          ? `${pt.label !== '' ? `${pt.label} ` : ''}(${formatValue(pt.x)}, ${formatValue(pt.value, spec.unit)})`
          : `${pt.label} ${formatValue(pt.value, spec.unit)}`,
      )
      .join(', ');
    return spec.series.length > 1 && s.name !== '' ? `${s.name}: ${pts}` : pts;
  });
  return lines.join(' | ');
}

/** The look, said back: "look: editorial (serif, navy/terracotta), pill bars". */
export function describeLook(spec: ChartSpec): string {
  const st = spec.style;
  if (st === undefined) return '';
  const parts: string[] = [];
  if (st.kit !== undefined) parts.push(`kit ${st.kit}`);
  if (st.look !== undefined) parts.push(`look ${st.look}`);
  if (st.palette !== undefined) parts.push(`palette ${st.palette.join(' ')}`);
  if (st.accent !== undefined) parts.push(`accent ${st.accent}`);
  if (st.radius !== undefined) parts.push(`radius ${st.radius}`);
  if (st.barWidth !== undefined) parts.push(`bars ${Math.round(st.barWidth * 100)}%`);
  if (st.grid !== undefined) parts.push(`grid ${st.grid}`);
  if (st.line !== undefined) parts.push(`line ${st.line}`);
  if (st.font !== undefined) parts.push(`font ${st.font}`);
  if (st.labels !== undefined) parts.push(`labels ${st.labels}`);
  if (st.background !== undefined) parts.push(`background ${st.background}`);
  if (spec.size !== undefined) {
    const c = chartCanvas(spec);
    parts.push(`size ${spec.size} (${c.width}×${c.height})`);
  }
  return parts.join(', ');
}

type Content = Array<{ type: 'text'; text: string }>;

function errorResult(text: string): { content: Content; isError: true; details: undefined } {
  return { content: [{ type: 'text', text }], isError: true, details: undefined };
}

function resolveAgainst(root: string, p: string): string {
  const trimmed = p.trim();
  const home = process.env.HOME;
  const expanded =
    trimmed.startsWith('~/') && home !== undefined ? path.join(home, trimmed.slice(2)) : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

function resolveOut(root: string, out: string | undefined, slug: string): string {
  if (out === undefined || out.trim() === '') return path.join(root, `${slug}.svg`);
  const abs = resolveAgainst(root, out);
  if (abs.endsWith(CHART_SIDECAR_SUFFIX))
    return `${abs.slice(0, -CHART_SIDECAR_SUFFIX.length)}.svg`;
  if (/\.json$/i.test(abs)) return abs.replace(/\.json$/i, '.svg');
  if (/\.svg$/i.test(abs)) return abs;
  return `${abs}.svg`;
}

const TYPES_LINE =
  'bar (values by category), stacked (parts of each category), hbar (ranked names, long labels), line (a trend), area, scatter (x/y points), donut (shares of a whole), pie (the same, no hole), radar (several measures on spokes — a profile, ratings)';

const LOOKS_LINE = LOOKS.map((l) => `${l.name} — ${l.about}`).join('; ');

/** The style knobs, shared by make and edit. */
function styleParams() {
  return {
    look: Type.Optional(
      Type.Union(
        LOOK_NAMES.map((n) => Type.Literal(n)),
        {
          description: `A named look. Pick one that fits the subject: ${LOOKS_LINE}. Left out, the chart wears the conversation's look.`,
        },
      ),
    ),
    palette: Type.Optional(
      Type.String({
        description:
          'Series colours, comma-separated hex or names: "#264653, #2a9d8f, #e9c46a" or "navy, coral, teal". Overrides the look\'s.',
      }),
    ),
    accent: Type.Optional(
      Type.String({ description: 'The highlight colour (hex or a name like coral, amber).' }),
    ),
    radius: Type.Optional(
      Type.String({
        description: 'Bar corners: a number of px (0 = square), or "pill" (fully rounded).',
      }),
    ),
    bars: Type.Optional(
      Type.String({
        description: 'Bar thickness: "thin", "wide", or a fraction of the band like 0.4.',
      }),
    ),
    grid: Type.Optional(
      Type.Union([Type.Literal('lines'), Type.Literal('dots'), Type.Literal('none')], {
        description: 'Gridlines: lines, dots, or none.',
      }),
    ),
    line: Type.Optional(
      Type.Union([Type.Literal('straight'), Type.Literal('smooth'), Type.Literal('step')], {
        description: 'Line/area charts: straight, smooth (curved), or step.',
      }),
    ),
    font: Type.Optional(
      Type.Union(
        [
          Type.Literal('system'),
          Type.Literal('serif'),
          Type.Literal('mono'),
          Type.Literal('rounded'),
        ],
        { description: 'The typeface: system, serif, mono, rounded.' },
      ),
    ),
    value_labels: Type.Optional(
      Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('auto')], {
        description:
          'Values written on the bars/points: on, off, or auto (only in the larger view).',
      }),
    ),
    background: Type.Optional(
      Type.String({
        description:
          "A ground of the chart's own (hex): the card paints it in any theme; the ink is chosen for contrast.",
      }),
    ),
    style: Type.Optional(
      Type.String({
        description:
          'Every knob at once as JSON: {"look":"soft","radius":"pill","grid":"dots","markers":"dot","area":"gradient","ring":0.4}.',
      }),
    ),
    from_image: Type.Optional(
      Type.String({
        description:
          'Style it like this picture: a path to an image whose colours (and ground) become the palette — a screenshot, a poster, a brand page.',
      }),
    ),
    size: Type.Optional(
      Type.Union(
        CHART_SIZE_NAMES.map((n) => Type.Literal(n)),
        {
          description: `Where the .svg is going: ${CHART_SIZE_NAMES.map((n) => `${n} — ${CHART_SIZES[n].about}`).join('; ')}. Default card.`,
        },
      ),
    ),
  };
}

/** The picture's colours as a style, through the app's decoder. */
async function styleFromImage(
  bridge: PresentBridge | null,
  imagePath: string,
): Promise<{ style?: ChartStyle; note: string; error?: string }> {
  if (bridge === null || bridge.pixels === undefined) {
    return {
      note: '',
      error: 'styling from an image needs the app (its image decoder is not reachable here)',
    };
  }
  const r = await bridge.pixels({ path: imagePath, width: 64 });
  if (r.rgba === undefined) {
    return { note: '', error: `could not read ${imagePath}: ${r.error ?? 'no pixels came back'}` };
  }
  const found = paletteFromPixels(rgbaFromBase64(r.rgba), 6);
  const style: ChartStyle = {
    palette: found.palette,
    accent: found.accent,
    ...(found.background !== undefined ? { background: found.background } : {}),
  };
  return {
    style,
    note: `Colours from ${path.basename(imagePath)}: ${found.palette.join(', ')}; accent ${found.accent}${found.background !== undefined ? `; ground ${found.background}` : ''}.`,
  };
}

/**
 * THE REPLY IS ONE SENTENCE. MEASURED on a 4B: told "do not repeat the
 * numbers", it replied with a bulleted list of every value and then the
 * trend. The card already shows the values; what a person wants under it is
 * the reading — Claude's one line: "sales grew 11%…". Said first, as the
 * instruction, with the values named as the thing NOT to write.
 */
const REPLY_LINE =
  'Check that data against what the user asked for; if it is right, you are done. Your reply is ONE sentence saying what the chart shows — its peak, its trend, its share (e.g. "Sales climbed every year, peaking at 22 in 2024."). No list of the values, no description of the chart, the file or the look: the card in front of the user has all of that. It is already shown — do not present it again. To change anything about it later — a colour, thinner bars, another series, the look — use chart_edit on the file. If the chart was asked for INSIDE a document, put it there now: office_edit with --chart <this .svg> and --slide N (pptx), --after <paragraph> (docx), --anchor B12 (xlsx) or --page N (pdf).';

interface Written {
  readonly svgPath: string;
  readonly specPath: string;
}

async function writeChart(
  deps: ChartToolDeps,
  spec: ChartSpec,
  svgPath: string,
): Promise<Written | { error: string }> {
  const specPath = `${svgPath.slice(0, -4)}${CHART_SIDECAR_SUFFIX}`;
  const write = deps.writeFileImpl ?? ((f, text) => writeFile(f, text, 'utf8'));
  try {
    await mkdir(path.dirname(svgPath), { recursive: true });
    // The spec first: the app reads it when the SVG is presented.
    await write(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    await write(svgPath, chartToSvg(spec));
    // …and the elements, for the office pipeline to embed as native shapes.
    await write(
      `${svgPath.slice(0, -4)}${CHART_ELEMENTS_SUFFIX}`,
      `${JSON.stringify(chartToElements(spec))}\n`,
    );
  } catch (err) {
    return {
      error: `could not write ${svgPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { svgPath, specPath };
}

function whatIs(spec: ChartSpec): string {
  const n = pointCount(spec);
  return `${/^[aeiou]/.test(spec.type) ? 'an' : 'a'} ${spec.type} chart${spec.title !== '' ? ` "${spec.title}"` : ''} (${n} point${n === 1 ? '' : 's'}${spec.series.length > 1 ? `, ${spec.series.length} series` : ''}${spec.style?.look !== undefined ? `, look ${spec.style.look}` : ''})`;
}

async function present(
  bridge: PresentBridge | null,
  svgPath: string,
  note: string,
): Promise<string> {
  if (bridge === null) return '';
  const r = await bridge.show({ path: svgPath, note });
  return r.ok
    ? ' It is in the chat as an interactive card (hover reads the values; chart/table toggle; Open in canvas).'
    : ` (it could not be shown in the chat: ${r.error ?? 'unknown'})`;
}

export function registerChartTool(pi: ExtensionAPI, deps: ChartToolDeps): void {
  pi.registerTool({
    name: CHART_TOOL,
    label: 'Chart',
    description:
      'Draw a data visual — bar, stacked, horizontal bar, line, area, scatter, donut, pie or radar — from the ' +
      'numbers, straight into the chat as an interactive card (hover reads the values, a chart/table ' +
      'toggle, Open in canvas). Every request to chart, plot, graph or visualise data goes here: ' +
      'sales by year, shares of a total, a trend, a comparison of two series. It draws in under a ' +
      'second from the labels and values you pass; put the real numbers in, never a summary of them. ' +
      'Every chart has a LOOK: name one that fits the subject (--look), set the knobs (--palette, ' +
      '--accent, --radius, --bars, --grid, --line, --font), or --from_image a picture to take its ' +
      "colours; left alone, it wears the conversation's look. Never image generation for a chart (a " +
      'painting cannot put a value on an axis), never matplotlib, never hand-written SVG, never a ' +
      'whole deck for one chart. It writes a .svg (and the spec beside it) into the project, so the ' +
      'same chart can go into a page or document. To change a chart afterwards, use chart_edit.',
    promptSnippet:
      'chart: an interactive chart of data in the chat (bar, line, donut, …), with a look',
    promptGuidelines: [
      'A chart, plot or graph of numbers is the chart tool with the labels and values — it appears in the chat instantly; never image generation, matplotlib or hand-written SVG.',
      "Give each chart a look that fits its subject (finance → clean/editorial/mono, consumer → bold/candy/sunset, engineering → slate/mono, nature → forest/ocean) and vary between charts; a user's colour, thickness or series change is chart_edit on the file.",
      'After a chart, say ONE line of what it shows (the peak, the trend, the share) — the user is looking at the values, so do not list them again.',
    ],
    parameters: Type.Object({
      type: Type.Union(
        CHART_TYPES.map((t) => Type.Literal(t)),
        {
          description: `Which chart: ${TYPES_LINE}. Left out: bar (line for many points).`,
          cliOptional: true,
        },
      ),
      // Required, so `chart bar "Title"` fills it second — but `cliOptional`:
      // MEASURED, a 4B's first call carried the labels and values and no
      // title, and "missing --title" cost it a second call for a chart that
      // was drawable. An untitled chart is a chart.
      title: Type.String({
        description: 'The chart title, e.g. "Units Sold by Year".',
        cliOptional: true,
      }),
      labels: Type.Optional(
        Type.String({
          description:
            'The categories (x axis), comma-separated: "2021, 2022, 2023, 2024". For scatter, the x values.',
        }),
      ),
      values: Type.Optional(
        Type.String({
          description:
            'The values in the same order: "12, 19, 15, 22". Several series: "Revenue: 4.2, 5.1, 6.4; Cost: 3.1, 3.4, 3.9".',
        }),
      ),
      unit: Type.Optional(
        Type.String({ description: 'The unit of the values: "$", "%", "GW", "units".' }),
      ),
      subtitle: Type.Optional(
        Type.String({ description: 'A line under the title: the population, the period.' }),
      ),
      x_label: Type.Optional(Type.String({ description: 'Axis title for the categories.' })),
      y_label: Type.Optional(Type.String({ description: 'Axis title for the values.' })),
      highlight: Type.Optional(
        Type.String({
          description: 'One label to single out (its bar or slice takes the accent).',
        }),
      ),
      note: Type.Optional(
        Type.String({ description: 'A source line under the chart: "Source: Q3 report".' }),
      ),
      data: Type.Optional(
        Type.String({
          description:
            'Instead of labels/values: the whole spec as JSON — {"series":[{"name":"…","points":[{"label":"…","value":1}]}]}, or [{"label":"…","value":1}, …].',
        }),
      ),
      ...styleParams(),
      out: Type.Optional(
        Type.String({
          description:
            'Where to write the .svg, e.g. charts/units.svg. Relative paths land in the project. Default: named from the title, in the project.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as Record<string, unknown>;
      const root = deps.root(ctx?.cwd);
      let spec: ChartSpec;
      try {
        // STRICT: a value that is not a number, a list that reads two ways, or
        // a series that does not match its labels is named back — never a
        // dropped token, a shifted value or a silent zero (VQ-02).
        spec = withScatterX(normalizeChartSpec(chartInputFromParams(p), { strict: true }));
      } catch (err) {
        if (err instanceof ChartDataError) return errorResult(`chart: ${sentence(err.message)}`);
        return errorResult(
          `chart needs its data: ${err instanceof Error ? err.message : String(err)}. Pass --labels "A, B, C" --values "1, 2, 3" (several series: "Name: 1, 2; Other: 3, 4"), or --data with the JSON spec.`,
        );
      }
      if (pointCount(spec) === 0) return errorResult('chart needs at least one value.');
      const notes: string[] = [];
      let imageNote = '';
      if (typeof p.from_image === 'string' && p.from_image.trim() !== '') {
        const img = await styleFromImage(deps.bridge, resolveAgainst(root, p.from_image));
        if (img.style === undefined)
          return errorResult(`chart: ${img.error ?? 'the image gave no colours'}`);
        spec = { ...spec, style: { ...spec.style, ...img.style } };
        imageNote = `\n${img.note}`;
      }
      // A form that cannot show the data becomes one that can, said in one line.
      const coerced = coerceChartForm(spec);
      spec = coerced.spec;
      notes.push(...coerced.notes.map(sentence));
      spec = withTitle(spec);
      const titleWasGiven = spec.title !== '';
      if (!titleWasGiven) {
        const fromData = titleFromData(spec);
        if (fromData !== '') {
          spec = { ...spec, title: fromData };
          notes.push(
            `It had no title, so it is titled "${fromData}" from its data; a title that says what it shows reads better (chart_edit --title).`,
          );
        }
      }
      const target = resolveOut(
        root,
        typeof p.out === 'string' ? p.out : undefined,
        chartSlug(spec.title, spec.type),
      );
      // The conversation's look, unless this chart names one (and a name that
      // is not a look is said, with the ones that are).
      const key = conversationKey(ctx, path.dirname(target));
      const asked = lookAskedFor(p);
      const kit = asked === undefined && deps.kit !== undefined ? await deps.kit(root) : null;
      const sticky = conversationLooks.get(key) ?? (await lookOfNewestChart(path.dirname(target)));
      spec = withLook(spec, sticky, kit);
      if (asked !== undefined && lookByName(asked) === undefined) {
        notes.push(
          `There is no look called "${asked}" (the looks: ${LOOK_NAMES.join(', ')}); it wears ${spec.style?.look ?? 'clean'}.`,
        );
      }
      if (spec.style?.look !== undefined) conversationLooks.set(key, spec.style.look);
      const svgPath = await placeChart(deps, target, spec, titleWasGiven);
      if (svgPath !== target) {
        notes.push(
          `${path.basename(target)} already holds a different chart, so this one is ${path.basename(svgPath)}.`,
        );
      }
      const written = await writeChart(deps, spec, svgPath);
      if ('error' in written) return errorResult(`chart ${written.error}`);
      const what = whatIs(spec);
      const shown = await present(deps.bridge, written.svgPath, what);
      const text = [
        `Drew ${what}: ${pathForModel(written.svgPath, root)} (the spec beside it: ${path.basename(written.specPath)}).${shown}`,
        ...notes,
        `Data: ${describeData(spec)}`,
        `Look: ${describeLook(spec)}${imageNote}`,
        '',
        REPLY_LINE,
      ].join('\n');
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  pi.registerTool({
    name: CHART_EDIT_TOOL,
    label: 'Chart: edit',
    description:
      'Change a chart that exists (its .svg or .chart.json): its data — add a series for comparison ' +
      '(--add "Cost: 8, 12, 10, 14"), change one value (--set "2023: 17"), remove a series ' +
      '(--remove Cost), replace the labels or values — its words (title, subtitle, unit, note, ' +
      'highlight, axis titles), its type, or its look (--look, --palette, --accent, --radius, ' +
      '--bars thin, --grid none, --line smooth, --font serif, --value_labels on, --background, ' +
      '--from_image). Every request to change a chart in any way — a colour, thinner bars, a second ' +
      'bar per year, a different style, "make it look like this picture" — is one call here; the ' +
      'chart is redrawn in place and shown again. Nothing else about it changes.',
    promptSnippet: 'chart_edit: change an existing chart — data, words, or look',
    parameters: Type.Object({
      file: Type.String({
        description:
          'The chart to change: its .svg (or .chart.json) path, as the chart tool reported it.',
      }),
      add: Type.Optional(
        Type.String({
          description:
            'A series to add, in the labels\' order: "Cost: 8, 12, 10, 14" (several: "A: 1, 2; B: 3, 4"). Turns a bar chart into grouped bars.',
        }),
      ),
      set: Type.Optional(
        Type.String({
          description:
            'Change values by label: "2023: 17" or "2023: 17, 2024: 25". For several series: "Cost/2023: 9".',
        }),
      ),
      remove: Type.Optional(
        Type.String({
          description: 'A series to remove by name (or a label to drop from every series).',
        }),
      ),
      rename: Type.Optional(
        Type.String({
          description: 'Rename a series or a label: "old: new" (several: "a: b; c: d").',
        }),
      ),
      sort: Type.Optional(
        Type.Union([Type.Literal('asc'), Type.Literal('desc'), Type.Literal('none')], {
          description: 'Order the categories by value (a ranking), or leave them as given.',
        }),
      ),
      type: Type.Optional(
        Type.Union(
          CHART_TYPES.map((t) => Type.Literal(t)),
          { description: `A different kind of chart: ${TYPES_LINE}.` },
        ),
      ),
      title: Type.Optional(Type.String()),
      subtitle: Type.Optional(Type.String()),
      labels: Type.Optional(
        Type.String({ description: 'Replace the categories: "Q1, Q2, Q3, Q4".' }),
      ),
      values: Type.Optional(
        Type.String({ description: 'Replace ALL the data: "1, 2, 3" or "A: 1, 2; B: 3, 4".' }),
      ),
      unit: Type.Optional(Type.String()),
      x_label: Type.Optional(Type.String()),
      y_label: Type.Optional(Type.String()),
      highlight: Type.Optional(Type.String({ description: 'The label to single out, or "none".' })),
      note: Type.Optional(Type.String()),
      ...styleParams(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as Record<string, unknown>;
      const root = deps.root(ctx?.cwd);
      const fileRaw = typeof p.file === 'string' ? p.file.trim() : '';
      if (fileRaw === '') return errorResult('chart_edit needs the chart file (its .svg path).');
      const svgPath = resolveOut(root, fileRaw, 'chart');
      const specPath = `${svgPath.slice(0, -4)}${CHART_SIDECAR_SUFFIX}`;
      const read = deps.readFileImpl ?? ((f) => readFile(f, 'utf8'));
      let current: ChartSpec;
      try {
        current = normalizeChartSpec(JSON.parse(await read(specPath)));
      } catch (err) {
        return errorResult(
          `chart_edit: ${path.basename(svgPath)} is not a chart made here (no readable ${path.basename(specPath)} beside it: ${err instanceof Error ? err.message : String(err)}). Make it with chart, then edit that.`,
        );
      }
      let next: ChartSpec;
      try {
        next = applyEdits(current, p);
      } catch (err) {
        return errorResult(`chart_edit: ${err instanceof Error ? err.message : String(err)}`);
      }
      // A look chosen for this chart becomes the conversation's look too.
      if (next.style?.look !== undefined && next.style.look !== current.style?.look) {
        conversationLooks.set(conversationKey(ctx, path.dirname(svgPath)), next.style.look);
      }
      let imageNote = '';
      if (typeof p.from_image === 'string' && p.from_image.trim() !== '') {
        const img = await styleFromImage(deps.bridge, resolveAgainst(root, p.from_image));
        if (img.style === undefined)
          return errorResult(`chart_edit: ${img.error ?? 'the image gave no colours'}`);
        next = { ...next, style: { ...next.style, ...img.style } };
        imageNote = `\n${img.note}`;
      }
      next = withLook(withScatterX(next));
      const changed = summarizeChange(current, next);
      if (changed.length === 0) {
        return errorResult(
          'chart_edit changed nothing — say what to change: --add "Name: v1, v2", --set "label: value", --remove Name, --look/--palette/--accent/--radius/--bars/--grid/--line/--font, --title, --type …',
        );
      }
      const written = await writeChart(deps, next, svgPath);
      if ('error' in written) return errorResult(`chart_edit ${written.error}`);
      const what = whatIs(next);
      const shown = await present(deps.bridge, written.svgPath, `${what} — ${changed.join(', ')}`);
      const text = [
        `Changed ${changed.join(', ')} → ${what}: ${pathForModel(written.svgPath, root)}.${shown}`,
        `Data: ${describeData(next)}`,
        `Look: ${describeLook(next)}${imageNote}`,
        '',
        'The card in the chat shows the change. Reply in ONE sentence saying what changed (not the values, not the file). Any further change is another chart_edit on the same file.',
      ].join('\n');
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });
}

/**
 * "Cost: 8, 12" → [{ name, values }]; "A: 1; B: 2" → two. The numbers are read
 * the way `chart` reads them (22M, $1.2M, 3,100 counted against `expected`
 * labels); a token that is not a number throws a ChartDataError naming it.
 */
function namedSeries(text: string, expected?: number): { name: string; values: number[] }[] {
  const groups = /:/.test(text) ? text.split(/\s*;\s*|\n+/) : [text];
  return groups
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const m = /^([^:]+?)\s*:\s*(.+)$/.exec(s);
      const name = m !== null ? (m[1] ?? '').trim() : '';
      const body = m !== null ? (m[2] ?? '') : s;
      try {
        return { name, values: parseNumberList(body, expected).values };
      } catch (err) {
        if (err instanceof ChartDataError && name !== '') {
          throw new ChartDataError(`series "${name}": ${err.message}`);
        }
        throw err;
      }
    })
    .filter((g) => g.values.length > 0);
}

/** "a: b; c: d" (or "a: b, c: d") → pairs. */
function pairs(text: string): [string, string][] {
  return text
    .split(/\s*;\s*|\n+|\s*,\s*(?=[^,;:]+\s*:)/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const i = s.lastIndexOf(':');
      return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [s, ''];
    });
}

/** The edits, applied to a copy of the spec. Throws a plain message for a bad one. */
export function applyEdits(current: ChartSpec, p: Record<string, unknown>): ChartSpec {
  let series = current.series.map((s) => ({ ...s, points: s.points.map((pt) => ({ ...pt })) }));
  const labels = (): string[] => series[0]?.points.map((pt) => pt.label) ?? [];
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

  // Replace the data wholesale.
  const newLabels = str(p.labels);
  const newValues = str(p.values);
  if (newValues !== undefined || newLabels !== undefined) {
    const labelList =
      newLabels !== undefined ? (jsonListIfAny(newLabels) as unknown[] | string) : labels();
    const labelArr = Array.isArray(labelList)
      ? labelList.map(String)
      : String(labelList)
          .split(/[,;\n]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '');
    if (newValues !== undefined) {
      const groups = namedSeries(newValues, labelArr.length);
      if (groups.length === 0) throw new Error('--values had no numbers in it');
      series = groups.map((g, gi) => ({
        name: g.name || series[gi]?.name || '',
        points: labelArr.map((label, i) => ({ label, value: g.values[i] ?? 0 })),
      }));
    } else {
      series = series.map((s) => ({
        ...s,
        points: labelArr.map((label, i) => ({ label, value: s.points[i]?.value ?? 0 })),
      }));
    }
  }
  // Add series.
  const add = str(p.add);
  if (add !== undefined) {
    const groups = namedSeries(add, labels().length);
    if (groups.length === 0) throw new Error('--add needs a series like "Cost: 8, 12, 10, 14"');
    const ls = labels();
    // A lone unnamed series gets a name the moment it has company, or the
    // legend would read "Series 1 / Cost": the axis title, else the chart's.
    const first = series[0];
    if (series.length === 1 && first !== undefined && first.name === '') {
      first.name = current.yLabel ?? (current.title !== '' ? current.title : 'Series 1');
    }
    for (const g of groups) {
      if (g.values.length !== ls.length && ls.length > 0) {
        throw new Error(
          `--add "${g.name || 'series'}" has ${g.values.length} values but the chart has ${ls.length} categories (${ls.join(', ')}); give one value per category`,
        );
      }
      series.push({
        name: g.name || `Series ${series.length + 1}`,
        points: ls.map((label, i) => ({ label, value: g.values[i] ?? 0 })),
      });
    }
  }
  // Set values by label (optionally "Series/label: value").
  const set = str(p.set);
  if (set !== undefined) {
    for (const [key, valueText] of pairs(set)) {
      const value = parseNumber(valueText)?.value;
      if (value === undefined) {
        throw new Error(`--set "${key}: ${valueText}": ${ACCEPTED_NUMBER_FORMS}`);
      }
      const slash = key.indexOf('/');
      const seriesName = slash > 0 ? key.slice(0, slash).trim() : undefined;
      const label = slash > 0 ? key.slice(slash + 1).trim() : key;
      const targets =
        seriesName !== undefined
          ? series.filter((s) => s.name.toLowerCase() === seriesName.toLowerCase())
          : series.slice(0, 1);
      if (targets.length === 0) throw new Error(`--set: no series called "${seriesName}"`);
      let hit = false;
      for (const s of targets) {
        for (const pt of s.points) {
          if (pt.label.toLowerCase() === label.toLowerCase()) {
            pt.value = value;
            hit = true;
          }
        }
      }
      if (!hit)
        throw new Error(`--set: no category called "${label}" (have: ${labels().join(', ')})`);
    }
  }
  // Remove a series (by name) or a label (from every series).
  const remove = str(p.remove);
  if (remove !== undefined) {
    for (const name of remove.split(/\s*[;,]\s*/).filter((s) => s !== '')) {
      const asSeries = series.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
      if (asSeries.length < series.length && asSeries.length > 0) {
        series = asSeries;
        continue;
      }
      const had = labels().length;
      series = series.map((s) => ({
        ...s,
        points: s.points.filter((pt) => pt.label.toLowerCase() !== name.toLowerCase()),
      }));
      if (labels().length === had)
        throw new Error(
          `--remove: nothing called "${name}" (series: ${current.series.map((s) => s.name || '(unnamed)').join(', ')}; categories: ${labels().join(', ')})`,
        );
    }
  }
  // Rename series or labels.
  const rename = str(p.rename);
  if (rename !== undefined) {
    for (const [from, to] of pairs(rename)) {
      if (to === '') throw new Error(`--rename "${from}" needs a new name: "old: new"`);
      let hit = false;
      series = series.map((s) => {
        if (s.name.toLowerCase() === from.toLowerCase()) {
          hit = true;
          return { ...s, name: to };
        }
        return {
          ...s,
          points: s.points.map((pt) => {
            if (pt.label.toLowerCase() === from.toLowerCase()) {
              hit = true;
              return { ...pt, label: to };
            }
            return pt;
          }),
        };
      });
      if (!hit) throw new Error(`--rename: nothing called "${from}"`);
    }
  }
  // Sort categories by the first series' value.
  const sort = str(p.sort);
  if (sort === 'asc' || sort === 'desc') {
    const order = (series[0]?.points ?? [])
      .map((pt, i) => ({ i, v: pt.value }))
      .sort((a, b) => (sort === 'asc' ? a.v - b.v : b.v - a.v))
      .map((o) => o.i);
    series = series.map((s) => ({
      ...s,
      points: order
        .map((i) => s.points[i])
        .filter((pt): pt is { label: string; value: number; x?: number } => pt !== undefined),
    }));
  }

  const words: Record<string, unknown> = {};
  for (const key of ['title', 'subtitle', 'unit', 'x_label', 'y_label', 'note', 'size'] as const) {
    const v = str(p[key]);
    if (v !== undefined) words[key] = v;
  }
  const highlight = str(p.highlight);
  const type = str(p.type);
  if (type !== undefined && !(CHART_TYPES as readonly string[]).includes(type)) {
    throw new Error(`--type "${type}" is not one of ${CHART_TYPES.join(', ')}`);
  }
  // The style: the current one, with the new knobs on top (a `style` JSON or the flat keys).
  const styleInput: Record<string, unknown> = {};
  if (typeof p.style === 'string' && p.style.trim().startsWith('{')) {
    try {
      Object.assign(styleInput, JSON.parse(p.style) as Record<string, unknown>);
    } catch {
      /* ignored */
    }
  }
  for (const key of STYLE_KEYS) {
    const v = p[key];
    if (v !== undefined && v !== null && v !== '') styleInput[key] = v;
  }
  const styleChange = normalizeStyle(styleInput);
  // A new look resets the knobs the old look implied, unless they are set again now.
  const baseStyle: ChartStyle | undefined =
    styleChange?.look !== undefined && styleChange.look !== current.style?.look
      ? { look: styleChange.look }
      : current.style;
  const style: ChartStyle | undefined =
    styleChange !== undefined ? { ...baseStyle, ...styleChange } : baseStyle;

  const rebuilt = normalizeChartSpec({
    ...current,
    ...(type !== undefined ? { type } : {}),
    ...words,
    series,
    ...(highlight !== undefined
      ? highlight.toLowerCase() === 'none'
        ? { highlight: '' }
        : { highlight }
      : {}),
    ...(style !== undefined ? { style } : {}),
  });
  // normalizeChartSpec drops an empty highlight; keep every other field as it was.
  return { ...rebuilt, ...(style !== undefined ? { style } : {}) };
}

/** What differs between two specs, in words. */
export function summarizeChange(a: ChartSpec, b: ChartSpec): string[] {
  const out: string[] = [];
  if (a.type !== b.type) out.push(`type ${a.type} → ${b.type}`);
  if (a.title !== b.title) out.push('the title');
  if (a.subtitle !== b.subtitle) out.push('the subtitle');
  if (a.unit !== b.unit) out.push('the unit');
  if (a.note !== b.note) out.push('the note');
  if (a.highlight !== b.highlight) {
    out.push(`the highlight${b.highlight !== undefined ? ` (${b.highlight})` : ' (none)'}`);
  }
  if (a.xLabel !== b.xLabel || a.yLabel !== b.yLabel) out.push('the axis titles');
  if (a.size !== b.size) out.push(`the size (${b.size ?? 'card'})`);
  const nameOf = (s: { name: string }): string => s.name || 'a series';
  if (b.series.length > a.series.length) {
    out.push(`added ${b.series.slice(a.series.length).map(nameOf).join(', ')}`);
  } else if (b.series.length < a.series.length) {
    const kept = new Set(b.series.map((s) => s.name));
    const gone = a.series.filter((s) => !kept.has(s.name));
    out.push(
      `removed ${(gone.length > 0 ? gone : a.series.slice(b.series.length)).map(nameOf).join(', ')}`,
    );
  } else if (a.series.some((s, i) => s.name !== b.series[i]?.name)) {
    out.push('a name');
  }
  const points = (spec: ChartSpec): string =>
    JSON.stringify(
      spec.series.slice(0, Math.min(a.series.length, b.series.length)).map((s) => s.points),
    );
  if (points(a) !== points(b)) out.push('the data');
  if (JSON.stringify(a.style ?? {}) !== JSON.stringify(b.style ?? {})) out.push('the look');
  return out;
}

export type { ChartType, LookName };
