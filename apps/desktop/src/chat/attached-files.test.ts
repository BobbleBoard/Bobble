import { describe, expect, it } from 'vitest';
import { messageSummary, splitAttachedFiles } from './attached-files';
import { buildAgentMessage } from './composer/agent-message';

describe('splitAttachedFiles', () => {
  it('round-trips what buildAgentMessage folds in', () => {
    const body = buildAgentMessage('what do you make of this?', [
      { name: 'pasted content', text: 'line one\nline two' },
    ]);
    expect(splitAttachedFiles(body)).toEqual({
      files: [{ id: '0:pasted content', name: 'pasted content', text: 'line one\nline two' }],
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
    expect(splitAttachedFiles(body)).toEqual({ files: [], text: body });
  });

  it('keeps a pasted snippet that itself contains a fence', () => {
    const inner = 'before\n```\ninner\n```\nafter';
    const body = buildAgentMessage('look', [{ name: 'pasted content', text: inner }]);
    expect(splitAttachedFiles(body).files[0]?.text).toBe(inner);
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
});
