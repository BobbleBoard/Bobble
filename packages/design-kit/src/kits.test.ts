import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KIT_ID, KIT_IDS, KITS, kitById, kitOrDefault } from './kits.ts';
import { COLOUR_ROLES, parseKit } from './schema.ts';
import { coloursOf, describeIssues, isLavender, isPurple, validateKit } from './validate.ts';

/**
 * THE ACCEPTANCE FOR VQ-04's KITS: six of them, and every one clears the
 * gates in both modes — contrast for every text role, the series as a chart
 * look reads it (normal ≥ 15 ΔE, protan/deutan ≥ 8), good apart from bad,
 * and no purple anywhere. A failure prints what failed and by how much.
 */
describe('the kits', () => {
  it('are six, the default first, each with a unique id', () => {
    expect(KITS.length).toBe(6);
    expect(KIT_IDS[0]).toBe(DEFAULT_KIT_ID);
    expect(new Set(KIT_IDS).size).toBe(KIT_IDS.length);
  });

  it('every file in ./kits is one of them (a new file is picked up or fails here)', () => {
    const files = readdirSync(new URL('./kits/', import.meta.url))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(files).toEqual([...KIT_IDS].sort());
    for (const f of files) {
      const raw = JSON.parse(readFileSync(new URL(`./kits/${f}.json`, import.meta.url), 'utf8'));
      expect(parseKit(raw).id, `${f}.json names itself`).toBe(f);
    }
  });

  it.each(KITS.map((k) => [k.id, k] as const))('%s clears every gate in both modes', (_id, kit) => {
    const report = validateKit(kit);
    expect(report.ok, describeIssues(report)).toBe(true);
  });

  /*
   * The charts' no-purple test (packages/charts style.test.ts — "never reach
   * for purple (the app brief)"), extended to every colour of every kit: the
   * same 255–300° band, and no light blue drifting to lavender.
   */
  it('never reach for purple — no role, no series colour, in either mode', () => {
    for (const kit of KITS) {
      for (const mode of ['light', 'dark'] as const) {
        for (const { role, hex } of coloursOf(kit[mode])) {
          expect(isPurple(hex), `${kit.id} ${mode} ${role} ${hex}`).toBe(false);
          expect(isLavender(hex), `${kit.id} ${mode} ${role} ${hex} (lavender)`).toBe(false);
        }
      }
    }
  });

  it('carry every role in both modes, and six series colours with the highlight among them', () => {
    for (const kit of KITS) {
      for (const mode of ['light', 'dark'] as const) {
        const c = kit[mode];
        for (const role of COLOUR_ROLES)
          expect(c[role], `${kit.id} ${mode} ${role}`).toMatch(/^#[0-9A-F]{6}$/);
        expect(c.series.length, `${kit.id} ${mode}`).toBe(6);
        expect(c.series[0], `${kit.id} ${mode}: a highlighted bar must show`).not.toBe(c.highlight);
        expect(c.series, `${kit.id} ${mode}: the highlight is one of the series`).toContain(
          c.highlight,
        );
      }
    }
  });

  it('differ from one another: no two kits share an accent', () => {
    const accents = KITS.map((k) => k.light.accent);
    expect(new Set(accents).size).toBe(accents.length);
  });
});

describe('kitById', () => {
  it('finds a kit by id, by name, and forgivingly spelt', () => {
    expect(kitById('fog')?.id).toBe('fog');
    expect(kitById('Paper & teal')?.id).toBe('paper-teal');
    expect(kitById('paper_teal')?.id).toBe('paper-teal');
    expect(kitById('  Slate Cobalt ')?.id).toBe('slate-cobalt');
    expect(kitById('neon')).toBeUndefined();
    expect(kitById(undefined)).toBeUndefined();
  });

  it('falls back to the house default', () => {
    expect(kitOrDefault('neon').id).toBe(DEFAULT_KIT_ID);
    expect(kitOrDefault().id).toBe(DEFAULT_KIT_ID);
  });
});
