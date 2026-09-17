import { describe, expect, it } from 'vitest';
import {
  applyCodeFont,
  applyCodeTheme,
  CODE_THEME_STYLE_ID,
  type CodeThemeTarget,
  codeFontFamily,
} from './code-theme';

/** A document with exactly the surface the applier touches. */
function fakeDocument() {
  const styles = new Map<string, { id: string; textContent: string | null }>();
  const props = new Map<string, string>();
  const doc: CodeThemeTarget = {
    getElementById: (id) => styles.get(id) ?? null,
    createElement: () => ({ id: '', textContent: '' }) as unknown as HTMLStyleElement,
    head: {
      appendChild: (node) => {
        styles.set(node.id, node as unknown as { id: string; textContent: string | null });
        return node;
      },
    },
    documentElement: {
      style: {
        setProperty: (name, value) => {
          props.set(name, value);
        },
        removeProperty: (name) => {
          const had = props.get(name) ?? '';
          props.delete(name);
          return had;
        },
      },
    },
  };
  return { doc, styles, props };
}

describe('applyCodeTheme', () => {
  it('writes an empty sheet for the house pair — the theme sheet already is the theme', () => {
    const { doc, styles } = fakeDocument();
    applyCodeTheme({ light: 'bobble-light', dark: 'bobble-dark' }, doc);
    expect(styles.get(CODE_THEME_STYLE_ID)?.textContent).toBe('');
  });

  it('scopes a third-party theme to its mode', () => {
    const { doc, styles } = fakeDocument();
    applyCodeTheme({ light: 'github-light', dark: 'dracula' }, doc);
    const css = styles.get(CODE_THEME_STYLE_ID)?.textContent ?? '';
    expect(css).toContain("html:root[data-flavor][data-mode='light'] {");
    expect(css).toContain("html:root[data-flavor][data-mode='dark'] {");
    expect(css).toContain('--pd-syntax-keyword: #ff79c6;');
    expect(css).toContain('--pd-ansi-red: #ff5555;');
  });

  it('falls back to the house theme for an unknown id or one of the wrong mode', () => {
    const { doc, styles } = fakeDocument();
    applyCodeTheme({ light: 'dracula', dark: 'not-a-theme' }, doc);
    expect(styles.get(CODE_THEME_STYLE_ID)?.textContent).toBe('');
    applyCodeTheme({}, doc);
    expect(styles.get(CODE_THEME_STYLE_ID)?.textContent).toBe('');
  });

  it('reuses one style element across calls', () => {
    const { doc, styles } = fakeDocument();
    applyCodeTheme({ dark: 'nord' }, doc);
    applyCodeTheme({ dark: 'monokai' }, doc);
    expect(styles.size).toBe(1);
    expect(styles.get(CODE_THEME_STYLE_ID)?.textContent).toContain('#f92672');
    expect(styles.get(CODE_THEME_STYLE_ID)?.textContent).not.toContain('#81a1c1');
  });
});

describe('the code font', () => {
  it('puts the name in front of the mono stack, quoted', () => {
    expect(codeFontFamily('JetBrains Mono')).toBe(
      "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    );
    expect(codeFontFamily('  ')).toBeNull();
    expect(codeFontFamily("Fira'Code")).toContain("'FiraCode'");
  });

  it('applies as an inline --pd-font-mono, and clears when emptied', () => {
    const { doc, props } = fakeDocument();
    applyCodeFont('Menlo', doc);
    expect(props.get('--pd-font-mono')).toMatch(/^'Menlo', /);
    applyCodeFont('', doc);
    expect(props.has('--pd-font-mono')).toBe(false);
  });
});
