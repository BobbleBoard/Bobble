import type { ChatMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import { computerUseGate } from './computer-use-gate';
import { problemCopy } from './quick-problem';
import { quickTurns, replyText, threadTitle } from './thread-model';

describe('computerUseGate', () => {
  const textEdit = { name: 'TextEdit', bundleId: 'com.apple.TextEdit' };

  it('off when computer use is switched off', () => {
    expect(computerUseGate({ enabled: false, apps: [] }, textEdit)).toBe('off');
  });

  it('allowed when the app is on the list, by name or by bundle id', () => {
    expect(
      computerUseGate(
        { enabled: true, apps: [{ id: 'com.apple.TextEdit', name: 'TextEdit' }] },
        textEdit,
      ),
    ).toBe('allowed');
    expect(
      computerUseGate(
        { enabled: true, apps: [{ id: 'com.apple.TextEdit', name: 'Text Editor' }] },
        textEdit,
      ),
    ).toBe('allowed');
  });

  it('asks for anything else — the consent gate puts the question in the panel', () => {
    expect(
      computerUseGate(
        { enabled: true, apps: [{ id: 'com.apple.Notes', name: 'Notes' }] },
        textEdit,
      ),
    ).toBe('ask');
  });

  it('never for Bobble, Keychain Access or System Settings, even when switched on and listed', () => {
    const all = {
      enabled: true,
      apps: [{ id: 'com.apple.systempreferences', name: 'System Settings' }],
    };
    expect(
      computerUseGate(all, { name: 'System Settings', bundleId: 'com.apple.systempreferences' }),
    ).toBe('never');
    expect(computerUseGate(all, { name: 'Keychain Access' })).toBe('never');
    expect(computerUseGate(all, { name: 'Bobble' })).toBe('never');
    // Off does not outrank never: the answer is still "never".
    expect(computerUseGate({ enabled: false, apps: [] }, { name: 'Keychain Access' })).toBe(
      'never',
    );
  });
});

describe('problemCopy', () => {
  it('every permission problem names the pane and carries the button that opens it', () => {
    const sr = problemCopy({ kind: 'screen-recording' });
    expect(sr.body).toContain('Privacy & Security › Screen Recording');
    expect(sr.fixes[0]).toEqual({
      kind: 'system-settings',
      pane: 'screen-recording',
      label: 'Open Screen Recording',
    });
    expect(problemCopy({ kind: 'accessibility' }).fixes[0]).toMatchObject({
      pane: 'accessibility',
    });
    expect(problemCopy({ kind: 'automation', app: 'Finder' }).title).toBe(
      'Bobble is not allowed to talk to Finder',
    );
  });

  it('computer use off offers to turn it on, and to choose apps', () => {
    const c = problemCopy({ kind: 'computer-use-off', app: 'Notes' });
    expect(c.fixes.map((f) => f.kind)).toEqual(['turn-on-computer-use', 'open-settings']);
    expect(c.body).toContain('Notes');
  });

  it('writes no exclamation marks, and never the word error', () => {
    const kinds = [
      { kind: 'screen-recording' },
      { kind: 'accessibility' },
      { kind: 'automation', app: 'Safari' },
      { kind: 'secure' },
      { kind: 'nothing' },
      { kind: 'unsupported', app: 'Mail' },
      { kind: 'failed' },
      { kind: 'computer-use-off', app: 'Notes' },
      { kind: 'computer-use-never', app: 'Keychain Access' },
    ] as const;
    for (const k of kinds) {
      const c = problemCopy(k);
      const words = `${c.title} ${c.body} ${c.fixes.map((f) => f.label).join(' ')}`;
      expect(words, k.kind).not.toMatch(/!|error/i);
    }
  });
});

describe('thread model', () => {
  const msgs: ChatMsg[] = [
    { kind: 'user', id: 'u1', text: 'what is in this window?', timestamp: 1 },
    {
      kind: 'assistant',
      id: 'a1',
      blocks: [
        { type: 'thinking', thinking: 'look' },
        { type: 'toolCall', id: 't1', name: 'mac_snapshot', arguments: {} },
      ],
      timestamp: 2,
    },
    {
      kind: 'toolResult',
      id: 'r1',
      toolCallId: 't1',
      toolName: 'mac_snapshot',
      text: 'ok',
      isError: false,
      timestamp: 3,
    },
    {
      kind: 'assistant',
      id: 'a2',
      blocks: [
        { type: 'text', text: 'A checklist ' },
        { type: 'text', text: 'for the launch.' },
      ],
      timestamp: 4,
    },
    { kind: 'user', id: 'u2', text: 'thanks', timestamp: 5 },
  ];

  it('groups everything after a user message into one answer, with its tool results', () => {
    const turns = quickTurns(msgs);
    expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'user']);
    const reply = turns[1];
    expect(reply?.kind === 'assistant' && reply.group.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(reply?.kind === 'assistant' && reply.results.get('t1')?.text).toBe('ok');
    expect(reply?.kind === 'assistant' && reply.answers).toBe('u1');
  });

  it("a reply's words are its text blocks joined", () => {
    const reply = quickTurns(msgs)[1];
    expect(reply?.kind === 'assistant' ? replyText(reply.group) : '').toBe(
      'A checklist for the launch.',
    );
  });

  it('titles a thread from its first question', () => {
    expect(threadTitle(msgs)).toBe('what is in this window?');
    expect(threadTitle([])).toBe('Quick question');
    expect(
      threadTitle([{ kind: 'user', id: 'u', text: 'x'.repeat(100), timestamp: 0 }]),
    ).toHaveLength(72);
  });
});
