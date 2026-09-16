/**
 * A WEB PAGE READ WITH curl WHILE `web fetch` IS ONE COMMAND AWAY.
 *
 * MEASURED on a 4B asked how tall the Eiffel Tower is: `curl -s
 * https://en.wikipedia.org/wiki/Eiffel_Tower | grep -A 5 -B 5 height` — four
 * times, each answered with kilobytes of `<meta>`, `<style>` and infobox
 * template markup on lines a screen wide. The height is in that page; the
 * model never saw it, the context filled with HTML, and the turn ran to its
 * twelve-minute cap without a reply. The same finding as handmade-office.ts,
 * one modality over: `curl` is what a model already knows how to type, and a
 * command list does not outweigh the habit.
 *
 * `web fetch <url>` returns the page as readable text — readability, then
 * markdown: the article, not the markup, size-capped. `web search "…"` finds
 * the page. This answers the reflex with those two commands.
 *
 * ## What makes this narrow enough to be safe
 * The test is the conjunction of:
 *   1. the line runs `curl` or `wget` against an http(s) URL, and
 *   2. it READS the response — prints it, pipes it into grep/sed/head/less/
 *      python, or greps a file it just saved — rather than downloading a file
 *      (`-o name.zip`, `-O`, `--output`, `--remote-name`) or calling an API
 *      (`-X POST`, `-d`, `--data`, `-H` … `Authorization`, a `.json` endpoint), and
 *   3. `web_fetch` is actually registered.
 *
 * A download goes through untouched: that is a file, not a page. An API call
 * goes through: JSON is what curl is for. A page saved to a file and then
 * grepped is a page read (the second form the model wrote), and is refused.
 */

const FETCH_CMD = /(?:^|[\s;&|(])(?:curl|wget)\s+([^\n;&|]*)/g;

function fetchesPage(args: string): boolean {
  if (!/https?:\/\/[^\s'"]+/i.test(args)) return false;
  // A download, not a read.
  if (
    /(?:^|\s)(?:-o\s+\S+|-O\b|--output(?:=|\s)\S+|--remote-name\b|-P\s|--directory-prefix)/.test(
      args,
    )
  ) {
    // …unless the saved file is then read as text (grep/cat/head on it) —
    // checked by the caller on the whole line.
    return false;
  }
  // An API call: a method, a body, an auth header, or a JSON endpoint.
  if (
    /(?:^|\s)(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\b|-d\s|--data\b|--json\b|-F\s|--form\b)/i.test(
      args,
    )
  ) {
    return false;
  }
  if (/-H\s*['"]?(?:Authorization|X-Api-Key|Content-Type:\s*application\/json)/i.test(args))
    return false;
  if (
    /https?:\/\/[^\s'"]+\.json(?:\?|$|\s)|https?:\/\/api\.|\/api\/|\/v\d+\/|\/graphql\b/i.test(args)
  ) {
    return false;
  }
  return true;
}

/** The URL of the page a command reads with curl/wget, or null. */
export function rawPageFetchUrl(command: string): string | null {
  const text = command.trim();
  // Piped into a JSON reader: an API response, whatever the URL looks like.
  if (/\|\s*(?:jq\b|python3?\s+-m\s+json\.tool)/.test(text)) return null;
  FETCH_CMD.lastIndex = 0;
  let m: RegExpExecArray | null = FETCH_CMD.exec(text);
  while (m !== null) {
    const args = m[1] ?? '';
    const url = /https?:\/\/[^\s'"]+/i.exec(args)?.[0];
    if (url !== undefined) {
      if (fetchesPage(args)) return url;
      // Saved to a file and then read in the same line: `curl … -o page.html
      // && grep -i height page.html` — a page read with a detour.
      const saved = /(?:-o|--output)[=\s]+(\S+\.html?)\b/i.exec(args)?.[1];
      if (
        saved !== undefined &&
        new RegExp(
          `\\b(?:grep|cat|head|sed|awk|less|python3?)\\b[^\\n]*${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ).test(text)
      ) {
        return url;
      }
    }
    m = FETCH_CMD.exec(text);
  }
  FETCH_CMD.lastIndex = 0;
  return null;
}

export function rawPageFetchRefusal(url: string, opts: { cli: boolean }): string {
  const fetch = opts.cli ? `web fetch ${url}` : `web_fetch with url ${url}`;
  const search = opts.cli ? 'web search "…"' : 'web_search';
  return (
    `Not run: curl returns that page as raw HTML — meta tags, styles and template markup that fill the context and hide the text (MEASURED: twelve minutes of grep on one Wikipedia page and no answer). ` +
    `Read it as text instead: \`${fetch}\` returns the article — title, headings, paragraphs, tables — as markdown, and \`${search}\` finds the page and its URL to cite. ` +
    `curl is for downloading a file (-o name) or calling an API, and those still run.`
  );
}
