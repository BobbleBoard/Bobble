// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ONE dropdown surface, app-wide.
 *
 * The user, from a screenshot of the canvas operation bar: "I notice the styling of
 * the dropdowns and animations for opening them varies, can you please
 * standardize the one used for ... the new tab in the canvas dropdown ... such
 * that you can change one and it changes all of them" — and then "that dropdown
 * also has nice bordering that the others don't."
 *
 * The user was looking at two dropdowns in the SAME bar: "Open with" rendered the
 * shared `.pd-menu` (frosted, blurred, 0.5px hairline ring, reveal animation)
 * and the media-download caret one control to its right rendered a private
 * `.pd-canvas-menu` (opaque, `1px solid`, no blur, no animation). Nothing was
 * broken — which is exactly why it survived: a second surface costs nothing
 * until someone tunes the first one and half the app doesn't follow.
 *
 * These guard the convergence rather than the pixels:
 *   1. every dropdown panel in this package carries `.pd-menu`, so the surface
 *      always comes from ui/styles/menu.css;
 *   2. this package's stylesheet never re-declares that surface — a canvas rule
 *      may POSITION a menu, never re-skin it.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const sourcesIn = (d: string): string[] =>
  readdirSync(d)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => path.join(d, f));

describe('the canvas dropdown surface is the shared one', () => {
  /* A panel is a JSX element carrying role="menu". Each must also carry pd-menu.
   * Matched on the whole opening tag so attribute order never matters. */
  it('every role="menu" panel renders .pd-menu', () => {
    const offenders: string[] = [];
    for (const file of sourcesIn(dir)) {
      const src = readFileSync(file, 'utf8');
      for (const tag of src.match(/<[a-z][^>]*role="menu"[^>]*>/gs) ?? []) {
        if (!/className="[^"]*\bpd-menu\b/.test(tag)) {
          offenders.push(`${path.basename(file)}: ${tag.replace(/\s+/g, ' ').slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /* The look lives in ONE file. A canvas rule may set position/width; the moment
   * it sets a border or a background it has forked the surface again. */
  it('the canvas stylesheet re-skins no menu surface', () => {
    const css = readFileSync(path.resolve(dir, '..', 'styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const forked: string[] = [];
    for (const m of css.matchAll(/([^{}]*menu[^{}]*)\{([^}]*)\}/gi)) {
      const selector = m[1];
      const body = m[2];
      if (selector === undefined || body === undefined) continue;
      if (/(^|\s)(border|background)\s*:/m.test(body)) forked.push(selector.trim());
    }
    expect(forked).toEqual([]);
  });
});
