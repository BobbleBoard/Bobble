import { describe, expect, it } from 'vitest';
import { clipboardEpoch, markSystemClipboard } from './clipboard-epoch';
import { pastedFiles } from './paste-files';

const png = { name: 'image.png' };

describe('pastedFiles', () => {
  it('attaches a picture that came with no text at all — a card Copy, a screenshot', () => {
    expect(pastedFiles([png], '', '')).toEqual([png]);
    expect(pastedFiles([png], '  \n', '')).toEqual([png]);
  });

  it('pastes text when there are no files', () => {
    expect(pastedFiles([], 'hello', '<b>hello</b>')).toEqual([]);
  });

  it('attaches files copied in Finder, whose text is only their own names', () => {
    const a = { name: 'fox.png' };
    const b = { name: 'notes.txt' };
    expect(pastedFiles([a], 'fox.png', '')).toEqual([a]);
    expect(pastedFiles([a, b], 'fox.png\rnotes.txt', '')).toEqual([a, b]);
    // A path whose last segment is the file is the same file.
    expect(pastedFiles([a], '/Users/j/Desktop/fox.png', '')).toEqual([a]);
  });

  it("attaches a browser's Copy Image, whose markup is a picture and nothing else", () => {
    const html = '<meta charset="utf-8"><img src="https://example.com/fox.png" alt="">';
    expect(pastedFiles([png], 'https://example.com/fox.png', html)).toEqual([png]);
  });

  /*
   * THE TRAP: Numbers, Excel, Pages and Word put a PICTURE of what you copied
   * beside the text, for apps that cannot take text. Attaching it would paste a
   * screenshot of a spreadsheet instead of its numbers.
   */
  it('keeps real text as the content when a rendering of it rides along', () => {
    const html = '<table><tr><td>12</td><td>40</td></tr></table>';
    expect(pastedFiles([png], '12\t40', html)).toEqual([]);
    expect(pastedFiles([png], 'A paragraph of prose.', '<p>A paragraph of prose.</p>')).toEqual([]);
  });

  it('does not mistake markup with words in it for a bare picture', () => {
    const html = '<p>Look at this <img src="x.png"> fox</p>';
    expect(pastedFiles([png], 'Look at this fox', html)).toEqual([]);
  });

  /*
   * A FINDER COPY OF FOLDERS AND FILES TOGETHER (2026-09-24): a folder is a
   * File like the rest (paste-files.ts header), and Finder's text is the names
   * as it SHOWS them — without an extension it has been told to hide.
   */
  it('attaches folders and files copied together in Finder', () => {
    const folder = { name: 'garden-project' };
    const pdf = { name: 'Q3 report.pdf' };
    expect(pastedFiles([folder, pdf], 'garden-project\rQ3 report.pdf', '')).toEqual([folder, pdf]);
  });

  it('knows a file by the name Finder shows when its extension is hidden', () => {
    const pdf = { name: 'Q3 report.pdf' };
    expect(pastedFiles([pdf], 'Q3 report', '')).toEqual([pdf]);
  });

  it('never reads the word "image" beside pasted pixels as their name', () => {
    // The trap again: words, with a rendering of them — the words win.
    expect(pastedFiles([png], 'image', '<p>image</p>')).toEqual([]);
  });
});

describe('clipboard epoch', () => {
  it('advances on every system clipboard write, so an older in-app copy stops winning', () => {
    const before = clipboardEpoch();
    markSystemClipboard();
    expect(clipboardEpoch()).toBe(before + 1);
  });
});
