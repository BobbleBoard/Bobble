/**
 * The conversation titler's parse: a small model handing the instruction's own
 * words back is no title.
 */
import { describe, expect, it } from 'vitest';
import { parseTitle } from './conversation-title';

describe('parseTitle', () => {
  it('takes the title out of the JSON, prose around it or not', () => {
    expect(parseTitle('{"title": "Echo command output"}')).toBe('Echo command output');
    expect(parseTitle('Sure: {"title":"Lighthouse story"} there')).toBe('Lighthouse story');
  });

  it('rejects a title that names nothing', () => {
    // SEEN 2026-09-13 (MiniCPM5 2B): the sidebar read "Conversation Title".
    for (const t of [
      'Conversation Title',
      'conversation title.',
      'Title',
      'Chat',
      'New chat',
      'Untitled',
      "<3-6 words: the user's topic or task>",
      "the user's topic or task",
      'A 3-6 word title',
      '',
    ]) {
      expect(parseTitle(JSON.stringify({ title: t })), t).toBeUndefined();
    }
  });

  it('keeps a real title that merely contains one of those words', () => {
    expect(parseTitle('{"title":"Chat app login bug"}')).toBe('Chat app login bug');
    expect(parseTitle('{"title":"Title case in headings"}')).toBe('Title case in headings');
  });
});
