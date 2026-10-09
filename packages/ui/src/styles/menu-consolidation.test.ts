// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ONE ROW RECIPE, NO EXCEPTIONS.
 *
 * The user, seeing the project picker beside the other dropdowns: "dropdown styling
 * and thus I assume consolidation of master switch for one style affects all was
 * not applied everywhere, examples: bottom left, projects" — then, on what it
 * should be: "consolidate, match everything else... the hover effects don't need
 * to be 'edge to edge' they just should have consistency on spacing and can
 * still be corner rounded... ensure that the hovered item has the exact same
 * margin on each side while hovered".
 *
 * MEASURED in the running app, before and after:
 *   before  .pd-project-menu rows  left=0 right=0 radius=0px   colour green
 *   every other menu's rows        left=5 right=5 radius=7px
 *   after   all menus              left=5 right=5 radius=7px   current = blue
 *
 * The picker had drifted because it was given three private overrides. It keeps
 * exactly one — its z-index, so the composer card cannot cover it.
 */
const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'menu.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block whose selector mentions the project menu. */
function projectMenuBlocks(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const selector = m[1];
    const body = m[2];
    if (selector === undefined || body === undefined) continue;
    if (selector.includes('pd-project-menu')) out.push([selector.trim(), body]);
  }
  return out;
}

describe('the project picker uses the shared row recipe', () => {
  /* Geometry is what made it read as a different component. Any of these coming
   * back re-forks the look, and each one is cheap to add without noticing. */
  const FORKING = [
    /padding-inline\s*:/,
    /border-radius\s*:/,
    /\bwidth\s*:/,
    /margin-inline\s*:/,
    /\bpadding\s*:/,
  ];

  it('declares no geometry of its own', () => {
    const offenders: string[] = [];
    for (const [selector, body] of projectMenuBlocks()) {
      for (const rule of FORKING) {
        if (rule.test(body)) offenders.push(`${selector} → ${rule.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps only the z-index that lifts it above the composer', () => {
    const blocks = projectMenuBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, body] of blocks) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props).toEqual(['z-index']);
    }
  });
});

describe('the current row is marked, not celebrated', () => {
  const current = /\.pd-menu-item--current\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('uses the menu-current accent', () => {
    expect(current).toMatch(/color:\s*var\(--pd-menu-current\)/);
  });

  /* Green was `--pd-status-success-fg`, which says SUCCEEDED rather than
   * SELECTED — the wrong idea in a picker, and loud enough to pull the eye off
   * the row actually being hovered. */
  it('never goes back to the success colour', () => {
    expect(current).not.toContain('status-success');
  });
});
