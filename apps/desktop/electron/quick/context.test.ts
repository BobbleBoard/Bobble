import { describe, expect, it } from 'vitest';
import {
  assembleQuickMessage,
  capText,
  contextLabel,
  fenceFor,
  MAX_SELECTION_CHARS,
  type QuickContext,
  replacementText,
} from './context';

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

describe('assembleQuickMessage', () => {
  it('a plain question goes as typed, with nothing folded in', () => {
    const m = assembleQuickMessage({ text: '  what is 2+2?  ', contexts: [] });
    expect(m).toEqual({
      display: 'what is 2+2?',
      agentMessage: 'what is 2+2?',
      images: [],
      replacesSelection: false,
    });
  });

  it('nothing typed and nothing attached is nothing to send', () => {
    expect(assembleQuickMessage({ text: '   ', contexts: [] })).toBeNull();
  });

  it('a window picture is named to the model and sent as pixels', () => {
    const m = assembleQuickMessage({ text: 'what is wrong here?', contexts: [win] });
    expect(m?.images).toEqual([PNG]);
    expect(m?.agentMessage).toBe(
      'Attached: a screenshot of the TextEdit window “Notes.txt” (1200×800).\n\nwhat is wrong here?',
    );
    expect(m?.display).toBe('what is wrong here?');
  });

  it('a picture with no question asks what it shows', () => {
    const m = assembleQuickMessage({
      text: '',
      contexts: [{ kind: 'region', id: 'r', image: PNG, width: 640, height: 480 }],
    });
    expect(m?.display).toBe('What am I looking at? Point out what matters.');
    expect(m?.agentMessage).toMatch(
      /^Attached: a screenshot of an area of the screen the user selected \(640×480\)\./,
    );
  });

  it('selected text is fenced, named by its app, and an action becomes the request', () => {
    const m = assembleQuickMessage({ text: '', contexts: [selection], action: 'fix' });
    expect(m?.display).toBe('Fix the spelling and grammar');
    expect(m?.agentMessage).toBe(
      'Selected text in Mail:\n```\nteh quick brwon fox\n```\n\nFix the spelling and grammar and change nothing else. Reply with only the corrected text: no preamble, no quotes.',
    );
    expect(m?.replacesSelection).toBe(true);
  });

  it('translate names the language; explain does not replace', () => {
    const t = assembleQuickMessage({
      text: '',
      contexts: [selection],
      action: 'translate',
      language: 'French',
    });
    expect(t?.display).toBe('Translate the selection into French');
    expect(t?.agentMessage).toContain('Translate this into French.');
    expect(t?.replacesSelection).toBe(true);
    const e = assembleQuickMessage({ text: '', contexts: [selection], action: 'explain' });
    expect(e?.replacesSelection).toBe(false);
  });

  it('a selection from a field that takes no text back is never offered as replaceable', () => {
    const m = assembleQuickMessage({
      text: '',
      contexts: [{ ...selection, editable: false } as QuickContext],
      action: 'rewrite',
    });
    expect(m?.replacesSelection).toBe(false);
  });

  it('typed words ride along with an action', () => {
    const m = assembleQuickMessage({
      text: 'keep it short',
      contexts: [selection],
      action: 'rewrite',
    });
    expect(m?.display).toBe('keep it short');
    expect(m?.agentMessage).toMatch(
      /Reply with only the rewritten text: no preamble, no quotes\.\n\nAlso: keep it short$/,
    );
  });

  it('acting in an app needs words, and tells the model which app and pid', () => {
    const app: QuickContext = { kind: 'app', id: 'a', app: 'TextEdit', pid: 4242 };
    expect(assembleQuickMessage({ text: '', contexts: [app] })).toBeNull();
    const m = assembleQuickMessage({ text: 'make the title bold', contexts: [app] });
    expect(m?.agentMessage).toMatch(/^The user summoned Bobble while working in TextEdit/);
    expect(m?.agentMessage).toContain('mac_snapshot on the app “TextEdit”');
    expect(m?.agentMessage).toContain('pid 4242');
    expect(m?.agentMessage.endsWith('make the title bold')).toBe(true);
    expect(m?.display).toBe('make the title bold');
  });

  it('orders the parts: app, pictures, text blocks, request', () => {
    const m = assembleQuickMessage({
      text: 'compare',
      contexts: [
        { kind: 'files', id: 'f', paths: ['/tmp/a.txt', '/tmp/b.txt'] },
        win,
        {
          kind: 'browser',
          id: 'b',
          app: 'Safari',
          url: 'https://example.com',
          title: 'Example',
          text: 'Hello',
        },
        { kind: 'clipboard', id: 'c', text: 'clip' },
      ],
    });
    const msg = m?.agentMessage ?? '';
    const at = (s: string) => msg.indexOf(s);
    expect(at('Attached: a screenshot')).toBeLessThan(at('Selected in Finder'));
    expect(at('Selected in Finder')).toBeLessThan(at('Open in Safari'));
    expect(at('Open in Safari')).toBeLessThan(at('Clipboard text'));
    expect(at('Clipboard text')).toBeLessThan(at('compare'));
    expect(msg).toContain(
      'Open in Safari: “Example” https://example.com\nPage text:\n```\nHello\n```',
    );
  });

  it('a clipboard picture is sent as pixels too', () => {
    const m = assembleQuickMessage({
      text: '',
      contexts: [{ kind: 'clipboard', id: 'c', image: PNG }],
    });
    expect(m?.images).toEqual([PNG]);
    expect(m?.display).toBe('What is this picture?');
  });

  it('caps a huge selection and says so', () => {
    const huge = 'x'.repeat(MAX_SELECTION_CHARS + 50);
    const m = assembleQuickMessage({
      text: 'hm',
      contexts: [{ ...selection, text: huge } as QuickContext],
    });
    expect(m?.agentMessage).toContain('… (50 more characters not included)');
  });
});

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
