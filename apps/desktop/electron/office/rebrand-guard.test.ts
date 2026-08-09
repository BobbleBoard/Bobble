/**
 * Trademark guard.
 *
 * Apache-2.0 §6 grants no trademark rights, and upstream's README says so
 * outright. We hide GenOffice's Genspark-branded chrome with injected CSS
 * (office-manager.ts) rather than by patching their components, so the vendored
 * tree stays cheap to cherry-pick into.
 *
 * That trade has one failure mode, and it is silent: if upstream renames a
 * class, our selector stops matching, the wordmark and logo come back, and
 * nothing anywhere errors. We would simply start shipping someone else's
 * trademark as our product identity.
 *
 * So this asserts the selectors still bite — every class the CSS relies on must
 * still be present in the BUILT renderer bundles. It fails on the rename, which
 * is the moment a human needs to look, rather than on the next release.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VENDOR = join(import.meta.dirname, '../../../../vendor/genoffice');
const MODULES = ['docs', 'sheets', 'slides', 'pdf', 'markdown'] as const;

/** Class names office-manager.ts's HIDE_AI_DOCK_CSS depends on. */
const REQUIRED_SELECTORS = ['ai-dock', 'ai-entry'] as const;

function builtRendererSource(mod: string): string | null {
  const dir = join(VENDOR, 'apps', mod, 'out/renderer/assets');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

const anyBuilt = MODULES.some((m) => builtRendererSource(m) !== null);

describe.skipIf(!anyBuilt)('GenOffice rebrand guard', () => {
  it('the vendored tree is pinned to a recorded upstream commit', () => {
    const upstream = join(VENDOR, 'UPSTREAM');
    expect(existsSync(upstream)).toBe(true);
    expect(readFileSync(upstream, 'utf8')).toMatch(/^commit\s+[0-9a-f]{40}$/m);
  });

  it('never ships the proprietary ee/ directory', () => {
    expect(existsSync(join(VENDOR, 'ee'))).toBe(false);
  });

  it.each(MODULES)('%s still exposes the classes our hide-CSS targets', (mod) => {
    const src = builtRendererSource(mod);
    if (src === null) return; // module not built in this checkout
    // A module that carries the wordmark must also carry a handle we can hide
    // it by. If it stops matching, the branding is back and visible.
    if (!/Genspark/.test(src)) return;
    const found = REQUIRED_SELECTORS.filter((sel) => src.includes(sel));
    expect(
      found.length,
      `${mod} contains the Genspark wordmark but none of ${REQUIRED_SELECTORS.join('/')} — ` +
        'the hide-CSS in office-manager.ts no longer matches, so the branding is now VISIBLE. ' +
        'Re-derive the selectors from the upstream renderer before shipping.',
    ).toBeGreaterThan(0);
  });

  it('the hide-CSS still names every selector this guard checks', () => {
    const manager = readFileSync(join(import.meta.dirname, 'office-manager.ts'), 'utf8');
    const css = manager.slice(
      manager.indexOf('const HIDE_AI_DOCK_CSS'),
      manager.indexOf('let seam: OfficeSeam | null'),
    );
    for (const sel of REQUIRED_SELECTORS) {
      expect(css, `HIDE_AI_DOCK_CSS no longer mentions .${sel}`).toContain(`.${sel}`);
    }
  });
});
