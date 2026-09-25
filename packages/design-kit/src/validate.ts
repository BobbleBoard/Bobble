/**
 * WHAT EVERY KIT HAS TO CLEAR — contrast, colour-blind separation, no purple.
 *
 * A kit is taste, and taste is the user's call (the research, §6: "the lint
 * prevents defects; the kits carry the taste. They need the user's eyes"). What is
 * NOT taste is whether the words can be read and the series told apart, so
 * those are numbers a kit must clear in BOTH modes before anything draws with
 * it — the same numbers the chart looks clear (VQ-03), computed by the same
 * code (@pi-desktop/charts palette-check.ts), so a kit and a look can never
 * disagree about what "readable" means:
 *
 *   - ink on its paper, surface and tint at 7:1 (body text, WCAG AAA);
 *   - secondary text (mute), text on the accent and the accent as words
 *     (accentInk, on paper, surface and tint) at 4.5:1 (AA);
 *   - text on the deep ground at 7:1 (a hero is read across a room);
 *   - the semantic colours at 4.5:1, because they are also TEXT — a "no"
 *     on a diagram's failure edge, a "+9%" in a KPI row;
 *   - the accent, the highlight and every series colour at 3:1 as a mark, on
 *     the kit's own grounds AND on the app's thread grounds, where a chart
 *     card in the chat is drawn;
 *   - the series as a chart look is checked (neighbours ≥ 15 ΔE, ≥ 8 for a
 *     protan/deutan reader, the highlight against every colour);
 *   - good against bad, and the accent against bad, ≥ 15 ΔE — a diagram draws
 *     a finished step and a failed one side by side;
 *   - no purple anywhere: the user's design brief ("NOT violet blue purple"), the
 *     same 255–300° hue band the chart looks are tested against, and no light
 *     blue drifting to lavender (OKLCH hue past 262°).
 *
 * Pure.
 */
import {
  contrastRatio,
  hue,
  judgePairs,
  lookPairs,
  measurePair,
  oklch,
  PALETTE_GATES,
} from '@pi-desktop/charts';
import { COLOUR_ROLES, type Hex, type Kit, type KitColours, type KitMode } from './schema.ts';

export const KIT_GATES = {
  /** Body text: ink on paper, surface and tint. */
  text: 7,
  /** Secondary text, text on the accent, the accent as words. */
  secondary: 4.5,
  /** Text on the deep ground. */
  onDeep: 7,
  /** good / bad / warn — they are text too. */
  semantic: 4.5,
  /** A mark (a bar, a node's fill edge, a line) against the ground it sits on. */
  mark: PALETTE_GATES.markContrast,
  /** Two colours that must never read as one (good vs bad, accent vs bad). */
  apart: PALETTE_GATES.normalFloor,
  apartCvd: PALETTE_GATES.cvdTarget,
} as const;

/**
 * The thread grounds a chart card is drawn on in the app (bobble / claude /
 * codex flavours, and the static SVG's own paper) — the same grounds
 * packages/charts style.test.ts holds every look to.
 */
export const APP_GROUNDS: Readonly<Record<KitMode, readonly Hex[]>> = {
  light: ['#F5F5F7', '#FAF9F5', '#FFFFFF'],
  dark: ['#151517', '#262624', '#181818', '#1B1B1F'],
};

export type KitRule = 'contrast' | 'series' | 'apart' | 'purple' | 'lavender' | 'highlight';

export interface KitIssue {
  readonly mode: KitMode;
  readonly rule: KitRule;
  /** What failed, in words a person can act on: "mute on paper 4.1:1". */
  readonly what: string;
  readonly value: number;
  readonly need: number;
}

export interface KitReport {
  readonly id: string;
  readonly ok: boolean;
  readonly issues: readonly KitIssue[];
}

/** the user's brief: no purple. The chart looks' test band, 255°–300° of HSV hue. */
export function isPurple(colour: Hex): boolean {
  const h = hue(colour);
  return h >= 255 && h <= 300;
}

/** A light blue drifting to periwinkle reads as purple (style.test.ts "no lavender either"). */
export function isLavender(colour: Hex): boolean {
  const { l, c, h } = oklch(colour);
  return !(c < 0.04 || l < 0.6 || h <= 262 || h >= 340);
}

/** Every colour a mode uses, role by role. */
export function coloursOf(c: KitColours): Array<{ readonly role: string; readonly hex: Hex }> {
  return [
    ...COLOUR_ROLES.map((role) => ({ role, hex: c[role] })),
    ...c.series.map((hex, i) => ({ role: `series ${i + 1}`, hex })),
  ];
}

/** Check one mode's colours; the issues, or none. */
export function checkColours(c: KitColours, mode: KitMode): KitIssue[] {
  const issues: KitIssue[] = [];
  const need = (rule: KitRule, what: string, value: number, min: number): void => {
    if (value < min) issues.push({ mode, rule, what, value, need: min });
  };
  const ratio = (a: Hex, b: Hex): number => contrastRatio(a, b);
  const on = (fg: string, bg: string, min: number): void =>
    need(
      'contrast',
      `${fg} on ${bg}`,
      ratio(c[fg as keyof KitColours] as Hex, c[bg as keyof KitColours] as Hex),
      min,
    );

  for (const ground of ['paper', 'surface'] as const) {
    on('ink', ground, KIT_GATES.text);
    on('mute', ground, KIT_GATES.secondary);
    on('accentInk', ground, KIT_GATES.secondary);
    for (const role of ['good', 'bad', 'warn'] as const) on(role, ground, KIT_GATES.semantic);
  }
  on('ink', 'tint', KIT_GATES.text);
  // A callout on the tint names itself in the accent ("LEAK RESPONSE").
  on('accentInk', 'tint', KIT_GATES.secondary);
  on('onAccent', 'accent', KIT_GATES.secondary);
  on('onDeep', 'deep', KIT_GATES.onDeep);

  // Marks: on the kit's grounds and on every thread ground a card can sit on.
  const grounds: Array<{ name: string; hex: Hex }> = [
    { name: 'paper', hex: c.paper },
    { name: 'surface', hex: c.surface },
    ...APP_GROUNDS[mode].map((hex) => ({ name: `the app's ${hex}`, hex })),
  ];
  const marks: Array<{ name: string; hex: Hex }> = [
    { name: 'accent', hex: c.accent },
    { name: 'highlight', hex: c.highlight },
    ...c.series.map((hex, i) => ({ name: `series ${i + 1}`, hex })),
  ];
  for (const m of marks) {
    for (const g of grounds)
      need('contrast', `${m.name} on ${g.name}`, ratio(m.hex, g.hex), KIT_GATES.mark);
  }

  // The series as a chart look reads it: neighbours, the highlight against
  // each colour, a highlighted donut's shorter ring.
  if (c.highlight === c.series[0]) {
    issues.push({
      mode,
      rule: 'highlight',
      what: 'the highlight is series 1 — a highlighted bar would look like the rest',
      value: 0,
      need: 1,
    });
  }
  const verdict = judgePairs(lookPairs(c.series, c.highlight));
  if (verdict.worstNormal !== null && !verdict.normal) {
    need(
      'series',
      `series ${verdict.worstNormal.where} (normal vision)`,
      verdict.worstNormal.normal,
      KIT_GATES.apart,
    );
  }
  if (verdict.worstCvd !== null && verdict.cvd !== 'pass') {
    need(
      'series',
      `series ${verdict.worstCvd.where} (protan/deutan)`,
      verdict.worstCvd.cvd,
      KIT_GATES.apartCvd,
    );
  }

  // A finished step beside a failed one, a gain beside a loss.
  const goodBad = measurePair(c.good, c.bad);
  need('apart', 'good vs bad (normal vision)', goodBad.normal, KIT_GATES.apart);
  need('apart', 'good vs bad (protan/deutan)', goodBad.cvd, KIT_GATES.apartCvd);
  need(
    'apart',
    'accent vs bad (normal vision)',
    measurePair(c.accent, c.bad).normal,
    KIT_GATES.apart,
  );

  for (const { role, hex } of coloursOf(c)) {
    if (isPurple(hex)) {
      issues.push({
        mode,
        rule: 'purple',
        what: `${role} ${hex} is purple`,
        value: hue(hex),
        need: 0,
      });
    }
    if (isLavender(hex)) {
      issues.push({
        mode,
        rule: 'lavender',
        what: `${role} ${hex} drifts to lavender`,
        value: oklch(hex).h,
        need: 262,
      });
    }
  }
  return issues;
}

/** Both modes of a kit. */
export function validateKit(kit: Kit): KitReport {
  const issues = [...checkColours(kit.light, 'light'), ...checkColours(kit.dark, 'dark')];
  return { id: kit.id, ok: issues.length === 0, issues };
}

/** One line per issue, for a test failure or a tool's reply. */
export function describeIssues(report: KitReport): string {
  if (report.ok) return `${report.id}: ok`;
  return report.issues
    .map(
      (i) => `${report.id} ${i.mode}: ${i.what} — ${i.value.toFixed(1)} where ${i.need} is needed`,
    )
    .join('\n');
}
