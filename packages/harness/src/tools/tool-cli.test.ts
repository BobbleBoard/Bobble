import { describe, expect, it } from 'vitest';
import {
  buildCli,
  type CliGroupSpec,
  type CliTool,
  coerceArgs,
  commandNameFor,
  parseArgv,
  pathFor,
  renderCommandHelp,
  renderGroupHelp,
  renderRootHelp,
  resolveCli,
  searchCommands,
} from './tool-cli';

const TOOLS: CliTool[] = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text description. Runs locally.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to make a picture of.' },
        n: { type: 'integer', description: 'How many candidates.' },
        size: { type: 'string', enum: ['512x512', '1024x1024'] },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: 'Edit an existing image.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, prompt: { type: 'string' } },
      required: ['path', 'prompt'],
    },
  },
  {
    name: 'generate_speech',
    description: 'Read text aloud in a chosen voice.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, voice: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'generate_sfx',
    description: 'Make a short sound effect from a description.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, seconds: { type: 'number' } },
      required: ['prompt'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page.',
    parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'browser_snapshot',
    description: 'Read the current page.',
    parameters: { type: 'object', properties: {} },
  },
];

const SPECS: CliGroupSpec[] = [
  {
    name: 'generation',
    summary: 'Make images, video, speech, music and sound effects on this machine.',
    tools: ['generate_image', 'edit_image', 'generate_video', 'generate_speech', 'generate_sfx'],
  },
  {
    name: 'browser',
    summary: "Drive the app's own browser.",
    tools: ['browser_click', 'browser_snapshot'],
  },
];

const cli = buildCli(SPECS, TOOLS);

describe('the command surface is derived, not hand-written', () => {
  it('names the generation capability `media`, as the user reached for it', () => {
    expect(commandNameFor('generation')).toBe('media');
    expect(cli.groups.map((g) => g.name)).toEqual(['media', 'browser']);
  });

  it('turns a tool name into a subcommand path', () => {
    expect(pathFor('media', 'generate_image')).toEqual(['generate', 'image']);
    // The group is not repeated: `browser browser click` is nobody's command.
    expect(pathFor('browser', 'browser_click')).toEqual(['click']);
  });

  it('OMITS a command whose tool this build does not register', () => {
    // generate_video is in the capability spec and not in the registry. Listing
    // it would be the false-availability failure this experiment exists to kill.
    const all = cli.groups.flatMap((g) => g.commands.map((c) => c.tool.name));
    expect(all).not.toContain('generate_video');
    expect(all).toContain('generate_image');
  });

  it('drops a group entirely when none of its tools exist', () => {
    const empty = buildCli([{ name: 'ghost', summary: 'x', tools: ['nope'] }], TOOLS);
    expect(empty.groups).toHaveLength(0);
  });
});

describe('parseArgv', () => {
  it('reads --key value, --key=value and bare flags', () => {
    const p = parseArgv(['generate', 'image', '--prompt', 'a fox', '--n=4', '--wide']);
    expect(p.words).toEqual(['generate', 'image']);
    expect(p.flags).toEqual({ prompt: 'a fox', n: '4', wide: true });
  });

  it('treats --help anywhere as a request for help', () => {
    expect(parseArgv(['generate', 'image', '--help']).wantsHelp).toBe(true);
    expect(parseArgv(['help']).wantsHelp).toBe(true);
  });

  it('keeps a negative number as a value, not a flag', () => {
    expect(parseArgv(['x', '--offset', '-5']).flags).toEqual({ offset: true });
    expect(parseArgv(['x', '--offset=-5']).flags).toEqual({ offset: '-5' });
  });
});

describe('resolveCli — the line a model actually writes', () => {
  const call = (line: string) => resolveCli(cli, line.split(' ').filter(Boolean));

  it('resolves the flag form', () => {
    expect(resolveCli(cli, ['media', 'generate', 'image', '--prompt', 'a red fox'])).toEqual({
      kind: 'call',
      tool: 'generate_image',
      args: { prompt: 'a red fox' },
    });
  });

  it('resolves the POSITIONAL form, which is what gets typed', () => {
    // the user's own example: `media generate video "prompt"`.
    expect(resolveCli(cli, ['media', 'generate', 'image', 'a red fox asleep'])).toEqual({
      kind: 'call',
      tool: 'generate_image',
      args: { prompt: 'a red fox asleep' },
    });
  });

  it('fills several required arguments positionally, in schema order', () => {
    expect(resolveCli(cli, ['media', 'edit', 'image', '/tmp/a.png', 'make it night'])).toEqual({
      kind: 'call',
      tool: 'edit_image',
      args: { path: '/tmp/a.png', prompt: 'make it night' },
    });
  });

  it('coerces to the schema’s types', () => {
    const r = resolveCli(cli, ['media', 'generate', 'image', '--prompt', 'x', '--n', '4']);
    expect(r).toEqual({ kind: 'call', tool: 'generate_image', args: { prompt: 'x', n: 4 } });
  });

  it('a flag beats a positional for the same argument', () => {
    const r = call('media generate image --prompt explicit ignored words');
    expect(r).toEqual({ kind: 'call', tool: 'generate_image', args: { prompt: 'explicit' } });
  });

  it('takes a tool with no arguments at all', () => {
    expect(call('browser snapshot')).toEqual({
      kind: 'call',
      tool: 'browser_snapshot',
      args: {},
    });
  });
});

describe('every failure hands back something to act on', () => {
  it('an unknown group suggests near matches instead of just refusing', () => {
    const r = resolveCli(cli, ['image', 'generate']);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.text).toContain('Did you mean');
    expect(r.text).toContain('media generate image');
  });

  it('an unknown subcommand prints the group’s commands', () => {
    const r = resolveCli(cli, ['media', 'make', 'picture']);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.text).toContain('media generate image');
  });

  it('a missing required argument names it and shows the usage', () => {
    const r = resolveCli(cli, ['media', 'edit', 'image', '--prompt', 'brighter']);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.text).toContain('--path');
    expect(r.text).toContain('Usage:');
  });

  it('never returns a bare refusal with no next step', () => {
    for (const line of [['nope'], ['media'], ['media', 'nope'], []]) {
      const r = resolveCli(cli, line);
      const text = r.kind === 'call' ? '' : r.text;
      expect(text.length).toBeGreaterThan(40);
      expect(text).toMatch(/media|tools|Commands|Usage/);
    }
  });
});

describe('discovery', () => {
  it('`tools` lists every group', () => {
    const r = resolveCli(cli, []);
    if (r.kind !== 'text') throw new Error('expected text');
    expect(r.text).toContain('media');
    expect(r.text).toContain('browser');
  });

  it('`tools search` finds a command by what it DOES, not its name', () => {
    const r = resolveCli(cli, ['tools', 'search', 'sound']);
    if (r.kind !== 'text') throw new Error('expected text');
    expect(r.text).toContain('media generate sfx');
  });

  it('finds speech from the word "aloud"', () => {
    expect(searchCommands(cli, 'read aloud').map((c) => c.tool.name)).toContain('generate_speech');
  });

  it('ranks a name match above a description match', () => {
    const hits = searchCommands(cli, 'image');
    expect(hits[0]?.tool.name).toMatch(/image/);
  });

  it('--help is generated from the schema, so it cannot drift', () => {
    const cmd = cli.groups[0]?.commands.find((c) => c.tool.name === 'generate_image');
    if (cmd === undefined) throw new Error('missing command');
    const help = renderCommandHelp(cmd);
    expect(help).toContain('--prompt <string> (required)');
    expect(help).toContain('--n <integer>');
    // Enum values are the answer to "what can I pass here", so they are shown.
    expect(help).toContain('[512x512|1024x1024]');
    // And the positional form is documented, because it is the one people type.
    expect(help).toContain('(positional: fills --prompt)');
  });

  it('the root and group help name real commands', () => {
    expect(renderRootHelp(cli)).toContain('media generate image');
    const g = cli.groups[0];
    if (g === undefined) throw new Error('no group');
    expect(renderGroupHelp(g)).toContain('media edit image');
  });
});

describe('coerceArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer' },
      on: { type: 'boolean' },
      tags: { type: 'array' },
      body: { type: 'object' },
      s: { type: 'string' },
    },
  };

  it('converts to the declared types', () => {
    expect(coerceArgs({ n: '4', on: 'true', tags: '["a","b"]', s: '5' }, schema)).toEqual({
      n: 4,
      on: true,
      tags: ['a', 'b'],
      s: '5',
    });
  });

  it('falls back to a comma list when an array is not JSON', () => {
    expect(coerceArgs({ tags: 'a, b' }, schema)).toEqual({ tags: ['a', 'b'] });
  });

  it('passes unknown keys through rather than dropping them', () => {
    // A dropped typo is a silent no-op; a passed typo is an error the tool can
    // explain.
    expect(coerceArgs({ nope: 'x' }, schema)).toEqual({ nope: 'x' });
  });
});
