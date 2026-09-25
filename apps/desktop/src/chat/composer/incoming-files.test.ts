/**
 * WHAT A PASTE OR A DROP ATTACHES — the user (2026-09-24): "why not handle this
 * natively so that any image(s)/files/folders... can be pasted into the input
 * box". Every row of the table in incoming-files.ts, and the cases around it
 * that used to end in the "skipped" note.
 */
import { describe, expect, it } from 'vitest';
import { attachPlan, isImageFile, isTextFile, TEXT_MAX_BYTES } from './incoming-files';

const file = (name: string, type = '', size = 100) => ({ name, type, size });
const onDisk = (bytes: number) => ({ kind: 'file' as const, bytes });
const folder = { kind: 'folder' as const };
const gone = { kind: 'missing' as const };

describe('attachPlan — pixels with no file behind them', () => {
  it('saves a screenshot or a card Copy, so it has a path too', () => {
    expect(attachPlan(file('image.png', 'image/png'), '', null)).toEqual({
      as: 'image',
      save: true,
    });
  });

  it('folds a text blob that never was a file', () => {
    expect(attachPlan(file('snippet.txt', 'text/plain'), '', null)).toEqual({ as: 'text' });
  });

  it('skips anything else with nowhere on disk to point at', () => {
    expect(attachPlan(file('blob.bin', 'application/octet-stream'), '', null)).toEqual({
      as: 'skip',
    });
  });
});

describe('attachPlan — files and folders copied in Finder, or dropped', () => {
  const at = '/Users/j/Desktop';

  it('attaches a picture file by its own path, pixels and all', () => {
    expect(attachPlan(file('fox.png', 'image/png'), `${at}/fox.png`, onDisk(1200))).toEqual({
      as: 'image',
      save: false,
    });
  });

  it('knows a picture by its extension when the OS gave no MIME', () => {
    expect(attachPlan(file('IMG_0001.HEIC'), `${at}/IMG_0001.HEIC`, onDisk(1200))).toEqual({
      as: 'image',
      save: false,
    });
  });

  it('folds a small text file, as before', () => {
    expect(attachPlan(file('notes.md', 'text/markdown'), `${at}/notes.md`, onDisk(81))).toEqual({
      as: 'text',
    });
  });

  it('names a text file too big to fold by its path instead of skipping it', () => {
    const big = TEXT_MAX_BYTES + 1;
    expect(
      attachPlan(file('server.log', 'text/plain', big), `${at}/server.log`, onDisk(big)),
    ).toEqual({ as: 'file' });
  });

  it('names a PDF, a zip, a spreadsheet by path — the old "skipped" note', () => {
    for (const name of ['Q3 report.pdf', 'site.zip', 'budget.xlsx', 'talk.key', 'clip.mp4']) {
      expect(attachPlan(file(name, 'application/pdf'), `${at}/${name}`, onDisk(2_400_000))).toEqual(
        {
          as: 'file',
        },
      );
    }
  });

  /*
   * A FOLDER IS A FILE WITH NO TYPE AND A NAME THAT COULD BE ANYTHING — main's
   * stat is the only thing that tells it apart, and it has to win over the
   * name: a folder called `notes.md` or `photos.png` must never be read.
   */
  it('attaches a folder by path, whatever its name looks like', () => {
    expect(attachPlan(file('garden-project'), `${at}/garden-project`, folder)).toEqual({
      as: 'folder',
    });
    expect(attachPlan(file('photos.png'), `${at}/photos.png`, folder)).toEqual({ as: 'folder' });
    expect(attachPlan(file('site.md'), `${at}/site.md`, folder)).toEqual({ as: 'folder' });
  });

  it('skips a path that is not there any more (or that main never answered for)', () => {
    expect(attachPlan(file('gone.pdf'), `${at}/gone.pdf`, gone)).toEqual({ as: 'skip' });
    expect(attachPlan(file('gone.pdf'), `${at}/gone.pdf`, null)).toEqual({ as: 'skip' });
  });

  it("trusts the size on disk over the File's", () => {
    // A File for a path can report 0 before it is read; the stat is the truth.
    expect(
      attachPlan(file('huge.csv', 'text/csv', 0), `${at}/huge.csv`, onDisk(TEXT_MAX_BYTES * 4)),
    ).toEqual({ as: 'file' });
  });
});

describe('the kinds', () => {
  it('reads text by MIME or by extension', () => {
    expect(isTextFile(file('a.bin', 'text/plain'))).toBe(true);
    expect(isTextFile(file('config.yaml'))).toBe(true);
    expect(isTextFile(file('Makefile'))).toBe(true);
    expect(isTextFile(file('report.pdf', 'application/pdf'))).toBe(false);
  });

  it('reads a picture by MIME or by extension', () => {
    expect(isImageFile(file('image.png', 'image/png'))).toBe(true);
    expect(isImageFile(file('scan.TIFF'))).toBe(true);
    expect(isImageFile(file('drawing.svgz'))).toBe(false);
  });
});
