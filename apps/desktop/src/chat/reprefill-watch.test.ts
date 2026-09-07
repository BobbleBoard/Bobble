import { describe, expect, it } from 'vitest';
import { prefixChange, toolChangeIsCostly } from './reprefill-watch';

const id = (over: Partial<Parameters<typeof prefixChange>[1]> = {}) => ({
  modelId: 'qwen',
  system: 'you are helpful',
  toolsJson: '[{"name":"bash"},{"name":"read"}]',
  ...over,
});

describe('prefixChange', () => {
  it('says nothing on the first observation — there is no before', () => {
    expect(prefixChange(null, id())).toBeNull();
  });

  it('says nothing when nothing moved', () => {
    expect(prefixChange(id(), id())).toBeNull();
  });

  it('names a model switch', () => {
    expect(prefixChange(id(), id({ modelId: 'gemma' }))).toBe('model-switch');
  });

  /* The model subsumes the rest: everything is different under a new model, and
   * "you switched model" is the sentence the person can act on. */
  it('calls it a model switch even when everything changed at once', () => {
    expect(prefixChange(id(), id({ modelId: 'gemma', system: 'other', toolsJson: '[]' }))).toBe(
      'model-switch',
    );
  });

  it('names an instruction change', () => {
    expect(prefixChange(id(), id({ system: 'you are terse' }))).toBe('instructions');
  });

  it('names a tool change', () => {
    expect(prefixChange(id(), id({ toolsJson: '[{"name":"bash"}]' }))).toBe('tools');
  });

  /* A model that has gone away (a restart mid-load) is not a switch. */
  it('does not call an absent model a switch', () => {
    expect(prefixChange(id(), id({ modelId: null }))).toBeNull();
  });
});

describe('toolChangeIsCostly', () => {
  const list = (...names: string[]) => JSON.stringify(names.map((name) => ({ name })));

  /*
   * The harness keeps the tool set append-only precisely so a new task class
   * does not move the tools that were already there. An addition costs the
   * tokens after it, not the whole prompt.
   */
  it('is quiet about an appended tool', () => {
    expect(toolChangeIsCostly(list('bash', 'read'), list('bash', 'read', 'web_search'))).toBe(
      false,
    );
  });

  it('speaks up when a tool is REMOVED — everything after it moves', () => {
    expect(toolChangeIsCostly(list('bash', 'web_search', 'read'), list('bash', 'read'))).toBe(true);
  });

  it('speaks up when the order changes', () => {
    expect(toolChangeIsCostly(list('bash', 'read'), list('read', 'bash'))).toBe(true);
  });

  it('holds its tongue when it cannot read either list', () => {
    expect(toolChangeIsCostly('not json', list('bash'))).toBe(false);
    expect(toolChangeIsCostly(list('bash'), '[]')).toBe(false);
  });
});

/*
 * The harness publishes the system prompt and tool list a beat after a session
 * starts. Comparing against the empty string in that window reads as an
 * instruction change and fires a warning about nothing at all.
 */
describe('an unknown prefix', () => {
  it('is not a change, in either direction', () => {
    const empty = id({ system: '', toolsJson: '' });
    expect(prefixChange(empty, id())).toBeNull();
    expect(prefixChange(id(), empty)).toBeNull();
  });

  it('is unknown if either half is missing', () => {
    expect(prefixChange(id({ toolsJson: '' }), id())).toBeNull();
    expect(prefixChange(id({ system: '' }), id())).toBeNull();
  });

  /* ...but a model switch is knowable without either of them, and it is the
   * cause a person most needs to hear about. */
  it('still hides a model switch behind the unknown prefix, deliberately', () => {
    expect(prefixChange(id({ system: '', toolsJson: '' }), id({ modelId: 'gemma' }))).toBeNull();
  });
});
