import { describe, expect, it } from 'vitest';
import { newSameCallState, noteRepeatedCall, SAME_CALL_LIMIT } from './same-call';

describe('the same call, made again', () => {
  it('says nothing the first two times — two is a coincidence', () => {
    const s = newSameCallState();
    expect(noteRepeatedCall(s, 'write', { path: 'a' }, 'wrote 13 bytes')).toBeNull();
    expect(noteRepeatedCall(s, 'write', { path: 'a' }, 'wrote 13 bytes')).toBeNull();
  });

  it('speaks on the third, which is where it is cheapest', () => {
    const s = newSameCallState();
    for (let i = 1; i < SAME_CALL_LIMIT; i += 1) {
      noteRepeatedCall(s, 'write', { path: 'a' }, 'wrote 13 bytes');
    }
    const note = noteRepeatedCall(s, 'write', { path: 'a' }, 'wrote 13 bytes');
    expect(note).toContain('3 times');
    expect(note).toContain('write');
  });

  it('speaks once, not on every repeat after', () => {
    const s = newSameCallState();
    const notes: (string | null)[] = [];
    for (let i = 0; i < 8; i += 1) {
      notes.push(noteRepeatedCall(s, 'write', { path: 'a' }, 'ok'));
    }
    expect(notes.filter((n) => n !== null)).toHaveLength(1);
  });

  it('catches a SUCCESS loop, which is the one nothing else catches', () => {
    // Twelve successful writes of the same thirteen bytes: no error, no failure
    // count, no complaint from anything — and the whole run gone.
    const s = newSameCallState();
    let spoke = false;
    for (let i = 0; i < 12; i += 1) {
      if (noteRepeatedCall(s, 'write', { path: 'r.txt' }, 'Successfully wrote 13 bytes') !== null) {
        spoke = true;
      }
    }
    expect(spoke).toBe(true);
  });

  it('resets the verbatim counter when the arguments change', () => {
    const s = newSameCallState();
    noteRepeatedCall(s, 'write', { path: 'a' }, 'wrote a');
    noteRepeatedCall(s, 'write', { path: 'b' }, 'wrote b');
    expect(noteRepeatedCall(s, 'write', { path: 'b' }, 'wrote b')).toBeNull();
  });

  it('catches a REFUSAL, which never repeats verbatim', () => {
    // MEASURED: nineteen `edit` calls, every one with different arguments,
    // every one answered "edit is not available in this run". An
    // argument-sensitive signature never fires on that — the answer was the
    // part that was not changing.
    const s = newSameCallState();
    const refusal = 'edit is not available in this run.';
    expect(noteRepeatedCall(s, 'edit', { path: 'a.txt' }, refusal)).toBeNull();
    expect(noteRepeatedCall(s, 'edit', { path: 'b.txt' }, refusal)).toBeNull();
    const note = noteRepeatedCall(s, 'edit', { path: 'c.txt', text: 'x' }, refusal);
    expect(note).toContain('arguments are not the problem');
    expect(note).toContain('edit');
  });

  it('does not fire on the same answer from DIFFERENT tools', () => {
    const s = newSameCallState();
    noteRepeatedCall(s, 'edit', { a: 1 }, 'not available');
    noteRepeatedCall(s, 'write', { a: 1 }, 'not available');
    expect(noteRepeatedCall(s, 'read', { a: 1 }, 'not available')).toBeNull();
  });

  it('does not care what order the arguments were written in', () => {
    const s = newSameCallState();
    noteRepeatedCall(s, 'write', { path: 'a', content: 'x' }, 'ok');
    noteRepeatedCall(s, 'write', { content: 'x', path: 'a' }, 'ok');
    expect(noteRepeatedCall(s, 'write', { path: 'a', content: 'x' }, 'ok')).not.toBeNull();
  });

  it('treats a different result as progress even for the same arguments', () => {
    const s = newSameCallState();
    noteRepeatedCall(s, 'bash', { command: 'ls' }, 'a');
    noteRepeatedCall(s, 'bash', { command: 'ls' }, 'b');
    expect(noteRepeatedCall(s, 'bash', { command: 'ls' }, 'a')).toBeNull();
  });
});
