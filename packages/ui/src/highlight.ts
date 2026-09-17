/**
 * Syntax highlighting for the chat's code fences — highlight.js with a fixed
 * set of grammars, emitting `hljs-*` classes that `styles/syntax.css` maps onto
 * the `--pd-syntax-*` variables. The colours therefore come from the active
 * code theme (Appearance → Code appearance), the same variables the canvas
 * editor reads, so a fence in the chat and the file on the canvas agree.
 *
 * Grammars are registered explicitly rather than pulling `highlight.js` whole:
 * the full bundle is 190 languages and most of a megabyte, and a chat needs
 * the twenty or so a model actually writes.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const GRAMMARS = {
  typescript,
  javascript,
  python,
  bash,
  shell,
  json,
  yaml,
  xml,
  css,
  scss,
  markdown,
  sql,
  go,
  rust,
  java,
  c,
  cpp,
  csharp,
  swift,
  kotlin,
  ruby,
  php,
  diff,
  dockerfile,
  ini,
  makefile,
  lua,
  plaintext,
} as const;

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

/**
 * Names the grammars do not already answer to. highlight.js registers the
 * common ones itself (`ts`, `js`, `sh`, `yml`, `html`, `py`, `rb`, `rs`, `kt`,
 * `md`, `c++`, `txt`, …); these are the fence labels seen in replies that it
 * does not.
 */
const ALIASES: Readonly<Record<string, string>> = {
  tsx: 'typescript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  node: 'javascript',
  zsh: 'bash',
  console: 'shell',
  shellsession: 'shell',
  terminal: 'shell',
  svg: 'xml',
  vue: 'xml',
  jsonc: 'json',
  json5: 'json',
  toml: 'ini',
  conf: 'ini',
  env: 'ini',
  dotenv: 'ini',
  docker: 'dockerfile',
  make: 'makefile',
  objc: 'c',
  'objective-c': 'c',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  patch: 'diff',
  udiff: 'diff',
  text: 'plaintext',
  plain: 'plaintext',
  none: 'plaintext',
  output: 'plaintext',
  log: 'plaintext',
};

/** The registered grammar a fence label names, or null when there is none. */
export function highlightLanguage(language: string | undefined): string | null {
  if (language === undefined) return null;
  const key = language.trim().toLowerCase();
  if (key === '') return null;
  const alias = ALIASES[key];
  if (alias !== undefined) return alias;
  const grammar = hljs.getLanguage(key);
  if (grammar === undefined) return null;
  // `getLanguage` resolves aliases but returns the grammar, not its name;
  // registered names are the keys above, so find which one it is.
  for (const name of Object.keys(GRAMMARS)) {
    if (hljs.getLanguage(name) === grammar) return name;
  }
  return null;
}

/**
 * Above this a fence is shown plain. highlight.js is linear in practice, but
 * a fence re-highlights on every streamed delta, and a model pasting a whole
 * file is a real case — this keeps that at a few milliseconds a keystroke.
 */
const MAX_HIGHLIGHT_CHARS = 120_000;

export interface Highlighted {
  /** Escaped HTML with `hljs-*` spans. Text content equals `code`. */
  html: string;
  /** The grammar used, or null when the code was left plain. */
  language: string | null;
}

/** Escape text for HTML the way highlight.js does for what it leaves plain. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Highlight `code` as `language`. An unknown or missing language, or a fence
 * too large to be worth it, comes back escaped and plain — never unhighlighted
 * AND unescaped, so the result is always safe to set as HTML.
 */
export function highlightCode(code: string, language?: string): Highlighted {
  const grammar = highlightLanguage(language);
  if (grammar === null || grammar === 'plaintext' || code.length > MAX_HIGHLIGHT_CHARS) {
    return { html: escapeHtml(code), language: null };
  }
  try {
    const { value } = hljs.highlight(code, { language: grammar, ignoreIllegals: true });
    return { html: value, language: grammar };
  } catch {
    return { html: escapeHtml(code), language: null };
  }
}

/**
 * Split highlighted HTML into one HTML string per line, re-opening at the
 * start of each line whichever spans were open at the end of the previous —
 * a block comment or a template string runs across lines, and a line-numbered
 * fence wraps every line in an element of its own.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const tokens = html.split(/(<span[^>]*>|<\/span>)/);
  for (const token of tokens) {
    if (token === '') continue;
    if (token.startsWith('<span')) {
      open.push(token);
      current += token;
      continue;
    }
    if (token === '</span>') {
      open.pop();
      current += token;
      continue;
    }
    const parts = token.split('\n');
    for (let i = 0; i < parts.length; i++) {
      current += parts[i];
      if (i < parts.length - 1) {
        lines.push(current + '</span>'.repeat(open.length));
        current = open.join('');
      }
    }
  }
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}
