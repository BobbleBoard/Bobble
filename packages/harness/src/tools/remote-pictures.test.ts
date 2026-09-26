import { describe, expect, it } from 'vitest';
import { remotePictures, remotePicturesNote, unseenPictures } from './remote-pictures';

const PAGE = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Lato&amp;display=swap" rel="stylesheet">
<style>
  @font-face { font-family: X; src: url("https://fonts.gstatic.com/x.woff2"); }
  .hero { background: linear-gradient(#0008,#0008), url('https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=1920&q=80') center/cover; }
  .band { background-image: url(assets/band.png); }
</style></head><body>
<img src="https://images.unsplash.com/photo-1595210184705-4e01207793a7?w=600&amp;q=80" alt="vase">
<img src="assets/cup.png" alt="cup">
<picture><source srcset="https://cdn.example.com/a.webp 1x, https://cdn.example.com/a@2x.webp 2x"></picture>
<video poster="https://cdn.example.com/p.jpg"></video>
<a href="https://example.com/page">a link is not a picture</a>
</body></html>`;

describe('pictures a page loads from the web', () => {
  it('finds <img>, srcset, poster and CSS backgrounds — not fonts, links or local files', () => {
    expect(remotePictures(PAGE).sort()).toEqual(
      [
        'https://cdn.example.com/a.webp',
        'https://cdn.example.com/a@2x.webp',
        'https://cdn.example.com/p.jpg',
        'https://images.unsplash.com/photo-1595210184705-4e01207793a7?w=600&q=80',
        'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=1920&q=80',
      ].sort(),
    );
  });

  it('a picture the chat gave the model is seen; one typed from memory is not', () => {
    const pics = remotePictures(PAGE);
    // The user pasted one (without its query); a search returned another.
    const seen =
      'use this photo: https://images.unsplash.com/photo-1610701596007-11502861dcfa\n' +
      'web search result: https://cdn.example.com/p.jpg';
    const unseen = unseenPictures(pics, seen);
    expect(unseen).toHaveLength(3);
    expect(unseen.some((u) => u.includes('1610701596007'))).toBe(false);
    const note = remotePicturesNote(unseen);
    expect(note).toContain('3 pictures load from images.unsplash.com, cdn.example.com');
    expect(note).toContain('nothing in this chat gave you');
    expect(note).toContain('generate_image');
    expect(remotePicturesNote([])).toBe('');
  });
});
