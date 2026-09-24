/**
 * THE HEADERS A PROVIDER REQUEST CARRIES — including the ones pi hands us.
 *
 * pi delivers a models.json provider's `headers`, `apiKey` and `authHeader`
 * NOT on the model object (it builds models.json models with `headers:
 * undefined`) but in the stream options: `options.headers` (with
 * `Authorization: Bearer <apiKey>` already merged in when `authHeader: true`)
 * and `options.apiKey` (pi-coding-agent 0.68.1 `sdk.js` streamFn →
 * `getApiKeyAndHeaders`). Both streams sent only `model.headers`, so any key or
 * header written to models.json for `llamacpp-stream` / `mlx-stream` was
 * silently dropped on the wire (devices-tailscale §2.2, DEV-2).
 *
 * Built the way pi's own openai-completions provider builds them: the model's
 * headers, then the option headers over them (same name, any case, is
 * replaced — never sent twice, which fetch would join into "a, b"), then
 * `Authorization: Bearer <apiKey>` unless a header already authorizes.
 *
 * NOTHING CHANGES WHEN THERE IS NOTHING TO SEND: with no option headers and no
 * real key, the result is exactly `{ 'content-type': 'application/json',
 * ...model.headers }`, the object the streams sent before. The app writes
 * `apiKey: "none"` into every models.json block it owns (pi requires the
 * field; the local servers need no key), and that placeholder is not a key.
 */
import type { Api, Model, StreamOptions } from '@mariozechner/pi-ai';

/** The key the app writes for "this server needs none" (models-json.ts, afm-main.ts, role-agent.ts). */
export const NO_API_KEY = 'none';

/** A key worth sending: present, not blank, not the app's `none` placeholder. */
export function isRealApiKey(key: string | undefined): key is string {
  if (typeof key !== 'string') return false;
  const k = key.trim();
  return k !== '' && k.toLowerCase() !== NO_API_KEY;
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/** Set `extra` over `base`, replacing a same-named header whatever its case. */
function mergeHeaders(
  base: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value !== 'string') continue;
    const lower = name.toLowerCase();
    for (const k of Object.keys(out)) if (k.toLowerCase() === lower) delete out[k];
    out[name] = value;
  }
  return out;
}

/** The headers for a JSON POST to the model server. */
export function buildRequestHeaders(
  model: Pick<Model<Api>, 'headers'>,
  options?: Pick<StreamOptions, 'headers' | 'apiKey'>,
): Record<string, string> {
  let headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(model.headers ?? {}),
  };
  if (options?.headers !== undefined && Object.keys(options.headers).length > 0) {
    headers = mergeHeaders(headers, options.headers);
  }
  const key = options?.apiKey;
  if (isRealApiKey(key) && !hasHeader(headers, 'authorization')) {
    headers = { ...headers, Authorization: `Bearer ${key.trim()}` };
  }
  return headers;
}
