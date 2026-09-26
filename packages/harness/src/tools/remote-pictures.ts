/**
 * PICTURES A PAGE LOADS FROM ADDRESSES NOTHING GAVE THE MODEL.
 *
 * MEASURED (4B, the visual suite, a ceramics studio's landing page, twice —
 * the second time with a guideline saying not to): every picture was an
 * images.unsplash.com URL with a photo id recalled from training. The hero
 * came out a bathroom. A model cannot know what a remembered id shows, and a
 * line among the guidelines did not outweigh the habit.
 *
 * So the fact is stated where the model is looking — the preview of the page
 * it wrote: these pictures load from addresses no tool result and no message
 * in this chat gave it, so it has never seen them. No list of sites: a URL
 * the user pasted, or one a search returned, is seen; one the model typed from
 * memory is not, wherever it points.
 */

/** Every picture URL a page loads from the web: <img>, srcset, poster, CSS backgrounds. */
export function remotePictures(html: string): string[] {
  const found = new Set<string>();
  const add = (u: string | undefined): void => {
    const url = u?.trim().replace(/&amp;/g, '&');
    if (url !== undefined && /^https?:\/\//i.test(url)) found.add(url);
  };
  for (const m of html.matchAll(/<(?:img|source|video)\b[^>]*>/gi)) {
    const tag = m[0];
    add(/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
    add(/\bposter\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
    const set = /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    for (const part of set?.split(',') ?? []) add(part.trim().split(/\s+/)[0]);
  }
  // CSS backgrounds — not @font-face, whose url() is a font.
  const css = html.replace(/@font-face\s*\{[^}]*\}/gi, '');
  for (const m of css.matchAll(
    /background(?:-image)?\s*:[^;"}]*?url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  )) {
    add(m[1]);
  }
  return [...found];
}

/** Those of `urls` that appear nowhere in `seen` (the chat's messages and tool results). */
export function unseenPictures(urls: readonly string[], seen: string): string[] {
  return urls.filter((u) => !seen.includes(u) && !seen.includes(u.split('?')[0] ?? u));
}

/** The line the preview carries, or '' when every picture was seen (or local). */
export function remotePicturesNote(unseen: readonly string[]): string {
  if (unseen.length === 0) return '';
  const hosts = [...new Set(unseen.map((u) => new URL(u).host))].join(', ');
  const n = unseen.length;
  return (
    `\n\nIts ${n === 1 ? 'picture loads' : `${n} pictures load`} from ${hosts}, at ` +
    `${n === 1 ? 'an address' : 'addresses'} nothing in this chat gave you — you have never ` +
    'seen what they show, and a photo id from memory shows whatever that photo happens to ' +
    'be. Look at each in the preview; better, make them with generate_image into the ' +
    "site's folder and point the page at the files."
  );
}
