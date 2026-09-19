/**
 * Self-contained inline SVG marks for the connector gallery.
 *
 * the user (2026-09-18): "as much as you can, don't frankenstein or recreate
 * logos, find a catalog or official svgs". So a brand's mark is one of two
 * things, never a drawing of ours:
 *
 *  - THE CATALOG. Brand glyphs are pulled DIRECTLY from the CC0/MIT
 *    `simple-icons` npm package (https://simpleicons.org) as named imports —
 *    never hand-transcribed — so the `d` path and canonical brand `hex` are
 *    always the upstream-correct values. The explicit {@link BRAND_ICONS}
 *    `id → siX` map declares every id≠slug remap (`postgres → siPostgresql`,
 *    `google-drive → siGoogledrive`, …) and lets the bundler tree-shake
 *    `simple-icons` down to only the marks used here. Each is rendered in its
 *    brand color via the icon's `.hex` (Docker #2496ED, Spotify #1ED760).
 *  - THE OFFICIAL FILE. simple-icons ships one path in one colour; where that
 *    is a silhouette of a logo whose identity is its colours (Blender, Chrome,
 *    Slack, Figma, Google's Drive/Gmail/Calendar, Playwright) the brand owner's
 *    own logo file is used instead, verbatim — official-marks.ts, which lists
 *    each file's provenance and does the inline housekeeping (namespaced ids,
 *    100% root).
 *
 * Every mark is fully INLINE — no remote URLs — so it works under the app CSP
 * and offline.
 *
 * THEME SAFETY: a near-black brand (GitHub #181717, Notion #000, Unity's
 * #222C37) is invisible on a dark surface, so those marks fill with
 * `var(--pd-connector-ink, <brand hex>)` — the brand hex on light, but the
 * box's ink (currentColor) on dark, where the app defines `--pd-connector-ink`
 * (see ConnectorIcon's CSS). The hex fallback keeps the mark correct even with
 * no app CSS (tests/offline). Neutral CATEGORY fallbacks are two-tone line art
 * in a hue of their own.
 *
 * All third-party product names, logos, and brands are the property of their
 * respective owners; the marks are used here for identification only (see the
 * disclaimer on the connectors page). Where a brand has no published mark in
 * either place (Tableau was removed upstream and publishes no vector; Apple's
 * app icons are not vectors) the connector gets a neutral CATEGORY glyph rather
 * than a drawing of the logo (see {@link NEUTRAL_ICON_SVGS}).
 */
import {
  type SimpleIcon,
  siBlender,
  siBrave,
  siDiscord,
  siDocker,
  siFigma,
  siGit,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siLinear,
  siNotion,
  siObsidian,
  siPostgresql,
  siPostman,
  siSentry,
  siSpotify,
  siSqlite,
  siUnity,
  siXcode,
  siZoom,
} from 'simple-icons';
import { OFFICIAL_MARKS } from './official-marks';

/**
 * Connector id → its `simple-icons` mark. Explicit named imports (not slug
 * lookups) so id≠slug remaps are declared here and tree-shaking keeps only the
 * marks we actually reference. A connector is only listed when the package ships
 * a legible mark for it; otherwise it gets a {@link NEUTRAL_ICON_SVGS} glyph:
 *   - Slack, Tableau, Chrome DevTools — no mark published in the set.
 *   - Unity — its published mark is pure white (#FFFFFF), invisible on light.
 */
const BRAND_ICONS: Record<string, SimpleIcon> = {
  git: siGit,
  github: siGithub,
  postgres: siPostgresql,
  sqlite: siSqlite,
  postman: siPostman,
  sentry: siSentry,
  xcode: siXcode,
  docker: siDocker,
  notion: siNotion,
  linear: siLinear,
  figma: siFigma,
  'google-drive': siGoogledrive,
  gmail: siGmail,
  'google-calendar': siGooglecalendar,
  obsidian: siObsidian,
  'brave-search': siBrave,
  blender: siBlender,
  spotify: siSpotify,
  discord: siDiscord,
  zoom: siZoom,
  unity: siUnity,
};

/**
 * simple-icons gives a brand ONE hex, and for Unity that is the white of its
 * dark-surface mark. The mark itself is monochrome — on light it is Unity's own
 * near-black (unity.com's light-mode logo); that hex goes through the
 * near-black flip below like GitHub's, so the mark is ink on dark and this on
 * light.
 */
const LIGHT_INK: Record<string, string> = {
  unity: '#222C37',
};

/** Below this WCAG relative luminance a brand hex reads as "near-black". */
const NEAR_BLACK_LUMINANCE = 0.08;

/** Linearize one 0–255 sRGB channel (WCAG relative-luminance transfer). */
function channelLinear(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white) of a `#rrggbb` hex. */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
}

/** A brand color so dark it would vanish on a dark surface (GitHub, Notion, …). */
function isNearBlackBrand(color: string): boolean {
  return color.startsWith('#') && relativeLuminance(color) < NEAR_BLACK_LUMINANCE;
}

/**
 * Wrap a single-path brand glyph as a self-contained inline SVG filled in its
 * brand color. Near-black brands flip to the box's ink (`--pd-connector-ink`,
 * set to currentColor by the app on dark surfaces) so they stay legible on
 * dark; the brand hex is the fallback so the mark is correct without app CSS.
 */
function brandSvg(pathD: string, color: string): string {
  const fill = isNearBlackBrand(color) ? `var(--pd-connector-ink, ${color})` : color;
  return (
    `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="${fill}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${pathD}"/></svg>`
  );
}

/**
 * THE FIRST-PARTY MARKS HAVE A COLOUR EACH. the user (2026-09-17): "all the first
 * party connector icons make a bit more colorful and exciting, not over the
 * top, they're icons, simple still but with a bit of color, not so simple thin
 * white lines only". Same line-art, two tones: the strokes in a hue, and the
 * closed shapes washed with the same hue at 16% — a folder with a folder-
 * coloured body, a clock with a dial. Mid-tones, so they read on the light
 * tile and the dark one alike (no near-black brand flip needed here).
 */
const HUES = {
  amber: '#e0a23a',
  orange: '#ee7d3b',
  rose: '#e35d7a',
  green: '#3fae5d',
  teal: '#2aa7a0',
  sky: '#3c9be6',
  blue: '#3d78e5',
  slate: '#6b7a8c',
} as const;
type Hue = keyof typeof HUES;

/** Wrap neutral line-art shapes as a self-contained, two-tone stroked SVG. */
function neutralSvg(shapes: string, hue: Hue = 'slate'): string {
  const ink = HUES[hue];
  return (
    `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="${ink}" fill-opacity="0.16" stroke="${ink}" ` +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shapes}</svg>`
  );
}

/**
 * Neutral CATEGORY glyphs for connectors that have no simple, published brand
 * mark (or whose mark is complex/proprietary/uncertain/illegible). Deliberately
 * generic line-art so they never misrepresent a brand.
 */
const NEUTRAL_ICON_SVGS: Record<string, string> = {
  // Folder.
  filesystem: neutralSvg(
    '<path d="M3.5 7.25a1.5 1.5 0 0 1 1.5-1.5h3.3l1.7 2h8.5a1.5 1.5 0 0 1 1.5 1.5v7.75a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
    'amber',
  ),
  // Knowledge-graph nodes.
  memory: neutralSvg(
    '<circle cx="6" cy="7" r="2.15"/><circle cx="17.6" cy="7.5" r="2.15"/><circle cx="11.6" cy="17" r="2.15"/><path d="M8.13 7.2 15.47 7.4"/><path d="M7.06 8.86 10.55 15.15"/><path d="M16.55 9.28 12.62 15.2"/>',
    'teal',
  ),
  // Ordered/stepped list.
  'sequential-thinking': neutralSvg(
    '<circle cx="4.75" cy="7" r="1.1"/><circle cx="4.75" cy="12" r="1.1"/><circle cx="4.75" cy="17" r="1.1"/><path d="M8.5 7H20"/><path d="M8.5 12H20"/><path d="M8.5 17H16"/>',
    'sky',
  ),
  // Clock.
  time: neutralSvg('<circle cx="12" cy="12" r="8.25"/><path d="M12 7.4V12l3.1 1.9"/>', 'orange'),
  // Bar chart on axes (analytics / BI).
  tableau: neutralSvg(
    '<path d="M4.5 4.5v15h15"/><path d="M8.5 16.5v-4"/><path d="M12.5 16.5v-7"/><path d="M16.5 16.5v-2.5"/>',
    'sky',
  ),
  // ── First-party builtins ("By us") ──────────────────────────────────────────
  // A terminal prompt: the CLI tool interface.
  'cli-tools': neutralSvg(
    '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m7.5 9.5 3 2.5-3 2.5"/><path d="M12.5 14.5h4"/>',
    'green',
  ),
  // Film strip / frames (motion-graphics render).
  hyperframes: neutralSvg(
    '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7.75 5.5v13M16.25 5.5v13"/><path d="M3.5 9.5h4.25M3.5 14.5h4.25M16.25 9.5h4.25M16.25 14.5h4.25"/>',
    'rose',
  ),
  // A Bézier: one curve with its two handles — the thing an SVG is made of.
  omnisvg: neutralSvg(
    '<path d="M4.5 18.5C6 9 13 6 19.5 5.5"/><path d="M4.5 18.5L9.5 12.5"/><path d="M19.5 5.5L13.5 8.5"/>' +
      '<circle cx="4.5" cy="18.5" r="1.5"/><circle cx="19.5" cy="5.5" r="1.5"/><circle cx="9.5" cy="12.5" r="1.25"/><circle cx="13.5" cy="8.5" r="1.25"/>',
    'orange',
  ),
  // The sidebar's own cube (SessionSidebar ModalityCube), in a hue: the top
  // face drawn as its own closed shape, so the two-tone fill lands on it
  // twice and the cube reads as lit from above. the user (2026-09-18): "that 3d
  // icon doesn't look nice" — the first cut had a stray diagonal across the
  // top and nothing to tell the faces apart.
  'bobble-3d': neutralSvg(
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8-4.5L20 8l-8 4.5z"/><path d="M12 12.5V20.5"/>',
    'teal',
  ),
  // Scissors (a typed ffmpeg cut/edit façade).
  // Three bars on a baseline — the chart card's own glyph.
  'data-visuals': neutralSvg(
    '<path d="M4 20h16"/><rect x="5.5" y="11" width="3.5" height="7" rx="0.8"/><rect x="10.25" y="6" width="3.5" height="12" rx="0.8"/><rect x="15" y="9" width="3.5" height="9" rx="0.8"/>',
    'blue',
  ),
  'video-editing': neutralSvg(
    '<circle cx="6" cy="6.5" r="2.15"/><circle cx="6" cy="17.5" r="2.15"/><path d="M7.9 7.7 19.5 16.5M7.9 16.3 19.5 7.5M12 12l4-2.9"/>',
    'rose',
  ),
  // ── First-party macOS connectors ("By us") ─────────────────────────────────
  // Neutral category glyphs (NOT the trademarked Apple app icons): a calendar
  // grid, an envelope, a chat bubble, a person, and a checklist.
  // Calendar grid.
  'mac-calendar': neutralSvg(
    '<rect x="3.75" y="5" width="16.5" height="15" rx="2"/><path d="M3.75 9.25h16.5"/><path d="M8 3.5v3M16 3.5v3"/><path d="M7.5 13h2.5M14 13h2.5M7.5 16.5h2.5"/>',
    'rose',
  ),
  // Envelope.
  'mac-mail': neutralSvg(
    '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4.25 7.5 7.75 5.75L19.75 7.5"/>',
    'blue',
  ),
  // Rounded chat bubble with a tail.
  'mac-messages': neutralSvg(
    '<path d="M12 4.75c-4.55 0-8.25 2.9-8.25 6.5 0 1.9 1.05 3.6 2.7 4.75-.15 1.15-.7 2.2-1.45 3 1.5-.2 2.9-.75 4-1.6.95.25 1.95.35 3 .35 4.55 0 8.25-2.9 8.25-6.5s-3.7-6.5-8.25-6.5z"/>',
    'green',
  ),
  // Person (bust in a head + shoulders arc).
  'mac-contacts': neutralSvg(
    '<circle cx="12" cy="8.5" r="3.5"/><path d="M5.75 19a6.25 6.25 0 0 1 12.5 0"/>',
    'amber',
  ),
  // Checklist (two checked rows).
  'mac-reminders': neutralSvg(
    '<path d="M4.25 7.25 5.5 8.5l2.25-2.5"/><path d="M4.25 15.25 5.5 16.5l2.25-2.5"/><path d="M11 7.5h8.75M11 15.5h8.75"/>',
    'orange',
  ),
};

/**
 * Connector id → self-contained inline SVG mark. Branded connectors get their
 * canonical simple-icons glyph, or — where the catalog's one colour is not the
 * logo — the brand's own logo file (official-marks.ts: Blender, Chrome, Slack,
 * Figma, Google Drive/Gmail/Calendar, Playwright); everything else gets a
 * neutral category glyph.
 */
export const CONNECTOR_ICON_SVGS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(BRAND_ICONS).map(([id, icon]) => [
      id,
      brandSvg(icon.path, LIGHT_INK[id] ?? `#${icon.hex}`),
    ]),
  ),
  ...OFFICIAL_MARKS,
  ...NEUTRAL_ICON_SVGS,
};

/** Connector ids whose mark is a real, published brand glyph (not a fallback). */
export const BRANDED_CONNECTOR_IDS: readonly string[] = [
  ...new Set([...Object.keys(BRAND_ICONS), ...Object.keys(OFFICIAL_MARKS)]),
];

/** The inline SVG mark for a connector id, if one is defined. */
export function connectorIconSvg(id: string): string | undefined {
  return CONNECTOR_ICON_SVGS[id];
}
