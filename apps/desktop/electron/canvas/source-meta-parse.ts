/**
 * What a page says about itself in its `<head>` — the site's name, the title,
 * a description, its icons and the picture it wants shown when it is shared.
 *
 * Pure (a string in, a record out) so the rules are unit-tested; the fetching
 * lives in ./source-meta.ts. It reads the head only: everything a sources row
 * needs is declared there, and a page's body is the one part of it that can be
 * megabytes long.
 */

export interface PageMeta {
  readonly siteName?: string;
  readonly title?: string;
  readonly description?: string;
  /** Icon URLs, absolute, the best candidate first. */
  readonly icons: readonly string[];
  /** The share picture (`og:image` / `twitter:image`), absolute. */
  readonly image?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Undo the HTML escaping in an attribute or a title. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `name="value"`, `name='value'` and `name=value` attributes of one tag. */
export function tagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of tag.matchAll(re)) {
    const name = (m[1] as string).toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (href === undefined || href.trim() === '') return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function clean(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  if (t === '') return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** How good an icon is at the 14–16px a row draws it — higher is better. */
function iconScore(
  rel: string,
  sizes: string | undefined,
  type: string | undefined,
  href: string,
): number {
  if (rel.includes('mask-icon')) return -1; // a one-colour silhouette meant to be tinted
  const px = Math.max(
    0,
    ...(sizes ?? '')
      .split(/\s+/)
      .map((s) => Number.parseInt(s.split('x')[0] ?? '', 10))
      .filter(Number.isFinite),
  );
  const svg = type === 'image/svg+xml' || /\.svg(\?|$)/i.test(href);
  if (rel.includes('apple-touch-icon')) return 30;
  if (svg) return 40;
  if (px >= 32 && px <= 256) return 50 + Math.min(px, 96) / 10;
  if (px > 256) return 35;
  return 20; // no size given: usually the 16px /favicon.ico
}

/**
 * Read a page's head. `baseUrl` resolves relative hrefs (a `<base href>` in
 * the head wins over it, as it does in a browser).
 */
export function parsePageMeta(html: string, baseUrl: string): PageMeta {
  const headEnd = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd === -1 ? html.slice(0, 256 * 1024) : html.slice(0, headEnd);
  const baseTag = /<base\s[^>]*>/i.exec(head);
  const base =
    absolute(baseTag === null ? undefined : tagAttributes(baseTag[0]).href, baseUrl) ?? baseUrl;

  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
    const a = tagAttributes(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key !== '' && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }

  const icons: { href: string; score: number; order: number }[] = [];
  let imageSrc: string | undefined;
  let order = 0;
  for (const m of head.matchAll(/<link\s[^>]*>/gi)) {
    const a = tagAttributes(m[0]);
    const rel = (a.rel ?? '').toLowerCase();
    const href = absolute(a.href, base);
    if (href === undefined) continue;
    if (rel === 'image_src') imageSrc ??= href;
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const score = iconScore(rel, a.sizes, a.type?.toLowerCase(), href);
    if (score >= 0) icons.push({ href, score, order: order++ });
  }
  icons.sort((x, y) => y.score - x.score || x.order - y.order);

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const image =
    absolute(meta.get('og:image:secure_url'), base) ??
    absolute(meta.get('og:image'), base) ??
    absolute(meta.get('og:image:url'), base) ??
    absolute(meta.get('twitter:image'), base) ??
    absolute(meta.get('twitter:image:src'), base) ??
    imageSrc;

  const siteName = clean(meta.get('og:site_name') ?? meta.get('application-name'), 80);
  const title = clean(
    meta.get('og:title') ?? meta.get('twitter:title') ?? decodeEntities(titleTag?.[1] ?? ''),
    300,
  );
  const description = clean(
    meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
    400,
  );
  return {
    ...(siteName !== undefined ? { siteName } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    icons: [...new Set(icons.map((i) => i.href))],
    ...(image !== undefined ? { image } : {}),
  };
}
