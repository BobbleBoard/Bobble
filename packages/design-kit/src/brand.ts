/**
 * A BRAND — a kit made from a picture or from a project's `brand.md`.
 *
 * Two ways in (deliverables/research/visual-quality.md §4.0 principle 2, §4.6):
 *
 *   - FROM A PICTURE: a logo, a screenshot, a brand page. `paletteFromPixels`
 *     (@pi-desktop/charts, the reader `chart --from_image` already uses) finds
 *     its colours; the most present becomes the accent.
 *   - FROM `brand.md`: `<project>/.bobble/brand.md`, HyperFrames' `frame.md`
 *     idea — the normative tokens in a frontmatter block, the do's and don'ts
 *     in prose under it ("name what's sacred, let the agent stage the rest").
 *     It wins over the Design setting's kit, because it is about THIS project.
 *
 * Either way the brand starts from a base kit and replaces what it names,
 * then the result is REPAIRED until it clears the same gates as a built-in
 * kit (validate.ts) — a brand teal too pale to read as a bar is darkened
 * until it reads; and because the user's brief rules purple out of everything the
 * app makes, a violet logo colour is turned to the nearest blue or pink, and
 * the notes say so. What cannot be repaired is reported, never hidden: the
 * caller gets the kit, the notes and the validation report.
 *
 * Pure: the picture arrives as RGBA bytes (the app decodes it), the file as text.
 */
import { contrastRatio, fromOklch, oklch, paletteFromPixels } from '@pi-desktop/charts';
import { kitOrDefault } from './kits.ts';
import {
  type FontStacks,
  type Hex,
  type Kit,
  type KitColours,
  type KitMode,
  normalizeKitHex,
} from './schema.ts';
import {
  APP_GROUNDS,
  checkColours,
  isLavender,
  isPurple,
  KIT_GATES,
  type KitReport,
  validateKit,
} from './validate.ts';

/** What a brand says about itself; every field optional — the base kit fills the rest. */
export interface BrandSpec {
  readonly name?: string;
  /** The base kit's id. */
  readonly kit?: string;
  readonly accent?: Hex;
  readonly highlight?: Hex;
  /** More brand colours, most important first: they lead the chart series. */
  readonly palette?: readonly Hex[];
  readonly ink?: Hex;
  readonly paper?: Hex;
  readonly fonts?: { readonly display?: string; readonly text?: string };
  /** Words for pictures made in this brand. */
  readonly image?: string;
}

export interface BrandResult {
  readonly kit: Kit;
  /** What was changed to make it work, one sentence each. */
  readonly notes: readonly string[];
  readonly report: KitReport;
}

// ── brand.md ────────────────────────────────────────────────────────────────

export interface BrandFile {
  readonly brand: BrandSpec;
  /** The prose under the frontmatter: the do's and don'ts, for a model to read. */
  readonly prose: string;
  /** Lines of the frontmatter that could not be read, said plainly. */
  readonly problems: readonly string[];
}

/** One scalar as YAML writes it: quoted or bare, a trailing comment dropped. */
function scalar(raw: string): string {
  const t = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(t);
  if (quoted !== null) return (quoted[1] ?? quoted[2] ?? '').replace(/''/g, "'");
  return t.replace(/\s+#.*$/, '').trim();
}

/** `[a, "b", c]` → the items; anything else → undefined. */
function inlineList(raw: string): string[] | undefined {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return undefined;
  return (t.slice(1, -1).match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [])
    .map((s) => scalar(s))
    .filter((s) => s !== '');
}

/**
 * The small YAML a brand file needs: `key: value`, quoted strings, inline
 * `[lists]`, `- item` lists and one level of nested keys, `#` comments.
 * Anything richer is reported as a problem rather than guessed at.
 */
export function readFrontmatter(block: string): {
  values: Record<string, string | string[] | Record<string, string>>;
  problems: string[];
} {
  const values: Record<string, string | string[] | Record<string, string>> = {};
  const problems: string[] = [];
  let parent: string | null = null;
  for (const [i, line] of block.split('\n').entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(line);
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && parent !== null) {
      const prev = values[parent];
      const list = Array.isArray(prev) ? prev : [];
      list.push(scalar(item[1] ?? ''));
      values[parent] = list;
      continue;
    }
    const kv = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv === null) {
      problems.push(`line ${i + 1} is not "key: value": ${line.trim()}`);
      continue;
    }
    const key = (kv[1] ?? '').toLowerCase();
    const rest = kv[2] ?? '';
    if (indented && parent !== null) {
      const prev = values[parent];
      const map =
        prev !== undefined && !Array.isArray(prev) && typeof prev === 'object' ? prev : {};
      map[key] = scalar(rest);
      values[parent] = map;
      continue;
    }
    if (rest.trim() === '') {
      parent = key;
      continue;
    }
    parent = null;
    values[key] = inlineList(rest) ?? scalar(rest);
  }
  return { values, problems };
}

/**
 * Read a `brand.md`: the frontmatter's tokens and the prose under it. Colour
 * keys are read loosely (`accent`, `primary`, `brand`; `colors:` / `colours:`
 * as a nested block) because a person writes this file by hand.
 */
export function parseBrandMd(text: string): BrandFile {
  const m = /^﻿?---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)$/.exec(text);
  if (m === null) {
    return {
      brand: {},
      prose: text.trim(),
      problems: text.trim() === '' ? [] : ['no frontmatter: put the tokens between two --- lines'],
    };
  }
  const { values, problems } = readFrontmatter(m[1] ?? '');
  const nested = (k: string): Record<string, string> => {
    const v = values[k];
    return v !== undefined && !Array.isArray(v) && typeof v === 'object' ? v : {};
  };
  const colours = { ...nested('colors'), ...nested('colours') };
  const first = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = values[k] ?? colours[k];
      if (typeof v === 'string' && v !== '') return v;
    }
    return undefined;
  };
  const colour = (label: string, ...keys: string[]): Hex | undefined => {
    const raw = first(...keys);
    if (raw === undefined) return undefined;
    const hex = normalizeKitHex(raw);
    if (hex === undefined) problems.push(`${label} "${raw}" is not a colour (write it #RRGGBB)`);
    return hex;
  };
  const paletteRaw = values.palette ?? colours.palette;
  const palette = (
    Array.isArray(paletteRaw)
      ? paletteRaw
      : typeof paletteRaw === 'string'
        ? paletteRaw.split(/[\s,]+/)
        : []
  )
    .map((c) => {
      const hex = normalizeKitHex(c);
      if (hex === undefined && c.trim() !== '') problems.push(`palette "${c}" is not a colour`);
      return hex;
    })
    .filter((c): c is Hex => c !== undefined);
  const fonts = nested('fonts');
  const brand: {
    -readonly [K in keyof BrandSpec]: BrandSpec[K];
  } = {};
  const name = first('name', 'brand');
  if (name !== undefined && normalizeKitHex(name) === undefined) brand.name = name;
  const kit = first('kit', 'base');
  if (kit !== undefined) brand.kit = kit;
  const accent = colour('accent', 'accent', 'primary', 'brand-colour', 'brand-color');
  if (accent !== undefined) brand.accent = accent;
  const highlight = colour('highlight', 'highlight', 'secondary');
  if (highlight !== undefined) brand.highlight = highlight;
  const ink = colour('ink', 'ink', 'text');
  if (ink !== undefined) brand.ink = ink;
  const paper = colour('paper', 'paper', 'background', 'ground');
  if (paper !== undefined) brand.paper = paper;
  if (palette.length > 0) brand.palette = palette;
  const display = fonts.display ?? first('display-font', 'heading-font');
  const textFont = fonts.text ?? fonts.body ?? first('text-font', 'body-font');
  if (display !== undefined || textFont !== undefined) {
    brand.fonts = {
      ...(display !== undefined ? { display } : {}),
      ...(textFont !== undefined ? { text: textFont } : {}),
    };
  }
  const image = first('image', 'imagery', 'image-style');
  if (image !== undefined) brand.image = image;
  return { brand, prose: (m[2] ?? '').trim(), problems };
}

// ── colour repair ───────────────────────────────────────────────────────────

/** Two colours mixed in OKLab: t = 0 → a, 1 → b. */
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  const pa = oklch(a);
  const pb = oklch(b);
  const la = [
    pa.l,
    pa.c * Math.cos((pa.h * Math.PI) / 180),
    pa.c * Math.sin((pa.h * Math.PI) / 180),
  ];
  const lb = [
    pb.l,
    pb.c * Math.cos((pb.h * Math.PI) / 180),
    pb.c * Math.sin((pb.h * Math.PI) / 180),
  ];
  const m = la.map((v, i) => v + ((lb[i] as number) - v) * t) as [number, number, number];
  const c = Math.hypot(m[1], m[2]);
  const h = ((Math.atan2(m[2], m[1]) * 180) / Math.PI + 360) % 360;
  return fromOklch(m[0], c, h);
}

/**
 * The nearest colour that is not purple: the hue turned away from the violet
 * band — toward blue when it sits on the blue side, toward pink otherwise —
 * keeping its lightness and chroma. `undefined` when nothing needed turning.
 */
export function dePurple(colour: Hex): Hex | undefined {
  if (!isPurple(colour) && !isLavender(colour)) return undefined;
  const { l, c, h } = oklch(colour);
  // Which way is nearer: the violet band sits between the blues (OKLCH ~260°)
  // and the pinks (~340°).
  const toBlue = h < 300;
  for (let step = 1; step <= 90; step += 1) {
    const next = fromOklch(l, c, (h + (toBlue ? -step : step) + 360) % 360);
    if (!isPurple(next) && !isLavender(next)) return next;
  }
  return fromOklch(l, Math.min(c, 0.03), h);
}

/**
 * The colour moved in lightness only — darker on light grounds, lighter on
 * dark ones — until it reaches `min` against every ground. Hue kept; chroma
 * only where the gamut runs out; and never into the violet band.
 */
export function fitContrast(colour: Hex, grounds: readonly Hex[], min: number): Hex {
  const ok = (c: Hex): boolean => grounds.every((g) => contrastRatio(c, g) >= min);
  if (ok(colour)) return colour;
  const { l, c, h } = oklch(colour);
  const groundL = grounds.reduce((s, g) => s + oklch(g).l, 0) / Math.max(1, grounds.length);
  const dir = groundL > 0.5 ? -1 : 1;
  for (let step = 1; step <= 100; step += 1) {
    const shade = fromOklch(Math.max(0, Math.min(1, l + dir * step * 0.01)), c, h);
    // A blue's shades walk toward violet at the same OKLCH hue: a violet
    // brand's accent, already turned to blue, came back #6D40F2 as words
    // (brand.test.ts). A shade in the band is turned out of it before it is
    // judged — the user: no purple, not even on the way to a contrast.
    const next = dePurple(shade) ?? shade;
    if (ok(next)) return next;
  }
  return dir < 0 ? '#000000' : '#FFFFFF';
}

/** The text colour that reads best on a fill: the kit's ink or its paper, white or black as a last resort. */
function textOn(fill: Hex, candidates: readonly Hex[], min: number): Hex | undefined {
  const best = [...candidates, '#FFFFFF', '#000000'].sort(
    (a, b) => contrastRatio(b, fill) - contrastRatio(a, fill),
  )[0];
  return best !== undefined && contrastRatio(best, fill) >= min ? best : undefined;
}

// ── a brand → a kit ─────────────────────────────────────────────────────────

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function withFamily(stacks: FontStacks, family: string | undefined): FontStacks {
  if (family === undefined || family.trim() === '') return stacks;
  const f = family.includes(',') ? family : `'${family.replace(/'/g, '')}'`;
  return {
    mac: `${f}, ${stacks.mac}`,
    windows: `${f}, ${stacks.windows}`,
    linux: `${f}, ${stacks.linux}`,
  };
}

interface ModePlan {
  readonly mode: KitMode;
  readonly base: KitColours;
  readonly paper?: Hex;
  readonly ink?: Hex;
  readonly accent?: Hex;
  readonly highlight?: Hex;
  readonly palette: readonly Hex[];
}

function lightnessOf(c: Hex): number {
  return oklch(c).l;
}

/** One mode of the brand kit: the base's colours with the brand's put in and repaired. */
function brandColours(plan: ModePlan, notes: string[]): KitColours {
  const { mode, base } = plan;
  const paper = plan.paper ?? base.paper;
  const grounds = [paper, base.surface, ...APP_GROUNDS[mode]];
  let ink = base.ink;
  if (plan.ink !== undefined && contrastRatio(plan.ink, paper) >= KIT_GATES.text) ink = plan.ink;
  else if (plan.ink !== undefined) {
    notes.push(
      `${mode}: the brand ink ${plan.ink} is too faint on ${paper}; the kit's ink is used`,
    );
  }
  const mark = (c: Hex, what: string): Hex => {
    let out = c;
    const turned = dePurple(out);
    if (turned !== undefined) {
      notes.push(
        `${mode}: the ${what} ${out} is purple — turned to ${turned} (no purple in a kit)`,
      );
      out = turned;
    }
    const fitted = fitContrast(out, grounds, KIT_GATES.mark);
    if (fitted !== out) {
      notes.push(
        `${mode}: the ${what} ${out} is too ${mode === 'light' ? 'pale' : 'dark'} to read as a mark — ${fitted}`,
      );
      out = fitted;
    }
    return out;
  };
  let accent = plan.accent !== undefined ? mark(plan.accent, 'accent') : base.accent;
  // Text has to sit on the accent: darken (light) / lighten (dark) until one of
  // the kit's inks, white or black reads on it.
  let onAccent = textOn(accent, [ink, paper, base.onAccent], KIT_GATES.secondary);
  for (let step = 0; onAccent === undefined && step < 40; step += 1) {
    const { l, c, h } = oklch(accent);
    accent = fromOklch(l + (mode === 'light' ? -0.01 : 0.01), c, h);
    onAccent = textOn(accent, [ink, paper, base.onAccent], KIT_GATES.secondary);
  }
  const highlight =
    plan.highlight !== undefined ? mark(plan.highlight, 'highlight') : base.highlight;
  const brandMarks = plan.palette.map((c, i) => mark(c, `palette colour ${i + 1}`));
  // Deep: the accent's own hue, sunk to a hero ground.
  const a = oklch(accent);
  const deep =
    plan.accent !== undefined
      ? fromOklch(mode === 'light' ? 0.27 : 0.22, Math.min(a.c, 0.07), a.h)
      : base.deep;
  const onDeep = textOn(deep, [base.onDeep, paper, ink], KIT_GATES.onDeep) ?? base.onDeep;
  const tint =
    plan.accent !== undefined ? mixHex(accent, paper, mode === 'light' ? 0.88 : 0.82) : base.tint;
  // The accent as words: itself when it reads at 4.5:1 on every ground a label
  // sits on, else its nearest deeper (lighter, on dark) shade that does — with
  // a hair of headroom, so a reader rounding sRGB differently still clears it.
  const wordGrounds = [paper, base.surface, tint];
  const accentInk = wordGrounds.every((g) => contrastRatio(accent, g) >= KIT_GATES.secondary)
    ? accent
    : fitContrast(accent, wordGrounds, KIT_GATES.secondary + 0.1);
  const colours: KitColours = {
    ...base,
    paper,
    ink,
    accent,
    onAccent: onAccent ?? base.onAccent,
    accentInk,
    deep,
    onDeep,
    tint,
    highlight,
    series: base.series,
  };
  // The series: the brand's colours lead, the base kit fills in behind them —
  // tried in that order, the first that clears the chart checks wins.
  const lead = [...new Set([accent, ...brandMarks])];
  const fill = base.series.filter((c) => !lead.includes(c));
  const hlInSeries = (s: Hex[]): Hex[] =>
    s.includes(highlight) || s.length < 2 ? s : [s[0] as Hex, highlight, ...s.slice(1)];
  const tries: Array<{ series: Hex[]; why: string }> = [
    {
      series: hlInSeries([...lead, ...fill]).slice(0, 6),
      why: 'the brand colours lead the series',
    },
    {
      series: hlInSeries([accent, ...base.series.slice(1).filter((c) => c !== accent)]).slice(0, 6),
      why: 'the accent leads the kit series',
    },
    { series: [...base.series], why: 'the kit series' },
  ];
  for (const t of tries) {
    if (t.series.length < 5) continue;
    const probe = { ...colours, series: t.series };
    const seriesIssues = checkColours(probe, mode).filter(
      (i) => i.rule === 'series' || i.rule === 'highlight',
    );
    if (seriesIssues.length === 0) {
      if (t !== tries[0] && plan.palette.length > 0) {
        notes.push(`${mode}: the brand's colours could not all be told apart in a chart; ${t.why}`);
      }
      return probe;
    }
  }
  return colours;
}

/**
 * A kit for a brand: the base kit (the brand's own `kit`, else `base`, else
 * the default) with the brand's colours and fonts put in and repaired.
 */
export function kitFromBrand(brand: BrandSpec, base?: Kit): BrandResult {
  const from = brand.kit !== undefined ? kitOrDefault(brand.kit) : (base ?? kitOrDefault());
  const notes: string[] = [];
  // A dark brand paper is the DARK mode's ground; the light mode keeps the kit's.
  const paperIsDark = brand.paper !== undefined && lightnessOf(brand.paper) < 0.5;
  const palette = brand.palette ?? [];
  const light = brandColours(
    {
      mode: 'light',
      base: from.light,
      ...(brand.paper !== undefined && !paperIsDark ? { paper: brand.paper } : {}),
      ...(brand.ink !== undefined && !paperIsDark ? { ink: brand.ink } : {}),
      ...(brand.accent !== undefined ? { accent: brand.accent } : {}),
      ...(brand.highlight !== undefined ? { highlight: brand.highlight } : {}),
      palette,
    },
    notes,
  );
  const dark = brandColours(
    {
      mode: 'dark',
      base: from.dark,
      ...(paperIsDark && brand.paper !== undefined ? { paper: brand.paper } : {}),
      ...(brand.accent !== undefined ? { accent: brand.accent } : {}),
      ...(brand.highlight !== undefined ? { highlight: brand.highlight } : {}),
      palette,
    },
    notes,
  );
  const name = brand.name ?? 'Brand';
  const kit: Kit = {
    ...from,
    id: `brand-${slug(name) || 'custom'}`,
    name,
    about: `${name}'s colours on ${from.name}.`,
    light,
    dark,
    type: {
      ...from.type,
      display: withFamily(from.type.display, brand.fonts?.display),
      text: withFamily(from.type.text, brand.fonts?.text),
    },
    image: brand.image !== undefined ? { style: brand.image } : from.image,
  };
  return { kit, notes, report: validateKit(kit) };
}

/**
 * A kit from a picture's pixels (RGBA, as the app's `pixels` bridge hands
 * them over): its most present colour is the accent, the rest lead the
 * series; a picture that is mostly one near-white or near-black says which
 * paper it wants.
 */
export function kitFromPixels(
  rgba: Uint8Array,
  opts: { name?: string; base?: Kit } = {},
): BrandResult {
  const found = paletteFromPixels(rgba, 6);
  const [first, ...rest] = found.palette;
  return kitFromBrand(
    {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(first !== undefined ? { accent: first } : {}),
      palette: rest,
      ...(found.background !== undefined && lightnessOf(found.background) < 0.5
        ? { paper: found.background }
        : {}),
    },
    opts.base,
  );
}
