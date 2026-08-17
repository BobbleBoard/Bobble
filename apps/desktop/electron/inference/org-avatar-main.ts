/**
 * REAL ORG LOGOS — Hugging Face avatars, cached to disk.
 *
 * the user: "first real svgs please". simple-icons covers about a dozen labs; the
 * hub lists hundreds of orgs and individual re-publishers, so most rows fell
 * back to a monogram. HF serves everyone's actual avatar; this fetches it.
 *
 * WHY MAIN, AND WHY DISK. The renderer cannot fetch it — the CSP is
 * `img-src 'self' data: blob: pd-file:` — and an earlier attempt to point an
 * <img> at huggingface.co produced 23 blocked requests and zero logos. So main
 * downloads once, writes under the agent dir, and hands back a `pd-file://`
 * URL the renderer is allowed to load. That also makes the logos work offline
 * on every run after the first, which a remote <img> never would.
 *
 * The API also returns `isVerified`, so the blue check can be shown TRUTHFULLY
 * rather than stamped on every row — it was removed earlier precisely because
 * search does not carry it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(homedir(), '.pi', 'agent', 'org-avatars');

/** In-memory result cache, so a scrolling list does not re-hit the API. */
const memo = new Map<string, { path?: string; verified?: boolean; error?: string }>();

/** An org name is user data; never let it choose a path. */
function safeName(org: string): string {
  return createHash('sha1').update(org.toLowerCase()).digest('hex').slice(0, 16);
}

function cachedFile(org: string): string | undefined {
  if (!existsSync(CACHE_DIR)) return undefined;
  const stem = safeName(org);
  try {
    const hit = readdirSync(CACHE_DIR).find((f) => f.startsWith(`${stem}.`));
    return hit === undefined ? undefined : path.join(CACHE_DIR, hit);
  } catch {
    return undefined;
  }
}

/** `pd-file://f/<encoded abs path>` — the scheme canvas-main serves. */
function pdFileUrl(abs: string): string {
  return `pd-file://f${abs.split(path.sep).map(encodeURIComponent).join('/')}`;
}

interface Overview {
  avatarUrl?: string;
  isVerified?: boolean;
}

async function overview(org: string): Promise<Overview | undefined> {
  // Orgs and individuals live on different endpoints, and a model author can be
  // either — try the org first, fall back to the user.
  for (const kind of ['organizations', 'users']) {
    try {
      const res = await fetch(
        `https://huggingface.co/api/${kind}/${encodeURIComponent(org)}/overview`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as Overview;
      if (typeof body.avatarUrl === 'string') return body;
    } catch {
      /* try the next kind */
    }
  }
  return undefined;
}

/**
 * ANY remote image, cached to disk and returned as a `pd-file://` URL.
 *
 * Model cards are full of `<img src="https://github.com/...">` badge rows and
 * screenshots, and the renderer's CSP (`img-src 'self' data: blob: pd-file:`)
 * blocks every one — so a card that "renders HTML" still showed no pictures.
 * Same mechanism as the org avatars, generalised: main fetches once, writes
 * under the agent dir, hands back a URL the renderer may load. Offline after
 * the first view, which a remote <img> never is.
 *
 * Fenced deliberately: http/https only, a size cap, and an image content-type,
 * so a card cannot use this to pull down arbitrary files.
 */
export async function cacheRemoteImage(url: string): Promise<{ path?: string; error?: string }> {
  const key = `img:${url}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'bad url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'unsupported protocol' };
  }

  const stem = `img-${safeName(url)}`;
  try {
    if (existsSync(CACHE_DIR)) {
      const found = readdirSync(CACHE_DIR).find((f) => f.startsWith(`${stem}.`));
      if (found !== undefined) {
        const out = { path: pdFileUrl(path.join(CACHE_DIR, found)) };
        memo.set(key, out);
        return out;
      }
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new Error('not an image');
    const ext = type.includes('svg')
      ? 'svg'
      : type.includes('png')
        ? 'png'
        : type.includes('gif')
          ? 'gif'
          : type.includes('webp')
            ? 'webp'
            : 'jpg';
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > 8_000_000) throw new Error('image too large');
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${stem}.${ext}`);
    writeFileSync(file, bytes);
    const out = { path: pdFileUrl(file) };
    memo.set(key, out);
    return out;
  } catch (e) {
    const out = { error: e instanceof Error ? e.message : 'could not fetch image' };
    memo.set(key, out);
    return out;
  }
}

export async function fetchOrgAvatar(
  org: string,
): Promise<{ path?: string; verified?: boolean; error?: string }> {
  const key = org.toLowerCase();
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  const onDisk = cachedFile(org);
  if (onDisk !== undefined) {
    const out = { path: pdFileUrl(onDisk) };
    memo.set(key, out);
    return out;
  }

  const info = await overview(org);
  if (info?.avatarUrl === undefined) {
    const out = { error: 'no avatar' };
    memo.set(key, out);
    return out;
  }
  // Individual avatars come back as a site-relative path; org ones are absolute.
  const url = info.avatarUrl.startsWith('http')
    ? info.avatarUrl
    : `https://huggingface.co${info.avatarUrl}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const ext = type.includes('svg')
      ? 'svg'
      : type.includes('png')
        ? 'png'
        : type.includes('webp')
          ? 'webp'
          : 'jpg';
    const bytes = Buffer.from(await res.arrayBuffer());
    // A logo is small; anything large is not one, and is not worth caching.
    if (bytes.byteLength > 2_000_000) throw new Error('avatar too large');
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${safeName(org)}.${ext}`);
    writeFileSync(file, bytes);
    const out = { path: pdFileUrl(file), verified: info.isVerified };
    memo.set(key, out);
    return out;
  } catch (e) {
    const out = { error: e instanceof Error ? e.message : 'could not fetch avatar' };
    memo.set(key, out);
    return out;
  }
}
