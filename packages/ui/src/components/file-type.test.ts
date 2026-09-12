import { describe, expect, it } from 'vitest';
import { extensionOf, fileTypeOf } from './file-type.ts';

describe('fileTypeOf', () => {
  it('tells the office families apart by colour and word', () => {
    expect(fileTypeOf('/a/q3-review.pptx')).toMatchObject({ family: 'slides', label: 'Slides' });
    expect(fileTypeOf('report.DOCX').family).toBe('document');
    expect(fileTypeOf('budget.xlsx').family).toBe('sheet');
    expect(fileTypeOf('brief.pdf').family).toBe('pdf');
    const colours = new Set(
      ['a.pptx', 'a.docx', 'a.xlsx', 'a.pdf', 'a.png', 'a.mp4', 'a.mp3', 'a.html', 'a.py'].map(
        (p) => fileTypeOf(p).color,
      ),
    );
    expect(colours.size).toBe(9);
  });
  it('treats a name without an extension as a folder', () => {
    expect(fileTypeOf('/a/game').family).toBe('folder');
    expect(fileTypeOf('/a/game.txt', { folder: true }).family).toBe('folder');
  });
  it('falls back to the plain file for an unknown extension', () => {
    expect(fileTypeOf('thing.xyz')).toMatchObject({ family: 'file', label: 'File' });
    expect(extensionOf('/a/.gitignore')).toBe('');
  });
  it('never paints purple', () => {
    for (const p of [
      'a.pptx',
      'a.docx',
      'a.xlsx',
      'a.pdf',
      'a.png',
      'a.svg',
      'a.mp4',
      'a.mp3',
      'a.html',
      'a.py',
      'a.md',
      'a.glb',
      'a.zip',
      'dir',
      'a.xyz',
    ]) {
      const hex = fileTypeOf(p).color.slice(1);
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      // Purple: red and blue both well above green.
      expect(r > g + 40 && b > g + 40).toBe(false);
    }
  });
});
