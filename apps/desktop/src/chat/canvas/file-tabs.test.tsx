// @vitest-environment jsdom
/**
 * A file you click must SHOW you something.
 *
 * the user, on a report a subagent wrote and handed back: "it just shows up blank in
 * the canvas sidebar… it was unable to be read or clicked on or viewed by me."
 * The write parsed, the +N line counter climbed, and the tab opened empty —
 * because a failed read set no artifact at all. A blank pane is the worst answer
 * available: it reads as an empty FILE, so you go hunting for a bug in whatever
 * wrote it instead of looking at the path.
 */
import { describe, expect, it } from 'vitest';
import { fileArtifact, unreadableFileArtifact } from './file-tabs';

describe('unreadableFileArtifact', () => {
  const art = unreadableFileArtifact('/Users/user/bobble-testbed/run/report.md');

  it('says it could not read the file, rather than showing nothing', () => {
    expect(art.content.kind).toBe('text');
    expect((art.content as { text: string }).text).toContain('Could not read this file');
  });

  it('names the PATH it actually tried — "not found" is useless without it', () => {
    expect((art.content as { text: string }).text).toContain(
      '/Users/user/bobble-testbed/run/report.md',
    );
  });

  it('titles the tab with the filename, like any other file tab', () => {
    expect(art.title).toBe('report.md');
    expect(art.filename).toBe('report.md');
  });

  it('does not claim the file was empty or that anything was lost', () => {
    const text = (art.content as { text: string }).text.toLowerCase();
    expect(text).not.toContain('empty file');
    expect(text).toContain('nothing has been lost');
  });

  it('shares the tab identity of the real artifact, so it REPLACES cleanly', () => {
    // Same id as a successful read of the same path — when the file appears, the
    // explanation is replaced rather than accumulating a second tab.
    const ok = fileArtifact('/Users/user/bobble-testbed/run/report.md', {
      text: '# hi',
      binary: false,
      tooLarge: false,
      bytes: 4,
    } as never);
    expect(art.id).toBe(ok.id);
  });
});
