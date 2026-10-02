/**
 * AN INTERACTIVE WIDGET, OR A PAGE? Pure, and shared: main decides it when a
 * .html is presented (present-inline.ts), and the renderer decides it again
 * when a chat's cards are rebuilt from its transcript (present-store.ts).
 *
 * the user (2026-09-24): "really clean, intuitive interactive widgets
 * inline/+canvas, eg. for math explanation NN inner working visualizations".
 * A widget is one self-contained file (it loads nothing of its own by a
 * relative path), small, with something to interact with or something drawn,
 * and not a web page (no nav, no header and footer, not a stack of sections).
 * It runs in the chat's sandboxed frame; a site stays a canvas tab.
 */

export interface PresentedHtmlWidget {
  readonly text: string;
  /** Its <title>, when it has one. */
  readonly title?: string;
  /**
   * A page the math command drew — an explanation that plays its steps. It
   * stands in the chat at its own height, and its raw view is its spec.
   */
  readonly explanation?: true;
  /** The explanation's spec (the .math.json beside it), when it could be read. */
  readonly spec?: string;
}

/** A widget travels inline up to this many bytes of page. */
export const INLINE_HTML_MAX_BYTES = 64 * 1024;

/** A value of src/href/url() that names a file of its own (not a URL, data, or an anchor). */
function namesALocalFile(v: string): boolean {
  const s = v.trim();
  if (s === '' || s.startsWith('#')) return false;
  return !/^(?:https?:|data:|blob:|mailto:|tel:|javascript:|about:)/i.test(s);
}

/**
 * A presented page that belongs in the chat as a live widget, or null for one
 * the canvas should open (a site, a long page, a file with files beside it).
 */
export function htmlWidget(markup: string): PresentedHtmlWidget | null {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(markup)?.[1]?.trim();
  /*
   * AN EXPLANATION THE MATH COMMAND DREW belongs in the chat — the user
   * (2026-10-01): "explanation should be inline". It fails the rules below
   * for reasons that make it no less a widget: KaTeX's fonts ride inside it
   * (~330 KB) and its steps are a <nav>. It runs in the same sandboxed frame.
   */
  if (/\bdata-mv-panel\b/.test(markup)) {
    return { text: markup, explanation: true, ...(title ? { title } : {}) };
  }
  if (new TextEncoder().encode(markup).length > INLINE_HTML_MAX_BYTES) return null;
  // One file: nothing of its own loaded by a relative path.
  for (const m of markup.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
    if (namesALocalFile(m[1] ?? '')) return null;
  }
  for (const m of markup.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/gi)) {
    if (namesALocalFile(m[1] ?? '')) return null;
  }
  // Something to interact with, or something drawn.
  if (!/<(?:canvas|svg|input|button|select|script)\b/i.test(markup)) return null;
  // Not a page: no site navigation, no header-and-footer frame, not a stack of sections.
  if (/<nav\b/i.test(markup)) return null;
  if (/<header\b/i.test(markup) && /<footer\b/i.test(markup)) return null;
  if ((markup.match(/<section\b/gi) ?? []).length >= 3) return null;
  return { text: markup, ...(title ? { title } : {}) };
}
