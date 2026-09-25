import { describe, expect, it } from 'vitest';
import {
  activatedConnectors,
  attachmentLine,
  buildAgentMessage,
  connectorActivationLine,
} from './agent-message';

const GMAIL = { slug: 'gmail', name: 'Gmail' };
const NOTION = { slug: 'notion', name: 'Notion' };
const ALL = [GMAIL, NOTION];

describe('activatedConnectors', () => {
  it('finds a connector the draft names', () => {
    expect(activatedConnectors('check /gmail for the receipt', ALL)).toEqual([GMAIL]);
  });

  it('finds nothing in an ordinary sentence', () => {
    expect(activatedConnectors('summarise my email', ALL)).toEqual([]);
  });

  /*
   * A PATH IS NOT A COMMAND. `src/gmail/index.ts` mentions gmail and activates
   * nothing — otherwise writing about a folder would silently switch a connector
   * on and add a line to the prompt.
   */
  it('ignores a slash inside a path', () => {
    expect(activatedConnectors('open src/gmail/index.ts', ALL)).toEqual([]);
  });

  it('does not match a longer neighbour', () => {
    expect(activatedConnectors('/gmail-drafts please', ALL)).toEqual([]);
  });

  it('reports them in the order they appear, not registry order', () => {
    expect(activatedConnectors('first /notion then /gmail', ALL)).toEqual([NOTION, GMAIL]);
  });

  it('counts a repeat once', () => {
    expect(activatedConnectors('/gmail and again /gmail', ALL)).toEqual([GMAIL]);
  });

  it('only knows about connectors that are installed', () => {
    expect(activatedConnectors('/slack please', ALL)).toEqual([]);
  });
});

describe('connectorActivationLine', () => {
  it('says nothing when nothing was activated', () => {
    expect(connectorActivationLine([])).toBe('');
  });

  it('reads as one tool in the singular', () => {
    const line = connectorActivationLine([GMAIL]);
    expect(line).toContain('New CLI tool activated by the user');
    expect(line).toContain('`gmail` (Gmail)');
    expect(line).toContain('This tool is ready for use now');
    expect(line).toContain('`gmail --help`');
  });

  it('reads as several in the plural', () => {
    const line = connectorActivationLine(ALL);
    expect(line).toContain('New CLI tools activated');
    expect(line).toContain('These tools are ready');
  });
});

describe('buildAgentMessage', () => {
  it('is unchanged when no connector is named', () => {
    expect(buildAgentMessage('hello', [], ALL)).toBe('hello');
  });

  it('appends the activation AFTER the message, never before it', () => {
    const out = buildAgentMessage('check /gmail', [], ALL);
    expect(out.indexOf('check /gmail')).toBeLessThan(out.indexOf('New CLI tool'));
  });

  /*
   * The prefill and the send call this with the same arguments precisely so the
   * bodies match byte for byte; an activation line that appeared in only one of
   * them would re-prefill the whole message.
   */
  it('keeps the attached-file blocks ahead of the typed text', () => {
    const out = buildAgentMessage('why /notion', [{ name: 'a.txt', text: 'x' }], ALL);
    expect(out.indexOf('Attached file')).toBeLessThan(out.indexOf('why /notion'));
    expect(out.indexOf('why /notion')).toBeLessThan(out.indexOf('New CLI tool'));
  });

  it('still works with no connector list at all', () => {
    expect(buildAgentMessage('check /gmail', [])).toBe('check /gmail');
  });
});

/*
 * PATHS (2026-09-24). the user: "why not handle this natively so that any
 * image(s)/files/folders... can be pasted into the input box". Everything with
 * a file behind it is named to the model by its path, so its tools can open it.
 */
describe('the lines that name attachments by path', () => {
  const PDF = {
    kind: 'file' as const,
    name: 'Q3 report.pdf',
    path: '/Users/j/Desktop/Q3 report.pdf',
    bytes: 2_411_724,
  };
  const FOLDER = { kind: 'folder' as const, name: 'garden', path: '/Users/j/Desktop/garden' };
  const FOX = { kind: 'image' as const, name: 'fox.png', path: '/Users/j/fox.png', bytes: 130_000 };
  const NOTES = {
    kind: 'text' as const,
    name: 'notes.md',
    path: '/Users/j/notes.md',
    text: '# hi',
  };

  it('says what each thing is, short, the way the fold does', () => {
    expect(attachmentLine(PDF)).toBe('Attached file: /Users/j/Desktop/Q3 report.pdf (PDF, 2.3 MB)');
    expect(attachmentLine(FOLDER)).toBe('Attached folder: /Users/j/Desktop/garden');
    expect(attachmentLine(FOX)).toBe('Attached image: /Users/j/fox.png (PNG, 127 KB)');
  });

  it('gives a text file no line — its fold names the path instead', () => {
    expect(attachmentLine(NOTES)).toBeNull();
    expect(buildAgentMessage('', [NOTES])).toBe(
      'Attached file `/Users/j/notes.md`:\n```\n# hi\n```',
    );
  });

  it('keeps the bare name for a paste, which never was a file', () => {
    expect(buildAgentMessage('', [{ name: 'pasted content', text: 'x' }])).toBe(
      'Attached file `pasted content`:\n```\nx\n```',
    );
  });

  it('puts the lines first, then the folds, then what was typed', () => {
    expect(buildAgentMessage('what first?', [NOTES, PDF, FOX, FOLDER])).toBe(
      [
        'Attached file: /Users/j/Desktop/Q3 report.pdf (PDF, 2.3 MB)',
        'Attached image: /Users/j/fox.png (PNG, 127 KB)',
        'Attached folder: /Users/j/Desktop/garden',
        '',
        'Attached file `/Users/j/notes.md`:',
        '```',
        '# hi',
        '```',
        '',
        'what first?',
      ].join('\n'),
    );
  });

  /*
   * THE PREFILL CONTRACT. The composer primes buildAgentMessage('', a) while
   * you type and sends buildAgentMessage(typed, a): the first must be a byte
   * prefix of the second, or Enter re-reads the whole attachment.
   */
  it('what is primed with nothing typed is a byte prefix of what is sent', () => {
    for (const set of [[PDF], [FOLDER, FOX], [NOTES, PDF, FOX, FOLDER], [FOX]]) {
      const primed = buildAgentMessage('', set);
      expect(buildAgentMessage('a question /notion', set, ALL).startsWith(primed)).toBe(true);
    }
  });

  it('names nothing it cannot put on one line', () => {
    expect(attachmentLine({ ...PDF, path: '/tmp/bad\nname.pdf' })).toBeNull();
    expect(attachmentLine({ kind: 'file', name: 'x.pdf' })).toBeNull();
  });

  it('keeps an edited message’s own words for what a file is', () => {
    const { bytes: _drop, ...noSize } = PDF;
    expect(attachmentLine({ ...noSize, detail: 'PDF, 2.3 MB' })).toBe(
      'Attached file: /Users/j/Desktop/Q3 report.pdf (PDF, 2.3 MB)',
    );
  });

  it('says "file" for a file with no extension', () => {
    expect(
      attachmentLine({ kind: 'file', name: 'tool', path: '/usr/local/bin/tool', bytes: 2048 }),
    ).toBe('Attached file: /usr/local/bin/tool (file, 2 KB)');
  });
});
