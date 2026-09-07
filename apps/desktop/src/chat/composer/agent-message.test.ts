import { describe, expect, it } from 'vitest';
import { activatedConnectors, buildAgentMessage, connectorActivationLine } from './agent-message';

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
