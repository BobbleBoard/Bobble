/**
 * Make the vendored editors look like part of Bobble rather than an embedded
 * external app.
 *
 * GenOffice ships NO dark mode — no `prefers-color-scheme`, no `data-theme`,
 * nothing. What it does ship is a small semantic set of CSS custom properties
 * (`--chrome-bg`, `--surface`, `--canvas`, `--text`, `--border`, `--hover`, …),
 * and retargeting those is a far better seam than chasing class names: it is
 * ~15 declarations instead of dozens of selectors, and it survives their
 * refactors, since a renamed component still reads the same variable.
 *
 * EVERY DECLARATION IS `!important`, and that is not defensive noise. Electron's
 * insertCSS injects at the USER-stylesheet origin, and in the CSS cascade author
 * styles beat user styles for normal declarations — so GenOffice's own
 * `:root { --chrome-bg: #ffffff }` silently wins and nothing changes. Only a
 * user-origin `!important` outranks an author rule. MEASURED: without it,
 * insertCSS returns a valid key and --chrome-bg stays #ffffff.
 *
 * ONE DELIBERATE EXCEPTION: the document page itself stays paper-white. A Word
 * page, a slide and a PDF sheet are white objects — Word, Pages and Preview all
 * keep them white in dark mode, because the page is content, not chrome.
 * Darkening it would not read as "themed", it would read as "the document is
 * wrong". So `--canvas` (the area AROUND the page) follows the theme while the
 * page stays light.
 */

/** The Bobble tokens the renderer sends over. All values are resolved CSS colours. */
export interface OfficeThemeTokens {
  bgBase?: string;
  bgRaised?: string;
  bgInset?: string;
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  borderDefault?: string;
  accentPrimary?: string;
  fontSans?: string;
}

/**
 * Build the stylesheet injected into every editor view.
 *
 * Kept as a pure function so it can be unit-tested without an Electron view —
 * the failure this guards against (a token missing, so a surface falls back to
 * white inside a dark app) is a one-line mistake that is invisible until
 * someone looks at a screenshot.
 */
export function officeThemeCss(tokens: OfficeThemeTokens, dark: boolean): string {
  const t = {
    bgBase: tokens.bgBase ?? (dark ? '#262624' : '#faf9f5'),
    bgRaised: tokens.bgRaised ?? (dark ? '#30302e' : '#ffffff'),
    bgInset: tokens.bgInset ?? (dark ? '#1f1e1d' : '#f5f4ed'),
    textPrimary: tokens.textPrimary ?? (dark ? '#faf9f5' : '#141413'),
    textSecondary: tokens.textSecondary ?? (dark ? '#c2c0b6' : '#3d3d3a'),
    textMuted: tokens.textMuted ?? (dark ? '#9c9a92' : '#73726c'),
    borderDefault: tokens.borderDefault ?? (dark ? '#4a4844' : '#e1dfdd'),
    accentPrimary: tokens.accentPrimary ?? '#d97757',
    fontSans: tokens.fontSans ?? '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  };

  // Hover/pressed have to be derived rather than taken from a token: Bobble has
  // no equivalent, and a fixed grey reads as a foreign control set in dark mode.
  const hover = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.045)';
  const pressed = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.075)';

  return `
/* ── fluid shell ───────────────────────────────────────────────────────────
 * MEASURED, walking the guest DOM: #root, main.app-shell, header.excel-header
 * and div.sheet-body all compute to a flat 900px, and div.sheet-main to 360px,
 * in a viewport of 440. GenOffice is built as a standalone desktop web app with
 * a minimum shell width; hosted in a canvas panel that is routinely narrower —
 * or WIDER — that fixed width is what the user saw as "blank space on the right".
 *
 * It was never a missed resize notification, which is why dispatching resize
 * events changed nothing: no event can make a 900px box fill 1000px. The shell
 * has to be told it is fluid, and because insertCSS lands at USER-stylesheet
 * origin, every declaration needs !important to beat the author sheet.
 */
html, body, #root, main.app-shell,
.sheet-body, .sheet-main, .doc-body, .doc-main, .slide-body, .slide-main,
.excel-header, .word-header, .ppt-header, .workbook-area, #univer-container {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
}
html, body { overflow-x: hidden !important; }
/* The editor area sits in a fixed track of its parent's grid/flex, which is why
 * width:100% on it resolved to 360px while its own parent measured 750: a
 * percentage width resolves against the GRID AREA, not the parent box. Hiding
 * the AI dock with display:none removes the item but leaves the TRACK, so the
 * layout keeps reserving the column it used to fill. Collapse the container to
 * a single fluid track and let the editor take it. */
.sheet-body, .doc-body, .slide-body {
  display: flex !important;
  flex-direction: row !important;
  grid-template-columns: 1fr !important;
}
/* The shell stacks a header ABOVE the body, so it is a COLUMN. Forcing it to
 * row alongside the bodies collapsed .sheet-body to its content width (750 →
 * 375) — a tidier-looking rule that made the bug worse. */
main.app-shell {
  display: flex !important;
  flex-direction: column !important;
}
.sheet-body, .doc-body, .slide-body { flex: 1 1 auto !important; }
.sheet-main, .doc-main, .slide-main {
  flex: 1 1 auto !important;
  width: auto !important;
  min-width: 0 !important;
}
/* The shell is a column: let the editor area take every leftover pixel instead
 * of sitting at its intrinsic size. */
main.app-shell, .sheet-body, .doc-body, .slide-body { box-sizing: border-box !important; }

:root {
  --surface: ${t.bgRaised} !important;
  --chrome-bg: ${t.bgBase} !important;
  --border: ${t.borderDefault} !important;
  --border-strong: ${t.borderDefault} !important;
  --text: ${t.textPrimary} !important;
  --text-dim: ${t.textMuted} !important;
  --hover: ${hover} !important;
  --pressed: ${pressed} !important;
  --active-bg: ${pressed} !important;
  /* The area AROUND the page — this is chrome, so it follows the theme. */
  --canvas: ${t.bgInset} !important;
  --color-text-primary: ${t.textPrimary} !important;
  --color-text-secondary: ${t.textSecondary} !important;
  --color-text-tertiary: ${t.textMuted} !important;
  --color-bg-subtle: ${t.bgInset} !important;
  --color-border-default: ${t.borderDefault} !important;
  --color-border-strong: ${t.borderDefault} !important;
  --color-btn-primary: ${t.accentPrimary} !important;
  --color-btn-primary-hover: ${t.accentPrimary} !important;
  --gs-font-sans: ${t.fontSans} !important;
  --word-blue: ${t.accentPrimary} !important;
  --word-heading: ${t.accentPrimary} !important;
  /* Found by enumerating every custom property the five renderers CONSUME and
     diffing against what we mapped, rather than by noticing surfaces one at a
     time in screenshots. --accent alone has ~100 uses; --surface-subtle is what
     the formula bar reads, which is why that strip stayed white while the
     ribbon above it went dark. office-theme.test.ts pins the list. */
  --accent: ${t.accentPrimary} !important;
  --surface-subtle: ${t.bgInset} !important;
  --surface-hover: ${hover} !important;
  --ribbon-hover: ${hover} !important;
  --text-muted: ${t.textMuted} !important;
  --text-caption: ${t.textMuted} !important;
}

/* The view's own ground is the PANE's colour (bg-raised), not the app base:
   the canvas tab folds into the pane, and a view whose top band was a shade
   darker drew a straight line right under the selected tab (the user: "a straight
   line under the tab"). The editor's chrome strips pick their own colours
   below; the ground and the reserved toolbar band match the tab. */
html { background: ${t.bgRaised} !important; }
body { background: ${t.bgRaised} !important; color: ${t.textPrimary} !important; font-family: ${t.fontSans} !important; }

/* The PAGE stays paper. See the note at the top of this file — a dark Word page
   reads as a broken document, not as a themed one.
   BOTH names are required and neither is optional: docs paints the sheet with
   var(--page-bg, var(--surface)) while the others use --color-bg-page. Setting
   only the latter left the Word page falling back to --surface, which we had
   just remapped to a dark colour — so the page turned dark grey with near-black
   text on it. Caught by looking at the render, not by any test. */
:root {
  --page-bg: #ffffff !important;
  --color-bg-page: #ffffff !important;
}
/* Text on the page belongs to the document, not the theme. */
.doc-page, .page-wrap, .page { color: #141413 !important; }

${
  dark
    ? `
/* Their icons are strokes on transparent, so they inherit currentColor and come
   through fine. Raw <img>/<svg> assets baked as dark-on-light do not — lift the
   ones that would otherwise vanish into the dark chrome. */
.ribbon svg, .toolbar svg, .statusbar svg { color: ${t.textSecondary} !important; }

/* Inputs and selects default to white in every editor. */
input, select, textarea {
  background: ${t.bgInset} !important;
  color: ${t.textPrimary} !important;
  border-color: ${t.borderDefault} !important;
}

/* Chrome surfaces with HARDCODED light backgrounds rather than a variable.
   The variable remap above cannot reach these — .status-bar is literally
   "background: #f3f4f6" — and there are ~80 such declarations across the five
   renderers. These are the ones that border the document, so they are the ones
   a user sees as a light seam around dark chrome. Listed explicitly, and
   covered by rebrand-guard.test.ts so a rename fails loudly instead of
   quietly restoring a white strip. */
/* The slide navigator RAIL is chrome; the thumbnails inside it are slide
   content and stay white, exactly like the page. */
.slide-list, .nav-rail, .thumbnails, .sidebar-thumbs {
  background: ${t.bgInset} !important;
  border-color: ${t.borderDefault} !important;
}

.status-bar, .statusbar, .sheet-tabs, .tab-strip, .bottom-bar, .toolbar, .ribbon {
  background: ${t.bgBase} !important;
  color: ${t.textSecondary} !important;
  border-color: ${t.borderDefault} !important;
}

/* Scrollbars: a light scrollbar on dark chrome is the single most obvious
   "this is an embedded foreign app" tell. */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)'};
  border-radius: 5px;
}
::-webkit-scrollbar-thumb:hover { background: ${dark ? 'rgba(255,255,255,0.26)' : 'rgba(0,0,0,0.28)'}; }
`
    : ''
}
`.trim();
}
