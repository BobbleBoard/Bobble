/**
 * The one door every source-decoration request goes out through — a page's
 * head for its name and picture, an icon, a thumbnail — so its rules live in
 * one place:
 *
 *  - no cookies (Node's fetch keeps none) and no referrer: this is decoration,
 *    not a visit on the user's behalf;
 *  - a hard time limit and a byte cap, read as a stream, so a hostile or huge
 *    response costs at most the cap;
 *  - PUBLIC SITES ONLY. A search result is text from the internet and so is a
 *    link the model writes; a row that fetched `http://192.168.1.1/…` because
 *    a page said to would be a GET against the user's own router, from their
 *    own machine. So a private, loopback or local-only host is never asked,
 *    and neither is one a redirect points at ({@link isPublicHost});
 *  - under PI_E2E only, `PI_E2E_SOURCES_ORIGIN` sends `https://<host>/<path>`
 *    to `<origin>/site/<host>/<path>` — the loopback double a probe serves
 *    (tests/e2e/sources-look.mjs; the same route shape as _mock-web.mjs), so a
 *    look at the sources UI never touches the internet.
 */

/**
 * Is `hostname` a site on the public internet — not an address on this
 * machine or its network, and not a name that only resolves there?
 */
export function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '') return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT, tailnets
    return true;
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return false;
    if (h.startsWith('::ffff:')) return isPublicHost(h.slice(7));
    return !/^(f[cd]|fe[89ab])/.test(h); // unique-local, link-local
  }
  // A name with no dot is an intranet host; these suffixes never leave one.
  if (!h.includes('.')) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|corp|home\.arpa)$/.test(h);
}

/** An http(s) URL on a public host (see {@link isPublicHost}). */
export function isPublicUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && isPublicHost(u.hostname);
  } catch {
    return false;
  }
}

/** Where a request for `url` actually goes. */
export function routeSourceUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const origin = env.PI_E2E === '1' ? env.PI_E2E_SOURCES_ORIGIN : undefined;
  if (origin === undefined || origin === '') return url;
  try {
    const u = new URL(url);
    return `${origin.replace(/\/+$/, '')}/site/${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * A browser's user agent. Plenty of sites answer a bare `node` UA with a 403
 * or a bot wall, which is a missing picture for no reason; web_fetch sends the
 * same string for the same cause (packages/web-tools fetch.ts).
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const MAX_REDIRECTS = 5;

export interface CappedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly type: string;
  readonly finalUrl: string;
  readonly body: Buffer;
  /** The cap was hit (or `stopAt` matched) before the body ended. */
  readonly truncated: boolean;
}

/**
 * GET `url` with a deadline and a byte cap. `stopAt` ends the read early once
 * the bytes so far match it (a page's `</head>`). Never throws: a network
 * failure is `{ ok: false, status: 0 }`.
 */
export async function fetchCapped(
  url: string,
  opts: {
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly accept: string;
    readonly stopAt?: RegExp;
    /** Content types worth reading; anything else is answered without its body. */
    readonly types?: RegExp;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<CappedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const fail = (status = 0): CappedResponse => ({
    ok: false,
    status,
    type: '',
    finalUrl: url,
    body: Buffer.alloc(0),
    truncated: false,
  });
  try {
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    /*
     * Redirects followed BY HAND, so every hop is checked for being a public
     * site before it is asked — `redirect: 'follow'` would let a public page
     * bounce the request onto the local network.
     */
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isPublicUrl(current)) return fail();
      const answer = await doFetch(routeSourceUrl(current), {
        signal: controller.signal,
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        headers: { 'user-agent': UA, accept: opts.accept },
      });
      const location = answer.headers.get('location');
      if (answer.status >= 300 && answer.status < 400 && location !== null) {
        await answer.body?.cancel().catch(() => undefined);
        current = new URL(location, current).href;
        continue;
      }
      res = answer;
      break;
    }
    if (res === null) return fail();
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ...fail(res.status), type };
    }
    if (opts.types !== undefined && !opts.types.test(type)) {
      // The site answered — a PDF, a download — just not with anything we read.
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: true,
        status: res.status,
        type,
        finalUrl: current,
        body: Buffer.alloc(0),
        truncated: false,
      };
    }
    // A redirect's destination is the base for the page's relative links.
    const finalUrl = current;
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    // The last few bytes of the previous chunk, so a `</head>` split across two
    // chunks still stops the read.
    let tail = '';
    const reader = res.body?.getReader();
    if (reader === undefined) {
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        ok: true,
        status: res.status,
        type,
        finalUrl,
        body: buf.subarray(0, opts.maxBytes),
        truncated: buf.byteLength > opts.maxBytes,
      };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= opts.maxBytes) {
        truncated = true;
        break;
      }
      const seen = tail + chunk.toString('latin1');
      if (opts.stopAt?.test(seen) === true) {
        truncated = true;
        break;
      }
      tail = seen.slice(-16);
    }
    if (truncated) await reader.cancel().catch(() => undefined);
    return {
      ok: true,
      status: res.status,
      type,
      finalUrl,
      body: Buffer.concat(chunks).subarray(0, opts.maxBytes),
      truncated,
    };
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}
