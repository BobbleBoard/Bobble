import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { buildCli, coerceArgs, renderCommandHelp } from './tool-cli';

/**
 * NO CAPABILITY LOSS, ON A SCHEMA THAT FIGHTS BACK.
 *
 * The user: "anything that can be provided as a schema is converted to with no
 * capability loss a CLI based tool … make sure it works well across a range of
 * different input types and complex schemas."
 *
 * The easy half is a tool with three string flags. This is the other half: a
 * schema with every shape the typebox tools actually use — nested objects,
 * arrays of objects, a union of literals, a numeric union, enums, integers,
 * booleans, optionals and defaults — asserted twice over. Once that `--help`
 * SAYS every parameter exists and what it takes, because a parameter the help
 * omits is a capability the model cannot know it has; and once that a value
 * typed at a shell ARRIVES as the type the schema asked for, because a nested
 * object delivered as the string "{...}" is a parameter that exists and does
 * not work.
 */

/** Every shape the real tools use, in one deliberately awkward schema. */
const HOSTILE = Type.Object({
  path: Type.String({ description: 'Where to write it.' }),
  count: Type.Integer({ description: 'How many.' }),
  ratio: Type.Number({ description: 'A fraction.' }),
  overwrite: Type.Boolean({ description: 'Replace what is there.' }),
  mode: Type.Union([Type.Literal('fast'), Type.Literal('careful')], {
    description: 'How hard to try.',
  }),
  amount: Type.Union([Type.Number(), Type.Integer()], { description: 'Distance to travel.' }),
  tags: Type.Array(Type.String(), { description: 'Labels.' }),
  edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), {
    description: 'Replacements to apply.',
  }),
  window: Type.Object(
    { x: Type.Number(), y: Type.Number(), label: Type.Optional(Type.String()) },
    { description: 'Where on screen.' },
  ),
  note: Type.Optional(Type.String({ description: 'Anything else.' })),
});

const TOOL = {
  name: 'demo_run',
  description: 'Do the awkward thing. Takes every shape a schema can take.',
  parameters: HOSTILE as unknown as Record<string, unknown>,
};

/** What `demo run --help` prints — the page a model reads before its first call. */
function help(): string {
  const cli = buildCli([{ name: 'demo', summary: 'The awkward one.', tools: ['demo_run'] }], [
    TOOL,
  ] as never);
  const command = cli.groups[0]?.commands[0];
  if (command === undefined) throw new Error('the command did not build');
  return renderCommandHelp(command);
}

const schema = HOSTILE as unknown as Parameters<typeof coerceArgs>[1];

describe('--help documents every parameter', () => {
  it('names all of them, including the optional one', () => {
    const text = help();
    for (const key of [
      'path',
      'count',
      'ratio',
      'overwrite',
      'mode',
      'amount',
      'tags',
      'edits',
      'window',
      'note',
    ]) {
      expect(text, key).toContain(key);
    }
  });

  it('says what the awkward ones take, not just that they exist', () => {
    const text = help();
    // A model that is told `edits` exists but not that it is a list of
    // {oldText,newText} has to guess, and guessing at a nested shape is the
    // single most expensive mistake this interface can invite.
    expect(text).toContain('oldText');
    expect(text).toContain('newText');
    expect(text).toContain('fast');
    expect(text).toContain('careful');
  });
});

describe('a value typed at a shell arrives as the type the schema asked for', () => {
  it('carries scalars across', () => {
    const out = coerceArgs({ path: '/tmp/a', count: '3', ratio: '0.5', overwrite: 'true' }, schema);
    expect(out).toEqual({ path: '/tmp/a', count: 3, ratio: 0.5, overwrite: true });
  });

  it('reads a bare flag as true, which is how a shell says a boolean', () => {
    expect(coerceArgs({ overwrite: true }, schema).overwrite).toBe(true);
  });

  it('types a union whose branches agree', () => {
    // Every branch of `amount` is a number, so "40" must not arrive as "40".
    expect(coerceArgs({ amount: '40' }, schema).amount).toBe(40);
    // …and a union of string literals stays a string.
    expect(coerceArgs({ mode: 'careful' }, schema).mode).toBe('careful');
  });

  it('parses a nested object', () => {
    expect(coerceArgs({ window: '{"x":10,"y":20,"label":"main"}' }, schema).window).toEqual({
      x: 10,
      y: 20,
      label: 'main',
    });
  });

  it('parses an array of objects', () => {
    expect(coerceArgs({ edits: '[{"oldText":"a","newText":"b"}]' }, schema).edits).toEqual([
      { oldText: 'a', newText: 'b' },
    ]);
  });

  it('accepts a comma list for an array of scalars, which is what a shell invites', () => {
    expect(coerceArgs({ tags: 'red, green ,blue' }, schema).tags).toEqual(['red', 'green', 'blue']);
  });

  it('keeps a quoted comma inside one item', () => {
    expect(coerceArgs({ tags: '"a,b",c' }, schema).tags).toEqual(['a,b', 'c']);
  });

  it('does NOT invent items when an object array is malformed', () => {
    // Splitting `[{"oldText":"a"` on commas produces fragments the tool then
    // rejects for a reason that has nothing to do with what was typed. The raw
    // string goes through so the tool's own validation can say what it wanted.
    expect(coerceArgs({ edits: '[{"oldText":"a"' }, schema).edits).toBe('[{"oldText":"a"');
  });

  it('passes an unknown key through untouched rather than dropping it', () => {
    // A typo must reach the tool as a typo — a dropped key is a silent no-op.
    expect(coerceArgs({ nosuch: 'x' }, schema).nosuch).toBe('x');
  });
});
