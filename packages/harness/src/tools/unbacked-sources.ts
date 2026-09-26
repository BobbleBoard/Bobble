/**
 * SOURCES NOTHING IN THE CHAT BACKS, NAMED AT THE MOMENT THE FILE IS MADE.
 *
 * MEASURED (4B, the visual suite): asked for "a two-page brief … on where
 * solid-state batteries stand in 2026 … with sources", it searched nothing,
 * wrote the brief from memory — QuantumScape "a Carnegie Mellon spinoff" with
 * "its Texas facility" — and gave it a References section of five titles it
 * had made up ("QuantumScape Investor Relations", "Solid Power White Paper
 * 2026"). The reply then promised "a References section with source
 * citations". The office pipeline's own check (VQ-08, provenance.py) only
 * holds the pipeline to the brief; a brief the chat model invented passes.
 *
 * So the evidence is the chat itself: a source is backed when its link, or
 * its title, is in something the chat read — a search result, a fetched page,
 * a message from the person. The rest are named in the result, with what to do.
 */

const HEADING =
  /^\s*(?:#{1,6}\s*|\*\*)?(?:sources?|references?|bibliography|citations?|works cited|further reading)\b[^\n]{0,40}$/im;
const URL = /https?:\/\/[^\s)\]>"']+/g;

/** The entries of a brief's sources section, as written; empty when it has none. */
export function sourcesIn(brief: string): string[] {
  const m = HEADING.exec(brief);
  if (m === null) return [];
  const after = brief.slice(m.index + m[0].length);
  // Inline after the heading ("Sources: a; b"), or the lines below it until a blank line.
  const inline = m[0].includes(':') ? m[0].slice(m[0].indexOf(':') + 1).trim() : '';
  const lines = inline !== '' ? inline.split(/;\s*/) : after.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*(?:[-*•▪]|\d+[.)]|\[\d+\])\s*/, '').trim();
    if (line === '') {
      if (out.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(raw) || /^[A-Z][A-Z\s]{6,}$/.test(line)) break;
    out.push(line);
  }
  return out;
}

/** Is this source in what the chat read — by one of its links, or by its title? */
export function backed(source: string, chat: string): boolean {
  const links = source.match(URL) ?? [];
  if (links.some((u) => chat.includes(u.replace(/[.,;]+$/, '').replace(/\/$/, '')))) return true;
  const title = source
    .replace(URL, '')
    .replace(/[\s,;:–—-]+$/, '')
    .trim();
  return title.length >= 12 && chat.toLowerCase().includes(title.toLowerCase());
}

/** The note for a made file whose sources the chat does not back, or ''. */
export function unbackedSourcesNote(brief: string, chat: string): string {
  const loose = sourcesIn(brief).filter((s) => !backed(s, chat));
  if (loose.length === 0) return '';
  const named = loose
    .slice(0, 3)
    .map((s) => `"${s.length > 70 ? `${s.slice(0, 67)}…` : s}"`)
    .join(', ');
  const more = loose.length > 3 ? ` and ${loose.length - 3} more` : '';
  return (
    `Its sources — ${named}${more} — come from nothing read in this chat, and a source ` +
    'written from memory is usually made up. If the user asked for sources, search the web, ' +
    'read the pages, and make it again with those links in the brief; otherwise take the list ' +
    'out. Do not tell the user it is sourced until it is.'
  );
}
