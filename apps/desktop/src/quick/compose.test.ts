import { describe, expect, it } from 'vitest';
import {
  assembleQuickMessage,
  MAX_SELECTION_CHARS,
  type QuickContext,
} from '../../electron/quick/context';
import { splitAttachedFiles } from '../chat/attached-files';
import { composeAgentMessage } from './compose';

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

/** The whole path a send takes: assemble, then fold like the composer. */
function send(input: Parameters<typeof assembleQuickMessage>[0]) {
  const a = assembleQuickMessage(input);
  return a === null ? null : { ...a, agentMessage: composeAgentMessage(a) };
}

describe('the quick panel message', () => {
  it('a plain question goes as typed, with nothing folded in', () => {
    expect(send({ text: '  what is 2+2?  ', contexts: [] })).toMatchObject({
      display: 'what is 2+2?',
      agentMessage: 'what is 2+2?',
      images: [],
      replacesSelection: false,
    });
  });

  it('nothing typed and nothing attached is nothing to send', () => {
    expect(send({ text: '   ', contexts: [] })).toBeNull();
  });

  it('a saved window picture goes as an attachment line, with what it is', () => {
    const m = send({
      text: 'what is wrong here?',
      contexts: [win],
      imagePaths: { w: '/b/attachments/image-0a1b2c3d4e5f.png' },
    });
    expect(m?.images).toEqual([PNG]);
    expect(m?.agentMessage).toBe(
      'Attached image: /b/attachments/image-0a1b2c3d4e5f.png (a screenshot of the TextEdit window “Notes.txt”, 1200×800)\n\nwhat is wrong here?',
    );
    expect(m?.display).toBe('what is wrong here?');
  });

  it('a picture that could not be saved is still named, in words', () => {
    const m = send({ text: 'and this?', contexts: [win] });
    expect(m?.agentMessage).toBe(
      'Attached: a screenshot of the TextEdit window “Notes.txt”, 1200×800.\n\nand this?',
    );
  });

  it('a picture with no question asks what it shows', () => {
    const m = send({
      text: '',
      contexts: [{ kind: 'region', id: 'r', image: PNG, width: 640, height: 480 }],
    });
    expect(m?.display).toBe('What am I looking at? Point out what matters.');
    expect(m?.agentMessage).toMatch(
      /^Attached: a screenshot of an area of the screen the user selected, 640×480\./,
    );
  });

  it('selected text is folded as an attachment, and an action becomes the request', () => {
    const m = send({ text: '', contexts: [selection], action: 'fix' });
    expect(m?.display).toBe('Fix the spelling and grammar');
    expect(m?.agentMessage).toBe(
      'Attached file `Selected text in Mail`:\n```\nteh quick brwon fox\n```\n\nFix the spelling and grammar and change nothing else. Reply with only the corrected text: no preamble, no quotes.',
    );
    expect(m?.replacesSelection).toBe(true);
  });

  it('text that carries its own fence is not folded (it would end the fold early)', () => {
    const m = send({ text: 'hm', contexts: [{ ...selection, text: 'a ``` b' } as QuickContext] });
    expect(m?.agentMessage).toBe('Selected text in Mail:\n````\na ``` b\n````\n\nhm');
  });

  it('translate names the language; explain does not replace', () => {
    const t = send({ text: '', contexts: [selection], action: 'translate', language: 'French' });
    expect(t?.display).toBe('Translate the selection into French');
    expect(t?.agentMessage).toContain('Translate this into French.');
    expect(t?.replacesSelection).toBe(true);
    expect(send({ text: '', contexts: [selection], action: 'explain' })?.replacesSelection).toBe(
      false,
    );
  });

  it('a selection from a field that takes no text back is never offered as replaceable', () => {
    const m = send({
      text: '',
      contexts: [{ ...selection, editable: false } as QuickContext],
      action: 'rewrite',
    });
    expect(m?.replacesSelection).toBe(false);
  });

  it('typed words ride along with an action', () => {
    const m = send({ text: 'keep it short', contexts: [selection], action: 'rewrite' });
    expect(m?.display).toBe('keep it short');
    expect(m?.agentMessage).toMatch(/no preamble, no quotes\.\n\nAlso: keep it short$/);
  });

  it('acting in an app needs words, and tells the model which app and pid', () => {
    const app: QuickContext = { kind: 'app', id: 'a', app: 'TextEdit', pid: 4242 };
    expect(send({ text: '', contexts: [app] })).toBeNull();
    const m = send({ text: 'make the title bold', contexts: [app] });
    expect(m?.agentMessage).toMatch(/^The user summoned Bobble while working in TextEdit/);
    expect(m?.agentMessage).toContain('mac_snapshot on the app “TextEdit”');
    expect(m?.agentMessage).toContain('pid 4242');
    expect(m?.agentMessage.endsWith('make the title bold')).toBe(true);
  });

  it("Finder's files go by path, a folder as a folder", () => {
    const m = send({
      text: 'compare',
      contexts: [{ kind: 'files', id: 'f', paths: ['/tmp/a.txt', '/tmp/drafts/'] }],
    });
    expect(m?.agentMessage).toBe(
      'Attached file: /tmp/a.txt (selected in Finder)\nAttached folder: /tmp/drafts\n\ncompare',
    );
  });

  it('the page: its address in words, its text folded', () => {
    const m = send({
      text: 'summarize',
      contexts: [
        {
          kind: 'browser',
          id: 'b',
          app: 'Safari',
          url: 'https://example.com',
          title: 'Example',
          text: 'Hello',
        },
      ],
    });
    expect(m?.agentMessage).toBe(
      'Attached file `Page text from Safari`:\n```\nHello\n```\n\nOpen in Safari: “Example” https://example.com\n\nsummarize',
    );
  });

  it('a clipboard picture is sent as pixels too', () => {
    const m = send({ text: '', contexts: [{ kind: 'clipboard', id: 'c', image: PNG }] });
    expect(m?.images).toEqual([PNG]);
    expect(m?.display).toBe('What is this picture?');
  });

  it('caps a huge selection and says so', () => {
    const huge = 'x'.repeat(MAX_SELECTION_CHARS + 50);
    const m = send({ text: 'hm', contexts: [{ ...selection, text: huge } as QuickContext] });
    expect(m?.agentMessage).toContain('… (50 more characters not included)');
  });

  it('dropped files fold in beside the panel’s own attachments', () => {
    const a = assembleQuickMessage({ text: 'both?', contexts: [selection] });
    const msg = composeAgentMessage(a ?? { attachments: [], tail: '' }, [
      { kind: 'text', name: 'ideas.txt', text: 'river walk' },
    ]);
    expect(msg).toBe(
      'Attached file `Selected text in Mail`:\n```\nteh quick brwon fox\n```\n\nAttached file `ideas.txt`:\n```\nriver walk\n```\n\nboth?',
    );
  });
});

describe('opened in the main window, it reads back as a chat', () => {
  it('splits into the same cards the chat draws, and the typed words', () => {
    const m = send({
      text: 'what changed?',
      contexts: [
        win,
        selection,
        { kind: 'files', id: 'f', paths: ['/tmp/a.txt'] },
        {
          kind: 'browser',
          id: 'b',
          app: 'Safari',
          url: 'https://example.com',
          title: 'Example',
          text: 'Hello',
        },
      ],
      imagePaths: { w: '/b/attachments/image-0a1b2c3d4e5f.png' },
    });
    const back = splitAttachedFiles(m?.agentMessage ?? '');
    expect(back.images.map((i) => i.path)).toEqual(['/b/attachments/image-0a1b2c3d4e5f.png']);
    expect(back.refs.map((r) => r.path)).toEqual(['/tmp/a.txt']);
    expect(back.files.map((f) => [f.name, f.text])).toEqual([
      ['Selected text in Mail', 'teh quick brwon fox'],
      ['Page text from Safari', 'Hello'],
    ]);
    expect(back.text).toBe('Open in Safari: “Example” https://example.com\n\nwhat changed?');
  });
});
