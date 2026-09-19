/**
 * THE OFFICIAL MARKS. the user (2026-09-18): "as much as you can, don't
 * frankenstein or recreate logos, find a catalog or official svgs" — and, of
 * the catalog's one-colour Blender, "blender logo isn't correct (color)".
 *
 * `simple-icons` (the catalog behind connector-icons.ts) ships every brand as
 * ONE path in ONE colour. That is the whole mark for Git, GitHub, Spotify or
 * Notion; for a brand whose identity IS its colours it is a silhouette, and a
 * silhouette in the wrong colour is what the user saw. Those marks come from the
 * brand owner's own logo file here, the paths and colours exactly as
 * published. What {@link officialMark} does to each is the housekeeping an
 * inline SVG needs and nothing else: the root sized 100% so the app's icon box
 * does the sizing, a viewBox where the file gave only a width and a height,
 * and every id namespaced per mark so two marks' gradient ids never collide
 * once they share a document. A file's XML prologue, editor metadata and
 * <title>/<desc> were dropped when the source was pasted (an inline mark
 * has no use for them), and Figma's <style> classes were written as the fill
 * attributes they stood for — a <style> in inline SVG would leak into the page.
 *
 * Sources: the Blender Foundation's logo-without-text (blender.org press kit,
 * as published on Wikimedia Commons); Google's 2020 Drive/Gmail/Calendar and
 * February-2022 Chrome product icons and Slack's 2019 icon (Wikimedia Commons,
 * the files the brands' own pages show); Figma's logo (Wikimedia Commons,
 * "Created using Figma"); Playwright's logo (microsoft/playwright.dev,
 * static/img/playwright-logo.svg). Nothing here is drawn by us. The trademarks
 * are their owners'; each identifies the connector that talks to that product,
 * like every brand mark in the app.
 *
 * Not here, deliberately: Tableau (no official SVG in any catalog reachable,
 * and the alternative is drawing one), Unity (simple-icons carries Unity's own
 * monochrome mark), Zoom (the catalog's mark IS the 2022 wordmark, the same
 * one the installed app wears on its icon), and the macOS apps (Apple's app
 * icons are not published as vectors) — those keep the catalog or a neutral
 * category glyph.
 */

/** Root-tag attributes an inline mark must not carry: the box sizes it. */
const ROOT_ATTRS_TO_DROP =
  /\s+(?:width|height|x|y|version|id|xml:space|enable-background|preserveAspectRatio|aria-hidden)="[^"]*"/g;

/**
 * Prepare one published logo file for inline use under `id`: size the root
 * 100%, give it `viewBox` when the file has none, hide it from assistive
 * tech (the connector's name is the text beside it) and namespace every
 * `id="…"` with its `url(#…)` / `href="#…"` references.
 */
export function officialMark(id: string, source: string, viewBox?: string): string {
  const open = source.match(/^<svg\b([^>]*)>/);
  if (open === null) throw new Error(`official mark ${id}: not an <svg>`);
  let attrs = (open[1] ?? '').replace(ROOT_ATTRS_TO_DROP, '');
  if (!/\sviewBox="/.test(attrs)) {
    if (viewBox === undefined) throw new Error(`official mark ${id}: no viewBox`);
    attrs += ` viewBox="${viewBox}"`;
  }
  const body = source.slice(open[0].length);
  const prefix = `pd-mark-${id}-`;
  const namespaced = body
    .replace(/\bid="([^"]+)"/g, (_m, name: string) => `id="${prefix}${name}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, name: string) => `url(#${prefix}${name})`)
    .replace(/href="#([^"]+)"/g, (_m, name: string) => `href="#${prefix}${name}"`);
  return `<svg${attrs} width="100%" height="100%" aria-hidden="true">${namespaced}`;
}

/**
 * Connector id → the brand's own logo file, verbatim (see the file comment).
 * Keys are connector ids from builtin-connectors.ts / detect-apps.ts.
 */
export const OFFICIAL_MARK_SOURCES: Record<string, { svg: string; viewBox?: string }> = {
  // Blender Foundation — orange body #EA7600, white ring, blue #265787 centre.
  blender: {
    svg: '<svg width="100%" height="100%" style="clip-rule:evenodd;fill-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" version="1.1" viewBox="0 0 181 148" xml:space="preserve" xmlns="http://www.w3.org/2000/svg"> <g transform="matrix(.281 0 0 .281 -41.8 -43.7)"> <g transform="matrix(21.6 0 0 21.6 -4857 7665)"> <path d="m243-334c0.106-1.89 1.03-3.56 2.43-4.74 1.37-1.16 3.21-1.87 5.23-1.87 2.01 0 3.85 0.709 5.22 1.87 1.4 1.18 2.32 2.85 2.43 4.74 0.106 1.94-0.675 3.75-2.04 5.09-1.4 1.36-3.38 2.22-5.61 2.22s-4.22-0.854-5.61-2.22c-1.37-1.34-2.15-3.14-2.04-5.08z" style="fill-rule:nonzero;fill:#fff"/> </g> <g transform="matrix(11.1 0 0 11.1 -2215 4153)"> <path d="m243-334c0.106-1.89 1.03-3.56 2.43-4.74 1.37-1.16 3.21-1.87 5.23-1.87 2.01 0 3.85 0.709 5.22 1.87 1.4 1.18 2.32 2.85 2.43 4.74 0.106 1.94-0.675 3.75-2.04 5.09-1.4 1.36-3.38 2.22-5.61 2.22s-4.22-0.854-5.61-2.22c-1.37-1.34-2.15-3.14-2.04-5.08z" style="fill-rule:nonzero;fill:#265787"/> <path d="m231-330c0.013 0.74 0.249 2.18 0.603 3.3 0.744 2.38 2.01 4.58 3.76 6.51 1.8 1.99 4.02 3.59 6.58 4.73 2.69 1.19 5.61 1.8 8.64 1.8 3.03-4e-3 5.95-0.624 8.64-1.83 2.56-1.15 4.78-2.75 6.58-4.75 1.76-1.95 3.02-4.15 3.76-6.53 0.375-1.2 0.612-2.42 0.707-3.64 0.093-1.2 0.054-2.41-0.117-3.62-0.334-2.35-1.15-4.56-2.4-6.56-1.14-1.85-2.62-3.46-4.38-4.82l4e-3 -3e-3 -17.7-13.6c-0.016-0.012-0.029-0.025-0.046-0.036-1.16-0.892-3.12-0.889-4.39 5e-3 -1.29 0.904-1.44 2.4-0.29 3.34l-5e-3 5e-3 7.39 6.01-22.5 0.024h-0.03c-1.86 2e-3 -3.65 1.22-4 2.77-0.364 1.57 0.9 2.88 2.84 2.88l-3e-3 7e-3 11.4-0.022-20.4 15.6c-0.026 0.019-0.054 0.039-0.078 0.058-1.92 1.47-2.54 3.92-1.33 5.46 1.23 1.57 3.84 1.58 5.78 9e-3l11.1-9.1s-0.162 1.23-0.149 1.96zm28.6 4.11c-2.29 2.33-5.5 3.66-8.96 3.66-3.47 6e-3 -6.68-1.3-8.97-3.63-1.12-1.14-1.94-2.44-2.45-3.83-0.497-1.37-0.69-2.82-0.562-4.28 0.121-1.43 0.547-2.8 1.23-4.03 0.668-1.21 1.59-2.31 2.72-3.24 2.23-1.81 5.06-2.8 8.02-2.8 2.97-4e-3 5.8 0.969 8.03 2.78 1.13 0.924 2.05 2.02 2.72 3.23 0.683 1.23 1.11 2.59 1.23 4.03 0.126 1.46-0.067 2.91-0.564 4.28-0.508 1.4-1.33 2.7-2.45 3.84z" style="fill-rule:nonzero;fill:#ea7600"/> </g> </g> </svg>',
  },
  // Google Chrome, February 2022 icon: the three gradient sectors, the white
  // ring, the blue #1a73e8 centre. The Chrome DevTools connector is Chrome's.
  'chrome-devtools': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="a" x1="3.2173" y1="15" x2="44.7812" y2="15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d93025"/><stop offset="1" stop-color="#ea4335"/></linearGradient><linearGradient id="b" x1="20.7219" y1="47.6791" x2="41.5039" y2="11.6837" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fcc934"/><stop offset="1" stop-color="#fbbc04"/></linearGradient><linearGradient id="c" x1="26.5981" y1="46.5015" x2="5.8161" y2="10.506" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1e8e3e"/><stop offset="1" stop-color="#34a853"/></linearGradient></defs><circle cx="24" cy="23.9947" r="12" style="fill:#fff"/><path d="M3.2154,36A24,24,0,1,0,12,3.2154,24,24,0,0,0,3.2154,36ZM34.3923,18A12,12,0,1,1,18,13.6077,12,12,0,0,1,34.3923,18Z" style="fill:none"/><path d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z" style="fill:url(#a)"/><circle cx="24" cy="24" r="9.5" style="fill:#1a73e8"/><path d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z" style="fill:url(#b)"/><path d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z" style="fill:url(#c)"/></svg>',
  },
  // Slack, 2019 icon: the four lozenges #E01E5A #36C5F0 #2EB67D #ECB22E.
  // The file gives width/height 127 and no viewBox.
  slack: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z" fill="#E01E5A"/><path d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z" fill="#36C5F0"/><path d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z" fill="#2EB67D"/><path d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z" fill="#ECB22E"/></svg>',
    viewBox: '0 0 127 127',
  },
  // Figma: the five shapes #0acf83 #a259ff #f24e1e #ff7262 #1abcfe.
  figma: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><path fill="#0acf83" d="M50 300c27.6 0 50-22.4 50-50v-50H50c-27.6 0-50 22.4-50 50s22.4 50 50 50z"/><path fill="#a259ff" d="M0 150c0-27.6 22.4-50 50-50h50v100H50c-27.6 0-50-22.4-50-50z"/><path fill="#f24e1e" d="M0 50C0 22.4 22.4 0 50 0h50v100H50C22.4 100 0 77.6 0 50z"/><path fill="#ff7262" d="M100 0h50c27.6 0 50 22.4 50 50s-22.4 50-50 50h-50V0z"/><path fill="#1abcfe" d="M200 150c0 27.6-22.4 50-50 50s-50-22.4-50-50 22.4-50 50-50 50 22.4 50 50z"/></svg>',
  },
  // Google Drive, 2020 icon: six facets in Google's blues, greens, red, yellow.
  'google-drive': {
    svg: '<svg viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>',
  },
  // Gmail, 2020 icon: the M in blue/green/yellow/red on a white ground the
  // file leaves to the surface.
  gmail: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="52 42 88 66"><path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6"/><path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15"/><path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2"/><path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92"/><path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2"/></svg>',
  },
  // Google Calendar, 2020 icon: the page with "31" in Google's colours.
  'google-calendar': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g><g transform="translate(3.75 3.75)"><path fill="#FFFFFF" d="M148.882,43.618l-47.368-5.263l-57.895,5.263L38.355,96.25l5.263,52.632l52.632,6.579l52.632-6.579 l5.263-53.947L148.882,43.618z"/><path fill="#1A73E8" d="M65.211,125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c0.829,3.158,2.276,5.605,4.342,7.342 c2.053,1.737,4.553,2.592,7.474,2.592c2.987,0,5.553-0.908,7.697-2.724s3.224-4.132,3.224-6.934c0-2.868-1.132-5.211-3.395-7.026 s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921,0,5.382-0.789,7.382-2.368c2-1.579,3-3.737,3-6.487 c0-2.447-0.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684,0-4.816,0.711-6.395,2.145s-2.724,3.197-3.447,5.276 l-9.039-3.763c1.197-3.395,3.395-6.395,6.618-8.987c3.224-2.592,7.342-3.895,12.342-3.895c3.697,0,7.026,0.711,9.974,2.145 c2.947,1.434,5.263,3.421,6.934,5.947c1.671,2.539,2.5,5.382,2.5,8.539c0,3.224-0.776,5.947-2.329,8.184 c-1.553,2.237-3.461,3.947-5.724,5.145v0.539c2.987,1.25,5.421,3.158,7.342,5.724c1.908,2.566,2.868,5.632,2.868,9.211 s-0.908,6.776-2.724,9.579c-1.816,2.803-4.329,5.013-7.513,6.618c-3.197,1.605-6.789,2.421-10.776,2.421 C73.408,129.263,69.145,127.934,65.211,125.276z"/><path fill="#1A73E8" d="M121.25,79.961l-9.974,7.25l-5.013-7.605l17.987-12.974h6.895v61.197h-9.895L121.25,79.961z"/><path fill="#EA4335" d="M148.882,196.25l47.368-47.368l-23.684-10.526l-23.684,10.526l-10.526,23.684L148.882,196.25z"/><path fill="#34A853" d="M33.092,172.566l10.526,23.684h105.263v-47.368H43.618L33.092,172.566z"/><path fill="#4285F4" d="M12.039-3.75C3.316-3.75-3.75,3.316-3.75,12.039v136.842l23.684,10.526l23.684-10.526V43.618h105.263 l10.526-23.684L148.882-3.75H12.039z"/><path fill="#188038" d="M-3.75,148.882v31.579c0,8.724,7.066,15.789,15.789,15.789h31.579v-47.368H-3.75z"/><path fill="#FBBC04" d="M148.882,43.618v105.263h47.368V43.618l-23.684-10.526L148.882,43.618z"/><path fill="#1967D2" d="M196.25,43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368H196.25z"/></g></g></svg>',
  },
  // Playwright: the two masks, red and green, from playwright.dev.
  playwright: {
    svg: '<svg viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M136.444 221.556C123.558 225.213 115.104 231.625 109.535 238.032C114.869 233.364 122.014 229.08 131.652 226.348C141.51 223.554 149.92 223.574 156.869 224.915V219.481C150.941 218.939 144.145 219.371 136.444 221.556ZM108.946 175.876L61.0895 188.484C61.0895 188.484 61.9617 189.716 63.5767 191.36L104.153 180.668C104.153 180.668 103.578 188.077 98.5847 194.705C108.03 187.559 108.946 175.876 108.946 175.876ZM149.005 288.347C81.6582 306.486 46.0272 228.438 35.2396 187.928C30.2556 169.229 28.0799 155.067 27.5 145.928C27.4377 144.979 27.4665 144.179 27.5336 143.446C24.04 143.657 22.3674 145.473 22.7077 150.721C23.2876 159.855 25.4633 174.016 30.4473 192.721C41.2301 233.225 76.8659 311.273 144.213 293.134C158.872 289.185 169.885 281.992 178.152 272.81C170.532 279.692 160.995 285.112 149.005 288.347ZM161.661 128.11V132.903H188.077C187.535 131.206 186.989 129.677 186.447 128.11H161.661Z" fill="#2D4552"/><path d="M193.981 167.584C205.861 170.958 212.144 179.287 215.465 186.658L228.711 190.42C228.711 190.42 226.904 164.623 203.57 157.995C181.741 151.793 168.308 170.124 166.674 172.496C173.024 167.972 182.297 164.268 193.981 167.584ZM299.422 186.777C277.573 180.547 264.145 198.916 262.535 201.255C268.89 196.736 278.158 193.031 289.837 196.362C301.698 199.741 307.976 208.06 311.307 215.436L324.572 219.212C324.572 219.212 322.736 193.41 299.422 186.777ZM286.262 254.795L176.072 223.99C176.072 223.99 177.265 230.038 181.842 237.869L274.617 263.805C282.255 259.386 286.262 254.795 286.262 254.795ZM209.867 321.102C122.618 297.71 133.166 186.543 147.284 133.865C153.097 112.156 159.073 96.0203 164.029 85.204C161.072 84.5953 158.623 86.1529 156.203 91.0746C150.941 101.747 144.212 119.124 137.7 143.45C123.586 196.127 113.038 307.29 200.283 330.682C241.406 341.699 273.442 324.955 297.323 298.659C274.655 319.19 245.714 330.701 209.867 321.102Z" fill="#2D4552"/><path d="M161.661 262.296V239.863L99.3324 257.537C99.3324 257.537 103.938 230.777 136.444 221.556C146.302 218.762 154.713 218.781 161.661 220.123V128.11H192.869C189.471 117.61 186.184 109.526 183.423 103.909C178.856 94.612 174.174 100.775 163.545 109.665C156.059 115.919 137.139 129.261 108.668 136.933C80.1966 144.61 57.179 142.574 47.5752 140.911C33.9601 138.562 26.8387 135.572 27.5049 145.928C28.0847 155.062 30.2605 169.224 35.2445 187.928C46.0272 228.433 81.663 306.481 149.01 288.342C166.602 283.602 179.019 274.233 187.626 262.291H161.661V262.296ZM61.0848 188.484L108.946 175.876C108.946 175.876 107.551 194.288 89.6087 199.018C71.6614 203.743 61.0848 188.484 61.0848 188.484Z" fill="#E2574C"/><path d="M341.786 129.174C329.345 131.355 299.498 134.072 262.612 124.185C225.716 114.304 201.236 97.0224 191.537 88.8994C177.788 77.3834 171.74 69.3802 165.788 81.4857C160.526 92.163 153.797 109.54 147.284 133.866C133.171 186.543 122.623 297.706 209.867 321.098C297.093 344.47 343.53 242.92 357.644 190.238C364.157 165.917 367.013 147.5 367.799 135.625C368.695 122.173 359.455 126.078 341.786 129.174ZM166.497 172.756C166.497 172.756 180.246 151.372 203.565 158C226.899 164.628 228.706 190.425 228.706 190.425L166.497 172.756ZM223.42 268.713C182.403 256.698 176.077 223.99 176.077 223.99L286.262 254.796C286.262 254.791 264.021 280.578 223.42 268.713ZM262.377 201.495C262.377 201.495 276.107 180.126 299.422 186.773C322.736 193.411 324.572 219.208 324.572 219.208L262.377 201.495Z" fill="#2EAD33"/><path d="M139.88 246.04L99.3324 257.532C99.3324 257.532 103.737 232.44 133.607 222.496L110.647 136.33L108.663 136.933C80.1918 144.611 57.1742 142.574 47.5704 140.911C33.9554 138.563 26.834 135.572 27.5001 145.929C28.08 155.063 30.2557 169.224 35.2397 187.929C46.0225 228.433 81.6583 306.481 149.005 288.342L150.989 287.719L139.88 246.04ZM61.0848 188.485L108.946 175.876C108.946 175.876 107.551 194.288 89.6087 199.018C71.6615 203.743 61.0848 188.485 61.0848 188.485Z" fill="#D65348"/><path d="M225.27 269.163L223.415 268.712C182.398 256.698 176.072 223.99 176.072 223.99L232.89 239.872L262.971 124.281L262.607 124.185C225.711 114.304 201.232 97.0224 191.532 88.8994C177.783 77.3834 171.735 69.3802 165.783 81.4857C160.526 92.163 153.797 109.54 147.284 133.866C133.171 186.543 122.623 297.706 209.867 321.097L211.655 321.5L225.27 269.163ZM166.497 172.756C166.497 172.756 180.246 151.372 203.565 158C226.899 164.628 228.706 190.425 228.706 190.425L166.497 172.756Z" fill="#1D8D22"/><path d="M141.946 245.451L131.072 248.537C133.641 263.019 138.169 276.917 145.276 289.195C146.513 288.922 147.74 288.687 149 288.342C152.302 287.451 155.364 286.348 158.312 285.145C150.371 273.361 145.118 259.789 141.946 245.451ZM137.7 143.451C132.112 164.307 127.113 194.326 128.489 224.436C130.952 223.367 133.554 222.371 136.444 221.551L138.457 221.101C136.003 188.939 141.308 156.165 147.284 133.866C148.799 128.225 150.318 122.978 151.832 118.085C149.393 119.637 146.767 121.228 143.776 122.867C141.759 129.093 139.722 135.898 137.7 143.451Z" fill="#C04B41"/></svg>',
  },
};

/** Connector id → the prepared inline mark. */
export const OFFICIAL_MARKS: Record<string, string> = Object.fromEntries(
  Object.entries(OFFICIAL_MARK_SOURCES).map(([id, { svg, viewBox }]) => [
    id,
    officialMark(id, svg, viewBox),
  ]),
);
