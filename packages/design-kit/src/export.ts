/**
 * THE KITS FOR EVERY OTHER READER — Python's office pipeline, CSS, a diagram.
 *
 * "Python and TS read the same tokens" (VQ-04's acceptance): the document
 * pipeline in tools/office-gen is Python, and it must dress a deck or a report
 * in the same kit the chart beside it wears. So the kits are exported, as
 * data, to `tools/office-gen/design_tokens.json` — generated from these
 * files, committed, and held to them by a test (`export.test.ts`: the file on
 * disk must equal `exportTokens()` byte for byte; `pnpm --filter
 * @pi-desktop/design-kit export-tokens` rewrites it). tools/office-gen's
 * `design_tokens.py` reads it.
 *
 * Also here: a kit as CSS custom properties (a page, a slide, a title card
 * built in HTML), and as the colours a diagram is drawn in.
 */
import { contrastRatio } from '@pi-desktop/charts';
import { fitContrast } from './brand.ts';
import { DEFAULT_KIT_ID, KITS } from './kits.ts';
import {
  COLOUR_ROLES,
  currentPlatform,
  type Kit,
  type KitColours,
  type KitMode,
  type Platform,
} from './schema.ts';

export const TOKENS_SCHEMA = 1;

/** The exported file's shape: every kit, whole, keyed by id, in picker order. */
export interface DesignTokensFile {
  readonly schema: typeof TOKENS_SCHEMA;
  /** Where it came from, so nobody edits the copy. */
  readonly generatedFrom: string;
  readonly default: string;
  readonly order: readonly string[];
  readonly kits: Readonly<Record<string, Kit>>;
}

export function exportTokens(kits: readonly Kit[] = KITS): DesignTokensFile {
  return {
    schema: TOKENS_SCHEMA,
    generatedFrom:
      'packages/design-kit/src/kits/*.json — do not edit; run `pnpm --filter @pi-desktop/design-kit export-tokens`',
    default: DEFAULT_KIT_ID,
    order: kits.map((k) => k.id),
    kits: Object.fromEntries(kits.map((k) => [k.id, k])),
  };
}

/** The file's text: two-space JSON and a trailing newline, the repo's JSON style. */
export function tokensJson(kits: readonly Kit[] = KITS): string {
  return `${JSON.stringify(exportTokens(kits), null, 2)}\n`;
}

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * A kit as CSS custom properties for one mode: `--kit-paper`, `--kit-on-accent`,
 * `--kit-series-1…`, the fonts for this platform, the slide and page scales.
 * One declaration block, no selector — the caller scopes it.
 */
export function kitCssVars(
  kit: Kit,
  mode: KitMode,
  platform: Platform = currentPlatform(),
): string {
  const c: KitColours = kit[mode];
  const lines: string[] = [];
  for (const role of COLOUR_ROLES) lines.push(`--kit-${kebab(role)}: ${c[role]};`);
  c.series.forEach((hex, i) => {
    lines.push(`--kit-series-${i + 1}: ${hex};`);
  });
  lines.push(`--kit-font-display: ${kit.type.display[platform]};`);
  lines.push(`--kit-font-text: ${kit.type.text[platform]};`);
  lines.push(`--kit-font-mono: ${kit.type.mono[platform]};`);
  for (const [k, v] of Object.entries(kit.type.weights)) lines.push(`--kit-weight-${k}: ${v};`);
  for (const [k, v] of Object.entries(kit.type.slide)) lines.push(`--kit-slide-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(kit.type.page)) lines.push(`--kit-page-${k}: ${v}px;`);
  lines.push(`--kit-leading-body: ${kit.type.lineHeight.body};`);
  lines.push(`--kit-leading-heading: ${kit.type.lineHeight.heading};`);
  lines.push(`--kit-tracking-display: ${kit.type.tracking.display}em;`);
  lines.push(`--kit-tracking-caps: ${kit.type.tracking.caps}em;`);
  lines.push(`--kit-unit: ${kit.space.unit}px;`);
  lines.push(`--kit-margin: ${kit.space.margin}px;`);
  lines.push(`--kit-gutter: ${kit.space.gutter}px;`);
  lines.push(`--kit-radius-small: ${kit.space.radius.small}px;`);
  lines.push(`--kit-radius-card: ${kit.space.radius.card}px;`);
  lines.push(`--kit-stroke: ${kit.space.stroke}px;`);
  lines.push(`--kit-ease: ${kit.motion.ease};`);
  lines.push(`--kit-enter: ${kit.motion.enter}s;`);
  return lines.join('\n');
}

/**
 * The colours and type a diagram is drawn in — the kit's roles put to a
 * diagram's jobs. The renderer (the app's Mermaid window) maps these onto its
 * own theme variables; nothing here knows Mermaid.
 *
 *   - a node is the surface with an ink edge; a decision is the same, drawn as
 *     a diamond; a group is the tint;
 *   - the flow's FIRST step stands on the deep ground, its LAST on the accent —
 *     where it starts and where it ends are the two things read first;
 *   - a failure path (an edge labelled "no", "fail", "retry"…) is drawn in
 *     `bad`, and a step reached only by failures sits in bad's pale field.
 */
export interface DiagramTheme {
  readonly mode: KitMode;
  readonly paper: string;
  readonly surface: string;
  readonly ink: string;
  readonly mute: string;
  readonly line: string;
  readonly group: string;
  readonly groupEdge: string;
  readonly start: { readonly fill: string; readonly text: string };
  readonly end: { readonly fill: string; readonly text: string };
  readonly fail: { readonly stroke: string; readonly fill: string; readonly text: string };
  readonly series: readonly string[];
  readonly font: string;
  readonly titleFont: string;
  readonly titleWeight: number;
  readonly fontSize: number;
  readonly radius: number;
  readonly curve: 'basis' | 'linear' | 'step';
  readonly look: 'clean' | 'sketch';
}

/** a over b at `alpha`, both #RRGGBB — the pale field of a colour on a ground. */
export function over(a: string, b: string, alpha: number): string {
  const ch = (h: string, i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
  const mix = (i: number): string =>
    Math.round(ch(a, i) * alpha + ch(b, i) * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  return `#${mix(1)}${mix(3)}${mix(5)}`.toUpperCase();
}

/** The first step on a dark ground: the accent's shade, and whichever ink reads best on it. */
function darkStart(c: KitColours): { fill: string; text: string } {
  const fill = over(c.accent, c.surface, 0.34);
  const text = [c.onDeep, c.ink, c.paper, '#FFFFFF', '#000000'].sort(
    (a, b) => contrastRatio(b, fill) - contrastRatio(a, fill),
  )[0] as string;
  return { fill, text };
}

export function diagramTheme(
  kit: Kit,
  mode: KitMode,
  platform: Platform = currentPlatform(),
): DiagramTheme {
  const c = kit[mode];
  const failFill = over(c.bad, c.surface, mode === 'light' ? 0.1 : 0.16);
  return {
    mode,
    paper: c.paper,
    surface: c.surface,
    ink: c.ink,
    mute: c.mute,
    line: mode === 'light' ? over(c.ink, c.paper, 0.62) : over(c.ink, c.paper, 0.55),
    group: c.tint,
    groupEdge: c.line,
    // On a dark ground the kit's deep all but vanishes into the paper, so the
    // first step there is the accent's own shade, deep enough to carry onDeep.
    start: mode === 'light' ? { fill: c.deep, text: c.onDeep } : darkStart(c),
    end: { fill: c.accent, text: c.onAccent },
    fail: {
      stroke: c.bad,
      fill: failFill,
      // `bad` clears 4.5:1 on the surface; on its own pale field it can dip
      // under by a hair, so the label steps a shade deeper there.
      text: fitContrast(c.bad, [failFill], 4.5),
    },
    series: c.series,
    font: kit.type.text[platform],
    titleFont: kit.type.display[platform],
    titleWeight: kit.type.weights.bold,
    fontSize: kit.diagram.fontSize,
    radius: kit.diagram.radius,
    curve: kit.diagram.curve,
    look: kit.diagram.look,
  };
}
