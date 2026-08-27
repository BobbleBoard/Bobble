/**
 * b10: the three slash commands the menu has always offered.
 *
 * `/help`, `/new` and `/compact` were listed unconditionally so `/` always had
 * something to show, and picking one sent the literal text to the model, which
 * answered as if asked ABOUT compaction. The parsing is what decides whether a
 * line is a command or a message, so it is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseSlashCommand } from './slash-commands';

describe('parseSlashCommand', () => {
  it('recognises the three built-ins', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', rest: '' });
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', rest: '' });
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', rest: '' });
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(parseSlashCommand('  /Compact  ')).toEqual({ name: 'compact', rest: '' });
  });

  it('carries instructions for /compact, which pi’s RPC accepts', () => {
    expect(parseSlashCommand('/compact keep the API decisions')).toEqual({
      name: 'compact',
      rest: 'keep the API decisions',
    });
  });

  it('leaves a command with a tail alone when the command takes none', () => {
    // "/new project for the migration" is a message about a new project.
    // Treating it as the command would be a guess with a destructive outcome.
    expect(parseSlashCommand('/new project for the migration')).toBeNull();
    expect(parseSlashCommand('/help me write a regex')).toBeNull();
  });

  it('ignores commands this app does not own — those go to pi', () => {
    expect(parseSlashCommand('/harness status')).toBeNull();
    expect(parseSlashCommand('/mcp')).toBeNull();
  });

  it('is not fooled by ordinary text', () => {
    expect(parseSlashCommand('what does /compact do?')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('//new')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('HELP_TEXT', () => {
  it('documents what it claims to, and nothing that does not exist', () => {
    for (const claim of ['/new', '/compact', '/help', '!', '@', '⌘N', 'Esc']) {
      expect(HELP_TEXT).toContain(claim);
    }
  });

  it('stays short — a wall of text is not help', () => {
    expect(HELP_TEXT.split('\n').length).toBeLessThan(30);
  });
});
