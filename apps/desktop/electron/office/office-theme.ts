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
:root {
  --surface: ${t.bgRaised};
  --chrome-bg: ${t.bgBase};
  --border: ${t.borderDefault};
  --border-strong: ${t.borderDefault};
  --text: ${t.textPrimary};
  --text-dim: ${t.textMuted};
  --hover: ${hover};
  --pressed: ${pressed};
  --active-bg: ${pressed};
  /* The area AROUND the page — this is chrome, so it follows the theme. */
  --canvas: ${t.bgInset};
  --color-text-primary: ${t.textPrimary};
  --color-text-secondary: ${t.textSecondary};
  --color-text-tertiary: ${t.textMuted};
  --color-bg-subtle: ${t.bgInset};
  --color-border-default: ${t.borderDefault};
  --color-border-strong: ${t.borderDefault};
  --color-btn-primary: ${t.accentPrimary};
  --color-btn-primary-hover: ${t.accentPrimary};
  --gs-font-sans: ${t.fontSans};
  --word-blue: ${t.accentPrimary};
  --word-heading: ${t.accentPrimary};
}

body { background: ${t.bgBase}; color: ${t.textPrimary}; font-family: ${t.fontSans}; }

/* The PAGE stays paper. See the note at the top of this file — a dark Word page
   reads as a broken document, not as a themed one. */
:root { --color-bg-page: #ffffff; }

${
  dark
    ? `
/* Their icons are strokes on transparent, so they inherit currentColor and come
   through fine. Raw <img>/<svg> assets baked as dark-on-light do not — lift the
   ones that would otherwise vanish into the dark chrome. */
.ribbon svg, .toolbar svg, .statusbar svg { color: ${t.textSecondary}; }

/* Inputs and selects default to white in every editor. */
input, select, textarea {
  background: ${t.bgInset};
  color: ${t.textPrimary};
  border-color: ${t.borderDefault};
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
