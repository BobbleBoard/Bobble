import { describe, expect, it } from 'vitest';
import { reportedWritePath } from './reported-path';

describe('reportedWritePath', () => {
  it('reads the absolute path pi names', () => {
    expect(reportedWritePath('Successfully wrote 12 bytes to /w/hi-8/x.md')).toBe('/w/hi-8/x.md');
    expect(reportedWritePath('Successfully replaced 2 block(s) in /w/app.py.')).toBe('/w/app.py');
  });

  it('reads the workspace-relative path the harness says since 2026-09-17', () => {
    expect(reportedWritePath('Successfully wrote 88 bytes to sample.svg')).toBe('sample.svg');
    expect(reportedWritePath('Successfully replaced 1 block(s) in src/app.ts.\n(a note)')).toBe(
      'src/app.ts',
    );
  });

  it('keeps a dotted name whole', () => {
    expect(reportedWritePath('Successfully wrote 1 bytes to notes.v2.md')).toBe('notes.v2.md');
  });

  it('is nothing for any other text', () => {
    expect(reportedWritePath('Not written: sample.svg is hand-written SVG')).toBeUndefined();
  });
});
