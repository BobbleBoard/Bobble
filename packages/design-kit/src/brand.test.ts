import { contrastRatio } from '@pi-desktop/charts';
import { describe, expect, it } from 'vitest';
import { dePurple, fitContrast, kitFromBrand, kitFromPixels, parseBrandMd } from './brand.ts';
import { kitOrDefault } from './kits.ts';
import { loadProjectKit } from './project.ts';
import { describeIssues, isLavender, isPurple } from './validate.ts';

const TIDEWELL = `---
name: Tidewell
kit: paper-blue   # the base
accent: "#0E7C7B"
palette: ["#0E7C7B", '#E4572E', 2B5C8A]
colours:
  ink: "#1D1D1F"
fonts:
  display: Avenir Next
  text: Helvetica Neue
image: calm water, morning light, no text
---
Teal is the water. Orange is a leak — never decoration.
`;

describe('parseBrandMd', () => {
  it('reads the tokens in the frontmatter and keeps the prose', () => {
    const f = parseBrandMd(TIDEWELL);
    expect(f.problems).toEqual([]);
    expect(f.brand).toEqual({
      name: 'Tidewell',
      kit: 'paper-blue',
      accent: '#0E7C7B',
      palette: ['#0E7C7B', '#E4572E', '#2B5C8A'],
      ink: '#1D1D1F',
      fonts: { display: 'Avenir Next', text: 'Helvetica Neue' },
      image: 'calm water, morning light, no text',
    });
    expect(f.prose).toBe('Teal is the water. Orange is a leak — never decoration.');
  });

  it('says what it could not read instead of guessing', () => {
    const f = parseBrandMd('---\naccent: sea green\nthis is not yaml\n---\n');
    expect(f.brand.accent).toBeUndefined();
    expect(f.problems.join(' | ')).toMatch(/accent "sea green" is not a colour/);
    expect(f.problems.join(' | ')).toMatch(/line 2 is not "key: value"/);
    expect(parseBrandMd('Just prose, no tokens.').problems[0]).toMatch(/no frontmatter/);
  });

  it('reads a `- item` palette list and the loose colour names people use', () => {
    const f = parseBrandMd(
      '---\nprimary: "#1F5FD1"\npalette:\n  - "#1F5FD1"\n  - "#D9651B"\n---\n',
    );
    expect(f.brand.accent).toBe('#1F5FD1');
    expect(f.brand.palette).toEqual(['#1F5FD1', '#D9651B']);
  });
});

describe('dePurple / fitContrast', () => {
  it('turns a violet to the nearest blue or pink and leaves other colours alone', () => {
    const turned = dePurple('#7B3FF2');
    expect(turned).toBeDefined();
    expect(isPurple(turned as string)).toBe(false);
    expect(dePurple('#0F7B74')).toBeUndefined();
  });

  it('darkens a pale colour on a light ground until it reads as a mark, and lightens one on a dark ground', () => {
    const pale = fitContrast('#9FE3DD', ['#FBFAF7', '#FFFFFF'], 3);
    expect(contrastRatio(pale, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    const dim = fitContrast('#0E3A37', ['#191816'], 3);
    expect(contrastRatio(dim, '#191816')).toBeGreaterThanOrEqual(3);
    expect(fitContrast('#0F7B74', ['#FFFFFF'], 3)).toBe('#0F7B74');
  });
});

describe('kitFromBrand', () => {
  it('puts the brand in and the result clears every gate', () => {
    const r = kitFromBrand(parseBrandMd(TIDEWELL).brand);
    expect(r.report.ok, describeIssues(r.report)).toBe(true);
    expect(r.kit.id).toBe('brand-tidewell');
    expect(r.kit.light.accent).toBe('#0E7C7B');
    expect(r.kit.light.series[0]).toBe('#0E7C7B');
    expect(r.kit.light.ink).toBe('#1D1D1F');
    expect(r.kit.type.display.mac.startsWith("'Avenir Next'")).toBe(true);
  });

  it('turns a purple logo colour away from purple, and says so (the user: no purple)', () => {
    const r = kitFromBrand({ name: 'Violet', accent: '#7B3FF2' });
    expect(isPurple(r.kit.light.accent)).toBe(false);
    expect(isPurple(r.kit.dark.accent)).toBe(false);
    // Its words too: the blue it was turned to, deepened for text, walked
    // back into violet (#6D40F2) until fitContrast learned to step around it.
    expect(isPurple(r.kit.light.accentInk)).toBe(false);
    expect(isLavender(r.kit.dark.accentInk)).toBe(false);
    expect(r.notes.join(' ')).toMatch(/purple — turned to/);
    expect(r.report.ok, describeIssues(r.report)).toBe(true);
  });

  it('darkens a brand colour too pale to read, lifts it for the dark mode, and still validates', () => {
    const r = kitFromBrand({ name: 'Mint', accent: '#9FE3DD' });
    expect(contrastRatio(r.kit.light.accent, r.kit.light.paper)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(r.kit.light.onAccent, r.kit.light.accent)).toBeGreaterThanOrEqual(4.5);
    // A mint that is a mark at 3:1 is not yet words: its accentInk is deeper.
    expect(contrastRatio(r.kit.light.accentInk, r.kit.light.tint)).toBeGreaterThanOrEqual(4.5);
    expect(r.notes.join(' ')).toMatch(/too pale to read as a mark/);
    expect(r.report.ok, describeIssues(r.report)).toBe(true);
  });

  it('keeps the base kit’s ink when the brand ink cannot be read on the paper', () => {
    const r = kitFromBrand({ name: 'Faint', ink: '#BBBBBB' });
    expect(r.kit.light.ink).toBe(kitOrDefault().light.ink);
    expect(r.notes.join(' ')).toMatch(/too faint/);
  });
});

describe('kitFromPixels', () => {
  it('reads a picture: its most present colour is the accent, and the kit validates', () => {
    // A 20×20 "logo": mostly teal, an orange band, a white margin.
    const w = 20;
    const rgba = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const [r, g, b] = y < 12 ? [14, 124, 123] : y < 17 ? [228, 87, 46] : [255, 255, 255];
        rgba.set([r, g, b, 255], i);
      }
    }
    const r = kitFromPixels(rgba, { name: 'Logo' });
    expect(r.report.ok, describeIssues(r.report)).toBe(true);
    expect(r.kit.light.accent).toMatch(/^#0[DE]7[BC]7[AB]$/);
  });
});

describe('loadProjectKit — brand.md wins, then the setting, then the default', () => {
  const files = (map: Record<string, string>) => async (p: string) => {
    const hit = map[p];
    if (hit === undefined) throw new Error('ENOENT');
    return hit;
  };

  it('a project with a brand file wears its brand', async () => {
    const p = await loadProjectKit({
      root: '/w/proj',
      kitName: 'fog',
      readFile: files({ '/w/proj/.bobble/brand.md': TIDEWELL }),
    });
    expect(p.source).toBe('brand');
    expect(p.kit.light.accent).toBe('#0E7C7B');
    expect(p.prose).toMatch(/Teal is the water/);
  });

  it('with no brand file, the Design setting’s kit, else the house default', async () => {
    expect(
      (await loadProjectKit({ root: '/w/p', kitName: 'fog', readFile: files({}) })).kit.id,
    ).toBe('fog');
    const d = await loadProjectKit({ root: '/w/p', readFile: files({}) });
    expect(d.source).toBe('default');
    expect(d.kit.id).toBe('paper-blue');
    const unknown = await loadProjectKit({ kitName: 'neon' });
    expect(unknown.notes[0]).toMatch(/no kit called "neon"/);
  });
});
