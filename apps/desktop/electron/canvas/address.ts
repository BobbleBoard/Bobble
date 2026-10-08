/**
 * WHAT THE ADDRESS BAR MEANS — a page to open, or something to look up.
 *
 * the user (2026-10-08): "searching in the search bar should google something not
 * show https://<typed thing>". Every entry without a scheme had `https://` put
 * in front of it, so "best pizza near me" went to `https://best pizza near me`
 * and "cats" to `https://cats`. And `localhost:3000` read as a URL whose scheme
 * is `localhost:` and went nowhere.
 *
 * The rule a browser's omnibox uses, in short:
 *  - a URL with its scheme (`https://…`, `file:///…`, `about:blank`) opens as is;
 *  - something that looks like an address — a host with a dot (`example.com`,
 *    `docs.rs/serde`), `localhost`, an IP, or any of those with a port — opens
 *    with a scheme: http for this machine and bare IPs, https otherwise;
 *  - anything else — words with spaces, one word with no dot — is a search.
 */

/** Where a search goes. */
export const SEARCH_URL = 'https://www.google.com/search?q=';

/** Schemes that are a page, typed in full. Anything else with a colon is not a scheme here. */
const KNOWN_SCHEME = /^(https?|file|about|data|blob|view-source|chrome|devtools|pd-[a-z-]+):/i;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:]+\]$/i;

export function addressToUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  if (KNOWN_SCHEME.test(value)) return value;
  // Words with spaces are never an address.
  if (/\s/.test(value)) return search(value);
  // Split the host (with any port) from a path, query or fragment.
  const hostPart = value.split(/[/?#]/, 1)[0] ?? '';
  const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(hostPart);
  const host = (portMatch?.[1] ?? hostPart).toLowerCase();
  const local =
    host === 'localhost' || host.endsWith('.localhost') || IPV4.test(host) || IPV6.test(host);
  if (local) return `http://${value}`;
  // A host: labels joined by dots, ending in a letter-only top-level label of 2+.
  if (/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) return `https://${value}`;
  return search(value);
}

function search(q: string): string {
  return `${SEARCH_URL}${encodeURIComponent(q)}`;
}
