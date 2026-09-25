/**
 * What a pasted path is, a file for pixels that never had one, and the one
 * picture at a time the viewer may show from outside the app's folders.
 * Every test runs in a home of its own — nothing here may write ~/Bobble.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FOLDER_COUNT_CAP } from './attachments-contract';
import { inspectPaths, isHandedFile, openForViewing, saveImage } from './attachments-main';

/** A 1×1 PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

let home: string;
let desk: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pd-attach-test-'));
  desk = path.join(home, 'Desktop');
  mkdirSync(desk, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('inspectPaths', () => {
  it('tells a folder from a file, with a size or an item count', () => {
    const folder = path.join(desk, 'garden');
    mkdirSync(path.join(folder, 'src'), { recursive: true });
    writeFileSync(path.join(folder, 'README.md'), '# hi');
    writeFileSync(path.join(folder, '.DS_Store'), 'x');
    const pdf = path.join(desk, 'Q3 report.pdf');
    writeFileSync(pdf, 'x'.repeat(2048));
    expect(inspectPaths([folder, pdf])).toEqual([
      // Hidden entries are not items a person would count.
      { path: folder, name: 'garden', kind: 'folder', entries: 2 },
      { path: pdf, name: 'Q3 report.pdf', kind: 'file', bytes: 2048 },
    ]);
  });

  it('stops counting a huge folder at the cap', () => {
    const big = path.join(desk, 'big');
    mkdirSync(big);
    for (let i = 0; i < FOLDER_COUNT_CAP + 5; i++) writeFileSync(path.join(big, `f${i}`), '');
    expect(inspectPaths([big])[0]?.entries).toBe(FOLDER_COUNT_CAP);
  });

  it('calls a path that is not there, or not absolute, missing', () => {
    expect(inspectPaths([path.join(desk, 'gone.pdf'), 'relative/x.pdf'])).toEqual([
      { path: path.join(desk, 'gone.pdf'), name: 'gone.pdf', kind: 'missing' },
      { path: 'relative/x.pdf', name: 'x.pdf', kind: 'missing' },
    ]);
  });
});

describe('saveImage', () => {
  it('writes pixels once, into ~/Bobble/attachments, named by their content', () => {
    const first = saveImage(PNG_URL, home);
    const again = saveImage(PNG_URL, home);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.path).toBe(again.path);
    expect(path.dirname(first.path)).toBe(path.join(home, 'Bobble', 'attachments'));
    expect(path.basename(first.path)).toMatch(/^image-[0-9a-f]{12}\.png$/);
    // The same picture is one file — and no temp file is left beside it.
    expect(readdirSync(path.join(home, 'Bobble', 'attachments'))).toEqual([
      path.basename(first.path),
    ]);
    expect(first.bytes).toBe(Buffer.from(PNG_B64, 'base64').length);
  });

  it('gives a different picture a different file', () => {
    const other = `data:image/jpeg;base64,${Buffer.from('not the same bytes').toString('base64')}`;
    const a = saveImage(PNG_URL, home);
    const b = saveImage(other, home);
    expect(a.ok && b.ok && a.path !== b.path).toBe(true);
    if (b.ok) expect(b.path.endsWith('.jpg')).toBe(true);
  });

  it('refuses what is not a picture', () => {
    expect(saveImage('data:text/plain;base64,aGk=', home).ok).toBe(false);
    expect(saveImage('data:image/png,not-base64', home).ok).toBe(false);
    expect(saveImage('https://example.com/x.png', home).ok).toBe(false);
    expect(saveImage('data:image/png;base64,', home).ok).toBe(false);
  });
});

describe('openForViewing', () => {
  it("opens a picture's own file, and hands that one file to pd-file://", () => {
    const fox = path.join(desk, 'fox.png');
    writeFileSync(fox, Buffer.from(PNG_B64, 'base64'));
    const other = path.join(desk, 'other.png');
    writeFileSync(other, Buffer.from(PNG_B64, 'base64'));
    expect(isHandedFile(realpathSync(fox))).toBe(false);
    expect(openForViewing({ path: fox }, home)).toEqual({ ok: true, path: fox });
    expect(isHandedFile(realpathSync(fox))).toBe(true);
    // Only the file opened — not its neighbours, not its folder.
    expect(isHandedFile(realpathSync(other))).toBe(false);
    expect(isHandedFile(realpathSync(desk))).toBe(false);
  });

  it('never hands over something that is not a picture', () => {
    const notes = path.join(desk, 'secrets.txt');
    writeFileSync(notes, 'hunter2');
    expect(openForViewing({ path: notes }, home).ok).toBe(false);
    expect(isHandedFile(realpathSync(notes))).toBe(false);
  });

  it('falls back to the pixels when the file has gone', () => {
    const gone = path.join(desk, 'moved.png');
    const res = openForViewing({ path: gone, dataUrl: PNG_URL }, home);
    expect(res.ok).toBe(true);
    expect(res.path?.startsWith(path.join(home, 'Bobble', 'attachments'))).toBe(true);
  });

  it('saves an old message’s pixels, once however many times it is opened', () => {
    const a = openForViewing({ dataUrl: PNG_URL }, home);
    const b = openForViewing({ dataUrl: PNG_URL }, home);
    expect(a).toEqual(b);
    expect(readdirSync(path.join(home, 'Bobble', 'attachments'))).toHaveLength(1);
  });

  it('says so when there is nothing to open', () => {
    expect(openForViewing({}, home)).toEqual({
      ok: false,
      error: 'the picture is not on disk any more',
    });
  });
});
