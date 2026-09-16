import { describe, expect, it } from 'vitest';
import { rawPageFetchRefusal, rawPageFetchUrl } from './raw-page-fetch.js';

describe('rawPageFetchUrl — a page read with curl', () => {
  it('catches the four lines the 4B wrote for the Eiffel Tower', () => {
    const url = 'https://en.wikipedia.org/wiki/Eiffel_Tower';
    expect(rawPageFetchUrl(`curl -s "${url}" | grep -A 5 -B 5 "height" | head -50`)).toBe(url);
    expect(
      rawPageFetchUrl(
        `curl -s "${url}" -o /tmp/eiffel.html && grep -i "height" /tmp/eiffel.html | head -20`,
      ),
    ).toBe(url);
    expect(rawPageFetchUrl(`curl -s ${url}`)).toBe(url);
    expect(rawPageFetchUrl(`wget -qO- ${url} | sed -n '1,40p'`)).toBe(url);
  });

  it('lets a download through — that is a file, not a page', () => {
    expect(
      rawPageFetchUrl('curl -L -o model.gguf https://huggingface.co/x/y/resolve/main/model.gguf'),
    ).toBeNull();
    expect(rawPageFetchUrl('curl -O https://example.com/archive.zip')).toBeNull();
    expect(rawPageFetchUrl('wget -P downloads https://example.com/data.csv')).toBeNull();
    // Saved as HTML but never read in the line: still a download.
    expect(rawPageFetchUrl('curl -s https://example.com -o page.html')).toBeNull();
  });

  it('lets an API call through — JSON is what curl is for', () => {
    expect(
      rawPageFetchUrl(`curl -X POST https://api.example.com/v1/items -d '{"a":1}'`),
    ).toBeNull();
    expect(
      rawPageFetchUrl('curl -s https://api.github.com/repos/o/r/issues | python3 -m json.tool'),
    ).toBeNull();
    expect(rawPageFetchUrl('curl -s https://example.com/data.json')).toBeNull();
    expect(rawPageFetchUrl(`curl -H "Authorization: Bearer x" https://example.com/me`)).toBeNull();
  });

  it('ignores lines without curl or a URL', () => {
    expect(rawPageFetchUrl('grep -r height notes.txt')).toBeNull();
    expect(rawPageFetchUrl('curl --version')).toBeNull();
  });

  it('names the two commands in the refusal, in the mode the model uses', () => {
    const r = rawPageFetchRefusal('https://en.wikipedia.org/wiki/Eiffel_Tower', { cli: true });
    expect(r).toContain('web fetch https://en.wikipedia.org/wiki/Eiffel_Tower');
    expect(r).toContain('web search');
    expect(rawPageFetchRefusal('https://x.y', { cli: false })).toContain('web_fetch');
  });
});
