import { describe, expect, it } from 'vitest';
import { capText, contextLabel, fenceFor, type QuickContext, replacementText } from './context';

const PNG = 'data:image/png;base64,AAAA';

const win: QuickContext = {
  kind: 'window',
  id: 'w',
  app: 'TextEdit',
  title: 'Notes.txt',
  image: PNG,
  width: 1200,
  height: 800,
};
const selection: QuickContext = {
  kind: 'selection',
  id: 's',
  app: 'Mail',
  text: 'teh quick brwon fox',
  editable: true,
};

/* How the message is assembled and folded is tested where it is folded, with
   the chat composer's own fold: src/quick/compose.test.ts. */

describe('helpers', () => {
  it('a fence outlasts any backticks inside the text', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('has ``` inside')).toBe('````');
    expect(fenceFor('has ````` five')).toBe('``````');
  });

  it('capText leaves short text alone', () => {
    expect(capText('abc', 10)).toBe('abc');
  });

  it('labels chips in plain words', () => {
    expect(contextLabel(win)).toBe('TextEdit · Notes.txt');
    expect(contextLabel(selection)).toBe('“teh quick brwon fox”');
    expect(
      contextLabel({
        ...selection,
        text: 'one two three four five six seven eight nine',
      } as QuickContext),
    ).toBe('“one two three four five six seven…”');
    expect(contextLabel({ kind: 'files', id: 'f', paths: ['/a/b/report.pdf'] })).toBe('report.pdf');
    expect(contextLabel({ kind: 'app', id: 'a', app: 'Notes', pid: 1 })).toBe('Use Notes');
  });

  it('replacementText strips one wrapping fence or one pair of quotes, nothing else', () => {
    expect(replacementText('```\nThe quick brown fox\n```')).toBe('The quick brown fox');
    expect(replacementText('“The quick brown fox”')).toBe('The quick brown fox');
    expect(replacementText('"Hi" she said')).toBe('"Hi" she said');
    expect(replacementText('  plain text \n')).toBe('plain text');
  });
});
