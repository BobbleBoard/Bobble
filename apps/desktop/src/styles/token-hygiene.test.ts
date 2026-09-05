/**
 * EVERY `var(--pd-*)` IN THE STYLESHEET HAS TO NAME A REAL TOKEN.
 *
 * A misspelt custom property is the quietest possible CSS bug: the browser
 * throws away the whole declaration at computed-value time and paints the
 * inherited or initial value instead. Nothing warns, no test fails, the element
 * is still there and roughly the right shape — it is just the wrong colour, in
 * one theme or in all of them.
 *
 * MEASURED, which is why this exists: a drop veil written against
 * `--pd-bg`, `--pd-text`, `--pd-surface`, `--pd-accent`, `--pd-danger` and
 * `--pd-shadow-2` — SIX invented names, none of them defined anywhere — passed
 * typecheck, lint, 81 unit tests and its own end-to-end probe. It was caught by
 * looking at a screenshot and noticing the refusal was not red.
 *
 * The generated theme sheet is the authority: `packages/themes` emits every
 * token for every flavour, so a name absent from it resolves to nothing at
 * runtime no matter which theme is on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

const globalCss = strip(readFileSync(path.join(here, 'global.css'), 'utf8'));
const themesCss = strip(
  readFileSync(path.resolve(here, '../../../../packages/themes/src/generated/themes.css'), 'utf8'),
);

/** Names DEFINED anywhere: the generated themes, plus any the app declares
 *  itself (a local `--pd-x: …` is a real definition too). */
const defined = new Set<string>();
for (const source of [themesCss, globalCss]) {
  for (const m of source.matchAll(/(--pd-[a-z0-9-]+)\s*:/g)) defined.add(m[1] as string);
}

/**
 * Names used WITHOUT a fallback, with the line they are used on.
 *
 * `var(--pd-x, 9px)` is a deliberate optional: a property set at runtime from
 * JS (the composer's font scale, the studio's rail width, a media element's
 * progress) has no place in the theme sheet and states its own default. Only a
 * bare `var(--pd-x)` that resolves to nothing paints nothing — that is the bug
 * this file is about, so that is what it looks for.
 */
function usages(css: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = css.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of (lines[i] as string).matchAll(/var\(\s*(--pd-[a-z0-9-]+)\s*([,)])/g)) {
      if (m[2] === ',') continue; // has a fallback — deliberate
      const name = m[1] as string;
      if (!out.has(name)) out.set(name, i + 1);
    }
  }
  return out;
}

describe('theme token hygiene', () => {
  it('the generated theme sheet actually defines tokens', () => {
    // Guards the guard: a moved or renamed themes.css would empty `defined` and
    // make every assertion below vacuous rather than failing loudly.
    expect(defined.size).toBeGreaterThan(50);
  });

  it('every --pd-* used in global.css is defined', () => {
    const missing = [...usages(globalCss)]
      .filter(([name]) => !defined.has(name))
      .map(([name, line]) => `${name} (global.css:${line})`);
    expect(missing).toEqual([]);
  });

  it('every --pd-* used in the component stylesheets is defined', () => {
    // The studio and 3D workspace keep their own sheets; the same trap applies,
    // and tripo.css in particular states that EVERY colour must resolve from a
    // pd token — a name that resolves to nothing satisfies the letter of that
    // and none of the intent.
    const others = ['../tripo/tripo.css', '../chat/effort-slider.css'];
    const missing: string[] = [];
    for (const rel of others) {
      const file = path.resolve(here, rel);
      let text: string;
      try {
        text = strip(readFileSync(file, 'utf8'));
      } catch {
        continue; // a sheet that has been removed is not a failure
      }
      for (const [name, line] of usages(text)) {
        if (!defined.has(name)) missing.push(`${name} (${path.basename(file)}:${line})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
