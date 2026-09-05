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
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

const globalCss = strip(readFileSync(path.join(here, 'global.css'), 'utf8'));
const themesCss = strip(
  readFileSync(path.resolve(here, '../../../../packages/themes/src/generated/themes.css'), 'utf8'),
);

/** Every stylesheet the app ships, found rather than listed. */
function allSheets(): string[] {
  const roots = [
    path.resolve(here, '..'), // apps/desktop/src
    path.resolve(here, '../../../../packages/ui/src'),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (entry.name.endsWith('.css')) {
        out.push(full);
      }
    }
  };
  for (const r of roots) {
    try {
      walk(r);
    } catch {
      // A root that has moved is not this test's business.
    }
  }
  return out;
}

const sheets = allSheets();

/**
 * Names DEFINED anywhere: the generated themes, plus any a stylesheet declares
 * for itself.
 *
 * A local `--pd-diff-surface: var(--pd-bg-raised)` is a real definition, and a
 * property a component sets on itself (a knob radius, a scale a script writes)
 * is too. Collecting only from themes.css and global.css reported eleven of
 * those as missing — a rule that cries wolf about correct code gets switched
 * off, which would take the four genuine ones with it.
 */
const defined = new Set<string>();
for (const source of [themesCss, globalCss, ...sheets.map((f) => strip(readFileSync(f, 'utf8')))]) {
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

  it('every --pd-* used in EVERY stylesheet is defined', () => {
    expect(sheets.length, 'found no stylesheets to check').toBeGreaterThan(5);
    const missing: string[] = [];
    for (const file of sheets) {
      const text = strip(readFileSync(file, 'utf8'));
      for (const [name, line] of usages(text)) {
        if (!defined.has(name)) missing.push(`${name} (${path.basename(file)}:${line})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
