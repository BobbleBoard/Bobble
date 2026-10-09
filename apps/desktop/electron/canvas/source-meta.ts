/**
 * A SOURCE'S NAME, ICON AND PICTURE — fetched from the page itself, once, and
 * kept.
 *
 * The user (2026-09-24), asking for sources in answers the way Google's overview
 * shows them: each row a site's icon and name, the page's title and a
 * thumbnail. The search result the model saw carries a title and a snippet and
 * nothing else, so the rest comes from the page's own `<head>` — `og:site_name`,
 * `og:image`, its declared icons — read here in MAIN:
 *
 *  - FIRST-PARTY ONLY. Every byte comes from the page's own site. No favicon
 *    service, no preview API: those turn "show an icon" into "tell a third
 *    party every page this person researched".
 *  - SMALL. The head only (the read stops at `</head>`, 256 KB at most); the
 *    icon capped at 100 KB; the picture at 4 MB and shrunk to a 256px
 *    thumbnail before it is kept or crosses IPC.
 *  - OFFLINE-FIRST. Nothing waits on this: the renderer draws a letter tile
 *    and the site's host straight away and fills in what arrives. A page that
 *    answered is kept on disk under the support root for two weeks, so the
 *    chips of yesterday's answer have their icons on a plane. A page that did
 *    not answer is remembered for five minutes, not forever — being offline is
 *    not a fact about the site.
 *
 * Electron-free (the tests run it under plain Node): the thumbnailer, which
 * needs `nativeImage`, and the cache directory are handed in by the IPC wiring
 * in ./browser-agent.ts.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { SourceMetaDto } from '../ipc-contract';
import { siteFavicon } from './favicons';
import { fetchCapped, isPublicHost } from './source-fetch';
import { type PageMeta, parsePageMeta } from './source-meta-parse';

export interface SourceMetaDeps {
  readonly fetchImpl?: typeof fetch;
  /** Where answered pages persist; null/undefined keeps them in memory only. */
  readonly cacheDir?: string | null;
  /**
   * Decode a picture and shrink it to a thumbnail, or null when it cannot be
   * decoded. Injected because the decoder (`nativeImage`) exists only in main.
   */
  readonly thumbnail?: (bytes: Buffer, type: string) => { data: Buffer; type: string } | null;
  /** The site-wide icon for a page that declares none (./favicons). */
  readonly hostIcon?: (host: string) => Promise<string | null>;
  readonly now?: () => number;
}

const PAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const MAX_HEAD_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 100 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** A picture the thumbnailer cannot decode is kept as-is only when this small. */
const MAX_RAW_THUMB_BYTES = 160 * 1024;
/** Lookups at once — "Show all" on a forty-source answer must not fire forty. */
const MAX_CONCURRENT = 4;
/** On-disk entries kept before the oldest are dropped. */
const MAX_DISK_ENTRIES = 1500;

const ICON_TYPES = /^image\/(x-icon|vnd\.microsoft\.icon|png|jpeg|gif|webp|svg\+xml)$/;
/** Raster only: a thumbnail is a photo-shaped thing, and an SVG share image is rare and odd. */
const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

interface Remembered {
  readonly at: number;
  readonly meta: SourceMetaDto;
  /** The site answered: worth keeping two weeks (and on disk). */
  readonly answered: boolean;
}

const memory = new Map<string, Remembered>();
const inFlight = new Map<string, Promise<SourceMetaDto | null>>();
let running = 0;
const waiting: (() => void)[] = [];
let pruned = false;

/**
 * The URL a lookup is for — http(s) on a public site (./source-fetch
 * isPublicHost), no credentials, no fragment — else null.
 */
export function sourceMetaUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username !== '' || u.password !== '') return null;
    if (!isPublicHost(u.hostname)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function cacheFile(dir: string, url: string): string {
  return path.join(dir, `${createHash('sha1').update(url).digest('hex')}.json`);
}

function readDisk(dir: string | null | undefined, url: string, now: number): Remembered | null {
  if (dir === null || dir === undefined) return null;
  try {
    const raw = JSON.parse(readFileSync(cacheFile(dir, url), 'utf8')) as {
      v?: number;
      at?: number;
      meta?: SourceMetaDto;
    };
    if (raw.v !== 1 || typeof raw.at !== 'number' || raw.meta?.url !== url) return null;
    if (now - raw.at > PAGE_TTL_MS) return null;
    return { at: raw.at, meta: raw.meta, answered: true };
  } catch {
    return null;
  }
}

function writeDisk(dir: string | null | undefined, url: string, entry: Remembered): void {
  if (dir === null || dir === undefined) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = cacheFile(dir, url);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, at: entry.at, meta: entry.meta }));
    renameSync(tmp, file);
    if (!pruned) {
      pruned = true;
      prune(dir);
    }
  } catch {
    // A full disk or a read-only home costs the cache, not the answer.
  }
}

/** Keep the directory bounded: past the limit, the least recently written go. */
function prune(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_DISK_ENTRIES) return;
    const aged = files
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { f } of aged.slice(0, files.length - Math.floor(MAX_DISK_ENTRIES * 0.7))) {
      unlinkSync(path.join(dir, f));
    }
  } catch {
    // Best effort.
  }
}

async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function dataUri(type: string, bytes: Buffer): string {
  return `data:${type};base64,${bytes.toString('base64')}`;
}

async function fetchIcon(href: string, deps: SourceMetaDeps): Promise<string | undefined> {
  const res = await fetchCapped(href, {
    maxBytes: MAX_ICON_BYTES + 1,
    timeoutMs: 4000,
    accept: 'image/*',
    fetchImpl: deps.fetchImpl,
  });
  if (!res.ok || res.truncated || res.body.byteLength === 0) return undefined;
  // An HTML error page served at the icon's URL is common; it is not an icon.
  if (!ICON_TYPES.test(res.type)) return undefined;
  return dataUri(res.type, res.body);
}

async function fetchPicture(href: string, deps: SourceMetaDeps): Promise<string | undefined> {
  const res = await fetchCapped(href, {
    maxBytes: MAX_IMAGE_BYTES + 1,
    timeoutMs: 8000,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
    types: PICTURE_TYPES,
    fetchImpl: deps.fetchImpl,
  });
  if (!res.ok || res.truncated || res.body.byteLength === 0) return undefined;
  const thumb = deps.thumbnail?.(res.body, res.type) ?? null;
  if (thumb !== null) return dataUri(thumb.type, thumb.data);
  return res.body.byteLength <= MAX_RAW_THUMB_BYTES ? dataUri(res.type, res.body) : undefined;
}

async function lookup(url: string, deps: SourceMetaDeps): Promise<Remembered> {
  const page = await fetchCapped(url, {
    maxBytes: MAX_HEAD_BYTES,
    timeoutMs: 6000,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    stopAt: /<\/head\s*>|<body[\s>]/i,
    types: /html|xml/,
    fetchImpl: deps.fetchImpl,
  });
  const parsed: PageMeta =
    page.ok && page.body.byteLength > 0
      ? parsePageMeta(page.body.toString('utf8'), page.finalUrl)
      : { icons: [] };

  let icon: string | undefined;
  for (const href of parsed.icons.slice(0, 3)) {
    icon = await fetchIcon(href, deps);
    if (icon !== undefined) break;
  }
  if (icon === undefined) {
    const host = new URL(url).hostname;
    icon = (await (deps.hostIcon ?? siteFavicon)(host)) ?? undefined;
  }
  const image = parsed.image !== undefined ? await fetchPicture(parsed.image, deps) : undefined;

  const meta: SourceMetaDto = {
    url,
    ...(parsed.siteName !== undefined ? { siteName: parsed.siteName } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(image !== undefined ? { image } : {}),
  };
  return { at: deps.now?.() ?? Date.now(), meta, answered: page.ok };
}

/**
 * Everything known about a source page, or null for a URL that is not one
 * (not http(s), credentials in it). Never throws; never waits on a lookup
 * already answered.
 */
export async function sourceMeta(
  raw: string,
  deps: SourceMetaDeps = {},
): Promise<SourceMetaDto | null> {
  const url = sourceMetaUrl(raw);
  if (url === null) return null;
  const now = deps.now?.() ?? Date.now();
  const known = memory.get(url);
  if (known !== undefined && now - known.at < (known.answered ? PAGE_TTL_MS : MISS_TTL_MS)) {
    return known.meta;
  }
  const kept = readDisk(deps.cacheDir, url, now);
  if (kept !== null) {
    memory.set(url, kept);
    return kept.meta;
  }
  const pending = inFlight.get(url);
  if (pending !== undefined) return await pending;

  const job = withSlot(async () => {
    const entry = await lookup(url, deps);
    memory.set(url, entry);
    if (entry.answered) writeDisk(deps.cacheDir, url, entry);
    return entry.meta;
  }).catch(() => ({ url }) as SourceMetaDto);
  inFlight.set(url, job);
  try {
    return await job;
  } finally {
    inFlight.delete(url);
  }
}

/** Test seam: forget everything held in memory. */
export function clearSourceMetaMemory(): void {
  memory.clear();
  inFlight.clear();
  pruned = false;
}
