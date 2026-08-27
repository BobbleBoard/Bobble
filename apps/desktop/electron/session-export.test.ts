/**
 * A chat as a file someone can keep. The parsing is what makes an export
 * trustworthy — a transcript that silently drops a turn is worse than none.
 */
import { describe, expect, it } from 'vitest';
import { parseSessionTurns, renderSessionMarkdown } from './session-export';

const line = (o: unknown) => JSON.stringify(o);
const SESSION = [
  line({ type: 'session', id: 's1', cwd: '/tmp/work', timestamp: '2026-08-26T10:00:00.000Z' }),
  line({ type: 'message', message: { role: 'user', content: 'make me a chart' } }),
  line({
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'toolCall', name: 'write' },
        { type: 'toolCall', name: 'bash' },
      ],
    },
  }),
  line({ type: 'message', message: { role: 'assistant', content: 'Done — chart.png.' } }),
].join('\n');

describe('parseSessionTurns', () => {
  it('keeps both roles and the tools each turn ran', () => {
    const { head, turns } = parseSessionTurns(SESSION);
    expect(head.cwd).toBe('/tmp/work');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(turns[1]?.tools).toEqual(['write', 'bash']);
  });

  it('keeps a turn that is only a tool call', () => {
    // Dropping it makes the assistant look as if it answered out of nowhere.
    const only = line({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] },
    });
    expect(parseSessionTurns(only).turns).toHaveLength(1);
  });

  it('survives a truncated final line, which an appending session always has', () => {
    expect(parseSessionTurns(`${SESSION}\n{"type":"mess`).turns).toHaveLength(3);
  });

  it('ignores non-message records', () => {
    const noise = `${line({ type: 'summary', text: 'x' })}\n${SESSION}`;
    expect(parseSessionTurns(noise).turns).toHaveLength(3);
  });
});

describe('renderSessionMarkdown', () => {
  it('uses the title it was given, not one it derived', () => {
    // Main does not know about renames; the renderer does.
    const md = renderSessionMarkdown(SESSION, 'Quarterly chart');
    expect(md.startsWith('# Quarterly chart\n')).toBe(true);
  });

  it('names tools without dumping their arguments', () => {
    const md = renderSessionMarkdown(SESSION, 't');
    expect(md).toContain('_Ran: `write`, `bash`_');
    expect(md).not.toContain('oldText');
  });

  it('renders both roles as headings', () => {
    const md = renderSessionMarkdown(SESSION, 't');
    expect(md).toContain('## You');
    expect(md).toContain('## Assistant');
    expect(md).toContain('make me a chart');
  });

  it('falls back rather than titling a document with nothing', () => {
    expect(renderSessionMarkdown(SESSION, '   ')).toContain('# Untitled chat');
  });
});
