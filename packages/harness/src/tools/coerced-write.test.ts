import { describe, expect, it } from 'vitest';
import {
  coercedEditRefusal,
  coercedWriteRefusal,
  isCoercedEdit,
  isCoercedToolCall,
} from './coerced-write';

const CHROME = 'Google Chrome';

describe('a write that is really a tool call', () => {
  /* The four the 4B actually emitted in matrix run 1. */
  it('catches the ones measured in the matrix', () => {
    expect(isCoercedToolCall('read the URL of Google Chrome\n', CHROME)).toBe(true);
    expect(isCoercedToolCall('read the current state of Google Chrome\n', CHROME)).toBe(true);
  });

  it('catches one that says "the page" instead of naming the app', () => {
    expect(isCoercedToolCall('click the storage option on the page', CHROME)).toBe(true);
  });

  /* A model driving an app may still have a real file to write, and destroying
     that would be far worse than letting a silly note through. */
  it('leaves real files alone', () => {
    for (const body of [
      '# Configure Apple Product\n\n| step | note |\n| --- | --- |',
      'def main():\n    return 1',
      'const x = 1;',
      'Chrome kept returning 404 on the storage endpoint, so I switched to the DOM path instead and recorded the element indices below for the next attempt.',
      '{"tab": 1}',
    ]) {
      expect(isCoercedToolCall(body, CHROME), body.slice(0, 30)).toBe(false);
    }
  });

  it('does nothing when no app is being driven', () => {
    expect(isCoercedToolCall('read the URL of Google Chrome', null)).toBe(false);
  });

  it('needs the content to be ABOUT the app, not merely short', () => {
    expect(isCoercedToolCall('read the notes', CHROME)).toBe(false);
  });

  it('quotes the model its own sentence back, with the command that does it', () => {
    const r = coercedWriteRefusal(
      'read the URL of Google Chrome\n',
      CHROME,
      '`mac chrome snapshot`',
    );
    expect(r).toContain('"read the URL of Google Chrome"');
    expect(r).toContain('mac chrome snapshot');
  });
});

describe('the same mistake wearing edit', () => {
  /* The one the 4B made 73 times in matrix run 4. */
  it('catches "File Apple Maps"', () => {
    expect(isCoercedEdit('File Apple Maps', 'Maps')).toBe(true);
  });

  it('leaves real edit targets alone', () => {
    for (const p of ['src/index.ts', './README.md', 'Makefile', '/tmp/notes.txt', 'package.json']) {
      expect(isCoercedEdit(p, 'Maps'), p).toBe(false);
    }
  });

  it('does nothing when no app is being driven', () => {
    expect(isCoercedEdit('File Apple Maps', null)).toBe(false);
  });

  it('names the typing the model was actually asking for', () => {
    const r = coercedEditRefusal('Colosseum, Rome', 'Apple Maps', 'Maps', '`mac snapshot`');
    expect(r).toContain('"Colosseum, Rome"');
    expect(r).toContain('"Apple Maps"');
    expect(r).toContain('mac snapshot');
  });
});
