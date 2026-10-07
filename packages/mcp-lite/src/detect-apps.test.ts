import { describe, expect, it } from 'vitest';
import { BRANDED_CONNECTOR_IDS, connectorIconSvg } from './connector-icons';
import {
  connectorNeedsConfig,
  type DetectAppsEnv,
  detectApps,
  detectedSuggestions,
  KNOWN_CONNECTORS,
  KNOWN_CONNECTORS_BY_ID,
  recommendedConnectors,
} from './detect-apps';
import { OFFICIAL_MARK_SOURCES, OFFICIAL_MARKS, officialMark } from './official-marks';

function env(overrides: Partial<DetectAppsEnv>): DetectAppsEnv {
  return {
    listApps: () => [],
    listProcesses: () => [],
    hasCommand: () => false,
    ...overrides,
  };
}

describe('detectApps', () => {
  it('annotates every known connector', () => {
    const out = detectApps(env({}));
    expect(out).toHaveLength(KNOWN_CONNECTORS.length);
    expect(out.every((s) => s.detected === false)).toBe(true);
  });

  it('detects a connector by installed app bundle', () => {
    const out = detectApps(env({ listApps: () => ['Slack.app', 'Safari.app'] }));
    const slack = out.find((s) => s.id === 'slack');
    expect(slack?.detected).toBe(true);
    expect(slack?.reason).toContain('Slack.app');
  });

  it('detects a connector by running process', () => {
    const out = detectApps(env({ listProcesses: () => ['Blender', 'kernel_task'] }));
    const blender = out.find((s) => s.id === 'blender');
    expect(blender?.detected).toBe(true);
    expect(blender?.reason).toContain('Blender');
  });

  it('matches case-insensitively and as a substring', () => {
    const out = detectApps(env({ listApps: () => ['slack.APP'] }));
    expect(out.find((s) => s.id === 'slack')?.detected).toBe(true);
  });

  it('carries a ready-to-add template and required env for the gallery', () => {
    const slack = detectApps(env({})).find((s) => s.id === 'slack');
    expect(slack?.template.command).toBe('npx');
    expect(slack?.requiresEnv).toContain('SLACK_MCP_XOXP_TOKEN');
  });

  it('detects a connector by CFBundleIdentifier', () => {
    const out = detectApps(env({ listBundleIds: () => ['org.blenderfoundation.blender'] }));
    const blender = out.find((s) => s.id === 'blender');
    expect(blender?.detected).toBe(true);
  });

  it('carries category + official metadata on every card', () => {
    for (const c of KNOWN_CONNECTORS) {
      expect(typeof c.category).toBe('string');
      expect(typeof c.official).toBe('boolean');
    }
  });

  it('carries a self-contained inline SVG mark on every card (no remote refs)', () => {
    for (const c of KNOWN_CONNECTORS) {
      expect(c.iconSvg, `${c.id} has no iconSvg`).toBeDefined();
      const svg = c.iconSvg ?? '';
      expect(svg.startsWith('<svg'), `${c.id} iconSvg is not an <svg>`).toBe(true);
      expect(svg).toContain('</svg>');
      // No network/remote asset references (CSP + offline). xmlns namespace is
      // fine; so is a same-document `url(#…)` — an official file's own gradient.
      expect(svg, `${c.id} iconSvg pulls a remote/external asset`).not.toMatch(
        /href="(?!#)|src=|url\((?!#)|<image/,
      );
      // Branded marks fill in a brand color (a #rrggbb hex — bright brands
      // directly, near-black brands as the --pd-connector-ink fallback); neutral
      // fallbacks are two-tone line art in a mid-tone hue of their own (the user,
      // 2026-09-17), legible on light + dark without a flip.
      if (BRANDED_CONNECTOR_IDS.includes(c.id)) {
        // A fill attribute for simple-icons marks; the official Blender file
        // carries its colours as `style="…fill:#…"`.
        expect(svg, `${c.id} branded mark has no brand color`).toMatch(
          /fill[=:]"?[^"]*#[0-9a-fA-F]{3,6}/,
        );
      } else {
        expect(svg, `${c.id} neutral mark has no hue`).toMatch(/stroke="#[0-9a-f]{6}"/);
      }
    }
  });

  it('renders github in its brand color (the catalog glyph)', () => {
    // Canonical simple-icons brand hex: GitHub #181717 is near-black, so it
    // fills via --pd-connector-ink (currentColor on dark) with the brand hex as
    // the light-theme fallback.
    expect(BRANDED_CONNECTOR_IDS).toContain('github');
    const svg = KNOWN_CONNECTORS_BY_ID.github?.iconSvg ?? '';
    // The catalog marks are filled simple-icons paths on the 24x24 canvas.
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('<path');
    expect(svg).toContain('var(--pd-connector-ink, #181717)');
    expect(svg).not.toContain('fill="currentColor"');
    // The rendered card SVG matches the source-of-truth icon map.
    expect(svg).toBe(connectorIconSvg('github'));
  });

  it("wears the brand owner's own logo file where the catalog's one colour is not the logo", () => {
    // the user (2026-09-18): "don't frankenstein or recreate logos, find a catalog
    // or official svgs" — and of the catalog Blender, "isn't correct (color)".
    // Each is the published file, verbatim: its own viewBox, its own colours.
    const expectations: Record<string, { viewBox: string; colours: string[] }> = {
      blender: { viewBox: '0 0 181 148', colours: ['fill:#ea7600', 'fill:#265787', 'fill:#fff'] },
      'chrome-devtools': {
        viewBox: '0 0 48 48',
        colours: ['#d93025', '#ea4335', '#fcc934', '#fbbc04', '#1e8e3e', '#34a853', 'fill:#1a73e8'],
      },
      slack: { viewBox: '0 0 127 127', colours: ['#E01E5A', '#36C5F0', '#2EB67D', '#ECB22E'] },
      figma: {
        viewBox: '0 0 200 300',
        colours: ['#0acf83', '#a259ff', '#f24e1e', '#ff7262', '#1abcfe'],
      },
      'google-drive': {
        viewBox: '0 0 87.3 78',
        colours: ['#0066da', '#00ac47', '#ea4335', '#00832d', '#2684fc', '#ffba00'],
      },
      gmail: {
        viewBox: '52 42 88 66',
        colours: ['#4285f4', '#34a853', '#fbbc04', '#ea4335', '#c5221f'],
      },
      'google-calendar': {
        viewBox: '0 0 200 200',
        colours: ['#1A73E8', '#EA4335', '#34A853', '#4285F4', '#188038', '#FBBC04', '#1967D2'],
      },
      playwright: {
        viewBox: '0 0 400 400',
        colours: ['#2D4552', '#E2574C', '#2EAD33', '#D65348', '#1D8D22'],
      },
    };
    expect(Object.keys(OFFICIAL_MARKS).sort()).toEqual(Object.keys(expectations).sort());
    for (const [id, { viewBox, colours }] of Object.entries(expectations)) {
      expect(BRANDED_CONNECTOR_IDS, `${id} counts as branded`).toContain(id);
      const svg = KNOWN_CONNECTORS_BY_ID[id]?.iconSvg ?? '';
      expect(svg, `${id} is the official file`).toBe(OFFICIAL_MARKS[id]);
      expect(svg).toBe(connectorIconSvg(id));
      expect(svg, `${id} keeps its own viewBox`).toContain(`viewBox="${viewBox}"`);
      for (const colour of colours) expect(svg, `${id} keeps ${colour}`).toContain(colour);
      // The inline housekeeping, and only that: the box sizes the root, the
      // name beside it is the accessible text, no editor cruft or page-wide
      // <style> leaks, and the file's own width/height are gone.
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.match(/width="100%"/g)?.length, `${id} root sized once`).toBe(1);
      expect(svg.match(/height="100%"/g)?.length).toBe(1);
      expect(svg.match(/aria-hidden="true"/g)?.length).toBe(1);
      expect(svg).not.toMatch(/<\?xml|<!--|<title|<desc|<metadata|<style|sodipodi|inkscape/);
      expect(svg).not.toMatch(/<svg[^>]*\s(?:width|height)="\d+(?:px)?"/);
      // Every id is namespaced per mark and every same-document reference
      // points at one of them — two marks' gradients never collide on a page.
      const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      for (const name of ids)
        expect(name, `${id} id ${name}`).toMatch(new RegExp(`^pd-mark-${id}-`));
      const refs = [...svg.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)].map((m) => m[1] ?? m[2]);
      for (const ref of refs) expect(ids, `${id} references #${ref}`).toContain(ref);
    }
    // Chrome is the one with gradients: three of them, namespaced and used.
    const chrome = OFFICIAL_MARKS['chrome-devtools'] ?? '';
    expect(chrome).toContain('id="pd-mark-chrome-devtools-a"');
    expect(chrome).toContain('url(#pd-mark-chrome-devtools-a)');
    expect(chrome).not.toMatch(/id="[abc]"/);
  });

  it('officialMark does the housekeeping and refuses a file it cannot size', () => {
    const out = officialMark(
      'x',
      '<svg width="10" height="10" id="root" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/><use href="#g"/></svg>',
      '0 0 10 10',
    );
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="100%" height="100%" aria-hidden="true"><defs><linearGradient id="pd-mark-x-g"/></defs><path fill="url(#pd-mark-x-g)" d="M0 0"/><use href="#pd-mark-x-g"/></svg>',
    );
    // A file that gives a viewBox keeps it and ignores the hint.
    expect(officialMark('y', '<svg viewBox="0 0 4 4"></svg>', '0 0 9 9')).toContain(
      'viewBox="0 0 4 4"',
    );
    expect(() => officialMark('z', '<svg></svg>')).toThrow(/no viewBox/);
    expect(() => officialMark('w', '<div/>')).toThrow(/not an <svg>/);
    // Slack is the one shipped without a viewBox; its hint is the file's size.
    expect(OFFICIAL_MARK_SOURCES.slack?.viewBox).toBe('0 0 127 127');
  });

  it("renders unity in the catalog's own monochrome mark, ink on dark", () => {
    // simple-icons gives Unity its dark-surface white; the mark is monochrome,
    // so on light it is Unity's own near-black, flipped to the box's ink on
    // dark exactly like GitHub.
    expect(BRANDED_CONNECTOR_IDS).toContain('unity');
    const svg = KNOWN_CONNECTORS_BY_ID.unity?.iconSvg ?? '';
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('var(--pd-connector-ink, #222C37)');
    expect(svg).not.toContain('#FFFFFF');
    expect(svg).not.toContain('stroke-width="1.75"');
  });

  it('falls back to a neutral (stroked) glyph for connectors without a brand mark', () => {
    // filesystem has no brand; Tableau publishes no vector mark and the
    // catalog dropped it — a neutral glyph, not a drawing of the logo.
    for (const id of ['filesystem', 'tableau'] as const) {
      expect(BRANDED_CONNECTOR_IDS).not.toContain(id);
      const svg = KNOWN_CONNECTORS_BY_ID[id]?.iconSvg ?? '';
      expect(svg).toContain('stroke-width="1.75"');
      expect(svg).toMatch(/stroke="#[0-9a-f]{6}"/);
    }
  });

  it('no longer ships the archived first-party servers', () => {
    const flat = JSON.stringify(KNOWN_CONNECTORS);
    expect(flat).not.toContain('@modelcontextprotocol/server-github');
    expect(flat).not.toContain('@modelcontextprotocol/server-slack');
    expect(flat).not.toContain('@modelcontextprotocol/server-postgres');
    expect(flat).not.toContain('@modelcontextprotocol/server-puppeteer');
  });
});

describe('catalog npx package specs are plausibly-real package names (round-9)', () => {
  // The first non-flag arg to `npx` is the package to run. Strip an optional
  // `@version` / `@latest` tag (scoped: the @ after the '/'; unscoped: the first @).
  function npxPackageSpec(args: readonly string[]): string | undefined {
    return args.find((a) => !a.startsWith('-') && !a.startsWith('http') && !a.startsWith('<'));
  }
  function stripVersion(spec: string): string {
    if (spec.startsWith('@')) {
      const slash = spec.indexOf('/');
      const at = slash >= 0 ? spec.indexOf('@', slash) : -1;
      return at > slash ? spec.slice(0, at) : spec;
    }
    const at = spec.indexOf('@');
    return at > 0 ? spec.slice(0, at) : spec;
  }
  // npm package-name shape: optional lowercase scope, then a lowercase name.
  const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

  const npxConnectors = KNOWN_CONNECTORS.filter((c) => c.template.command === 'npx');

  it('covers a meaningful number of npx connectors', () => {
    expect(npxConnectors.length).toBeGreaterThan(5);
  });

  for (const c of npxConnectors) {
    it(`${c.id}: launches a well-formed npm package name`, () => {
      const spec = npxPackageSpec(c.template.args ?? []);
      expect(spec, `${c.id} has no npx package arg`).toBeDefined();
      // No unresolved placeholder leaked into the package position.
      expect(spec).not.toMatch(/[<>]/);
      expect(NPM_NAME.test(stripVersion(spec ?? ''))).toBe(true);
    });
  }

  it('ships the CORRECT (non-404) package ids for the round-9 fixes', () => {
    const seq = KNOWN_CONNECTORS_BY_ID['sequential-thinking'];
    expect(seq?.template.args).toContain('@modelcontextprotocol/server-sequential-thinking');
    // The typo'd (hyphen-less) id must be gone.
    expect(JSON.stringify(seq)).not.toContain('sequentialthinking');

    const discord = KNOWN_CONNECTORS_BY_ID.discord;
    expect(discord?.template.args).toContain('mcp-discord');
    expect(JSON.stringify(discord)).not.toContain('@barryyip0625/mcp-discord');
  });
});

describe('connectorNeedsConfig', () => {
  it('is true for secret/placeholder connectors, false for plain local ones', () => {
    // biome-ignore lint/style/noNonNullAssertion: fixed catalog ids
    expect(connectorNeedsConfig(KNOWN_CONNECTORS_BY_ID.slack!)).toBe(true); // requiresEnv
    // biome-ignore lint/style/noNonNullAssertion: fixed catalog ids
    expect(connectorNeedsConfig(KNOWN_CONNECTORS_BY_ID.filesystem!)).toBe(true); // <ALLOWED_DIR>
    // biome-ignore lint/style/noNonNullAssertion: fixed catalog ids
    expect(connectorNeedsConfig(KNOWN_CONNECTORS_BY_ID.memory!)).toBe(false);
  });
});

describe('detectedSuggestions', () => {
  it('returns only detected connectors', () => {
    const out = detectedSuggestions(
      env({ listApps: () => ['Slack.app'], listProcesses: () => ['postgres'] }),
    );
    expect(out.map((s) => s.id).sort()).toEqual(['postgres', 'slack']);
  });
});

describe('recommendedConnectors', () => {
  it('does not recommend Blender — it is the built-in `blender` command, detected not added', () => {
    const apps = { listApps: () => ['Blender.app', 'Safari.app'] };
    expect(recommendedConnectors(env(apps)).map((s) => s.id)).not.toContain('blender');
    // …and the scan still finds it, which is what shows its card.
    expect(detectedSuggestions(env(apps)).map((s) => s.id)).toContain('blender');
  });

  it('expands a multi-connector app mapping (VS Code → git/filesystem/github)', () => {
    const out = recommendedConnectors(env({ listApps: () => ['Visual Studio Code.app'] }));
    expect(out.map((s) => s.id)).toEqual(['git', 'filesystem', 'github']);
  });

  it('is empty when nothing relevant is installed', () => {
    expect(recommendedConnectors(env({ listApps: () => ['Safari.app'] }))).toHaveLength(0);
  });
});
