import { describe, expect, it } from 'vitest';
import { instructionsPreamble, messageSummary, splitAttachedFiles } from './attached-files';
import { buildAgentMessage } from './composer/agent-message';

describe('splitAttachedFiles', () => {
  it('round-trips what buildAgentMessage folds in', () => {
    const body = buildAgentMessage('what do you make of this?', [
      { name: 'pasted content', text: 'line one\nline two' },
    ]);
    expect(splitAttachedFiles(body)).toEqual({
      files: [{ id: '0:pasted content', name: 'pasted content', text: 'line one\nline two' }],
      refs: [],
      images: [],
      text: 'what do you make of this?',
    });
  });

  it('handles several attachments and no typed text', () => {
    const body = buildAgentMessage('', [
      { name: 'a.md', text: '# a' },
      { name: 'b.md', text: '# b' },
    ]);
    const out = splitAttachedFiles(body);
    expect(out.files.map((f) => f.name)).toEqual(['a.md', 'b.md']);
    expect(out.text).toBe('');
  });

  it('leaves an ordinary message — including one with a code fence — alone', () => {
    const body = 'here is some code:\n```\nconst a = 1;\n```';
    expect(splitAttachedFiles(body)).toEqual({ files: [], refs: [], images: [], text: body });
  });

  it('keeps a pasted snippet that itself contains a fence', () => {
    const inner = 'before\n```\ninner\n```\nafter';
    const body = buildAgentMessage('look', [{ name: 'pasted content', text: inner }]);
    expect(splitAttachedFiles(body).files[0]?.text).toBe(inner);
  });
});

/*
 * THE PATH LINES COME BACK OUT (2026-09-24): a picture, a PDF, a folder reach
 * the model as `Attached …: /path` lines, and a reopened chat draws them as
 * cards again — the picture's line becomes the file its thumbnail opens.
 */
describe('splitAttachedFiles — everything named by path', () => {
  const PDF = {
    kind: 'file' as const,
    name: 'Q3 report.pdf',
    path: '/Users/j/Desktop/Q3 report.pdf',
    bytes: 2_411_724,
  };
  const FOLDER = {
    kind: 'folder' as const,
    name: 'drafts (old)',
    path: '/Users/j/Desktop/drafts (old)',
  };
  const FOX = { kind: 'image' as const, name: 'fox.png', path: '/Users/j/fox (1).png', bytes: 900 };
  const SHOT = {
    kind: 'image' as const,
    name: 'image.png',
    path: '/Users/j/Bobble/attachments/image-3f9a0c1b2d4e.png',
    bytes: 36_000,
  };
  const NOTES = {
    kind: 'text' as const,
    name: 'notes.md',
    path: '/Users/j/notes.md',
    text: '# hi',
  };

  it('round-trips every kind, in order, with what was typed', () => {
    const body = buildAgentMessage('what first?', [FOX, NOTES, PDF, FOLDER, SHOT]);
    const out = splitAttachedFiles(body);
    expect(out.text).toBe('what first?');
    expect(out.images.map((i) => i.path)).toEqual([FOX.path, SHOT.path]);
    expect(out.refs.map((r) => [r.kind, r.path, r.name, r.detail])).toEqual([
      ['file', PDF.path, 'Q3 report.pdf', 'PDF, 2.3 MB'],
      // A folder's name may end in brackets: its line never carries a description.
      ['folder', FOLDER.path, 'drafts (old)', undefined],
    ]);
    expect(out.files).toEqual([
      { id: '0:notes.md', name: 'notes.md', text: '# hi', path: '/Users/j/notes.md' },
    ]);
  });

  it('reads a picture whose name has brackets of its own', () => {
    const out = splitAttachedFiles(buildAgentMessage('', [FOX]));
    expect(out.images[0]).toMatchObject({ path: '/Users/j/fox (1).png', detail: 'PNG, 900 B' });
    expect(out.text).toBe('');
  });

  it('rebuilds the same body from what it read back (an edit keeps its words)', () => {
    const body = buildAgentMessage('go', [PDF, FOLDER, NOTES]);
    const { refs, files, text } = splitAttachedFiles(body);
    expect(
      buildAgentMessage(text, [
        ...refs.map((r) => ({ ...r, ...(r.detail !== undefined ? { detail: r.detail } : {}) })),
        ...files.map((f) => ({ ...f, kind: 'text' as const })),
      ]),
    ).toBe(body);
  });

  it('leaves prose that merely starts like a line alone', () => {
    for (const body of [
      'Attached file: see the one I sent yesterday',
      'Attached folder: the usual one',
      'Attached image: no path here (PNG)',
    ]) {
      expect(splitAttachedFiles(body)).toEqual({ files: [], refs: [], images: [], text: body });
    }
  });

  /*
   * The first message of a chat carries the saved custom instructions ahead of
   * everything (pi-connect). The live bubble never showed them; a rebuilt one
   * must not either, and they must not hide the attachments behind them.
   */
  it('reads past the custom-instructions preamble the first message carries', () => {
    const body = `${instructionsPreamble('Prefer metric units.\nBe brief.')}${buildAgentMessage(
      'how wide?',
      [PDF],
    )}`;
    const out = splitAttachedFiles(body);
    expect(out.refs.map((r) => r.path)).toEqual([PDF.path]);
    expect(out.text).toBe('how wide?');
    expect(messageSummary(body)).toBe('how wide?');
  });

  it('still reads a message from before paths', () => {
    const body = 'Attached file `notes.md`:\n```\n# hi\n```\n\nsummarise';
    expect(splitAttachedFiles(body)).toEqual({
      files: [{ id: '0:notes.md', name: 'notes.md', text: '# hi' }],
      refs: [],
      images: [],
      text: 'summarise',
    });
  });
});

describe('messageSummary', () => {
  /* His real chat was titled: Attached file `pasted content`: ``` we're going… */
  it('titles a chat by what was TYPED, not by the folded block', () => {
    const body = buildAgentMessage("we're going to work on the chat", [
      { name: 'pasted content', text: 'a long wall of text' },
    ]);
    expect(messageSummary(body)).toBe("we're going to work on the chat");
  });

  it('falls back to the attachment names when nothing was typed', () => {
    expect(messageSummary(buildAgentMessage('', [{ name: 'notes.md', text: '# hi' }]))).toBe(
      'notes.md',
    );
  });

  /* His was a bare paste, and "pasted content" is not a name for a chat. */
  it('summarises a bare paste by its own first line', () => {
    const body = buildAgentMessage('', [
      { name: 'pasted content', text: "\n\nwe're going to work on the chat\nand then some" },
    ]);
    expect(messageSummary(body)).toBe("we're going to work on the chat");
  });

  it('is the message itself when there are no attachments', () => {
    expect(messageSummary('how does spoofdpi work')).toBe('how does spoofdpi work');
  });

  /* SEEN in the sidebar: a chat titled "<user-instructions> Answer in …". */
  it('never titles a chat with the saved custom instructions', () => {
    expect(messageSummary(`${instructionsPreamble('Answer in plain sentences.')}hi there`)).toBe(
      'hi there',
    );
  });

  /* A title that is a path line would be the whole path, twice as long as the row. */
  it('titles by what was typed, never by a path line', () => {
    const body = buildAgentMessage('summarise this project', [
      { kind: 'folder', name: 'garden', path: '/Users/j/Desktop/garden' },
    ]);
    expect(messageSummary(body)).toBe('summarise this project');
  });

  it('names the chat after the files and folders when nothing was typed', () => {
    const body = buildAgentMessage('', [
      { kind: 'file', name: 'Q3 report.pdf', path: '/Users/j/Q3 report.pdf', bytes: 10 },
      { kind: 'folder', name: 'garden', path: '/Users/j/garden' },
      { kind: 'text', name: 'notes.md', path: '/Users/j/notes.md', text: '# hi' },
    ]);
    expect(messageSummary(body)).toBe('Q3 report.pdf, garden, notes.md');
  });

  it('names a picture by its file, or just "Image" when its name is a hash', () => {
    expect(
      messageSummary(
        buildAgentMessage('', [
          { kind: 'image', name: 'fox.png', path: '/Users/j/fox.png', bytes: 9 },
        ]),
      ),
    ).toBe('fox.png');
    const saved = (h: string) => ({
      kind: 'image' as const,
      name: 'image.png',
      path: `/Users/j/Bobble/attachments/image-${h}.png`,
      bytes: 9,
    });
    expect(messageSummary(buildAgentMessage('', [saved('3f9a0c1b2d4e')]))).toBe('Image');
    expect(
      messageSummary(buildAgentMessage('', [saved('3f9a0c1b2d4e'), saved('0123456789ab')])),
    ).toBe('2 images');
  });
});
