import { contrastRatio } from '@pi-desktop/charts';
import { describe, expect, it } from 'vitest';
import { diagramTheme, type exportTokens, kitCssVars, over, tokensJson } from './export.ts';
import { KITS, kitOrDefault } from './kits.ts';
import { parseKit } from './schema.ts';

describe('the tokens Python reads (tools/office-gen/design_tokens.json)', () => {
  /*
   * "Python and TS read the same tokens" — the file on disk IS the export of
   * these kits, byte for byte. When a kit changes, regenerate it:
   *   pnpm --filter @pi-desktop/design-kit export-tokens
   * (tools/office-gen/tests/test_design_tokens.py reads the same file from
   * the Python side and checks it against the kit files too.)
   */
  it('is the export of the kits, unchanged', async () => {
    await expect(tokensJson()).toMatchFileSnapshot('../../../tools/office-gen/design_tokens.json');
  });

  it('round-trips: every exported kit parses back to itself', () => {
    const file = JSON.parse(tokensJson()) as ReturnType<typeof exportTokens>;
    expect(file.order).toEqual(KITS.map((k) => k.id));
    expect(file.kits[file.default]).toBeDefined();
    for (const kit of KITS) expect(parseKit(file.kits[kit.id])).toEqual(kit);
  });
});

describe('kitCssVars', () => {
  it('names every role, the series, the fonts for the platform and the scales', () => {
    const css = kitCssVars(kitOrDefault('fog'), 'dark', 'linux');
    expect(css).toContain('--kit-paper: #161718;');
    expect(css).toContain('--kit-on-accent: #161718;');
    expect(css).toContain('--kit-series-6: #CAD3D5;');
    expect(css).toContain('--kit-font-text: Inter,');
    expect(css).toContain('--kit-slide-hero: 112px;');
    expect(css).not.toMatch(/undefined|NaN/);
  });
});

describe('diagramTheme', () => {
  it('puts the kit roles to a diagram’s jobs, and every label reads on its fill', () => {
    for (const kit of KITS) {
      for (const mode of ['light', 'dark'] as const) {
        const t = diagramTheme(kit, mode, 'mac');
        const at = `${kit.id} ${mode}`;
        expect(contrastRatio(t.ink, t.surface), `${at} node label`).toBeGreaterThanOrEqual(7);
        expect(
          contrastRatio(t.start.text, t.start.fill),
          `${at} start label`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.end.text, t.end.fill), `${at} end label`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrastRatio(t.mute, t.paper), `${at} edge label`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.line, t.paper), `${at} connector`).toBeGreaterThanOrEqual(3);
        // The failure step's own label: `bad` on bad's pale field.
        expect(contrastRatio(t.fail.text, t.fail.fill), `${at} fail label`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('over() mixes a colour onto a ground', () => {
    expect(over('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(over('#B4450E', '#FFFFFF', 0)).toBe('#FFFFFF');
  });
});
