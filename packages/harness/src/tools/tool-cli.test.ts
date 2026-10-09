import { describe, expect, it } from 'vitest';
import {
  buildCli,
  type CliGroupSpec,
  type CliTool,
  coerceArgs,
  commandLineForCall,
  commandNameFor,
  connectorCommandForCall,
  parseArgv,
  pathFor,
  renderCommandHelp,
  renderGroupHelp,
  renderRootHelp,
  resolveCli,
  searchCommands,
  unreadFlagsNote,
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
    /* Shaped like the real mac_click/browser_click: NOTHING is required, because
       an index and an x,y pair are alternatives, and the index is a number. */
    name: 'browser_click',
    description: 'Click an element on the page.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Element index from the latest snapshot.' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
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

  it('drops the tool template’s own tags — a word of their own, or glued to a word', () => {
    // MEASURED (4B, rapid-mlx): `coordinate present --path=index.html "</parameter"`.
    expect(parseArgv(['present', '--path=index.html', '</parameter'])).toEqual({
      words: ['present'],
      flags: { path: 'index.html' },
      positionals: [],
      wantsHelp: false,
    });
    expect(parseArgv(['svg', 'a', 'fox</parameter>', '</function>']).words).toEqual([
      'svg',
      'a',
      'fox',
    ]);
    // A word that merely mentions a tag is left alone.
    expect(parseArgv(['x', '--q=<parameter> tags']).flags).toEqual({ q: '<parameter> tags' });
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
    // The user's own example: `media generate video "prompt"`.
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

  it('coerces a POSITIONAL to the schema’s types too, not only a flag', () => {
    /*
     * `browser click 1` and `browser click --index 1` have to mean the same
     * thing. They did not: flags went through coerceArgs and positionals were
     * assigned as raw strings, so the tool’s own `typeof index !== 'number'`
     * guard rejected the line it had just advertised as
     * `click "index"  (positional: fills --index)`. A 27B spent four of its nine
     * calls on that in the Maps run before finding the flag form.
     */
    expect(call('browser click 1')).toEqual({
      kind: 'call',
      tool: 'browser_click',
      args: { index: 1 },
    });
    expect(call('browser click 1')).toEqual(call('browser click --index 1'));
  });

  it('accepts the key:value form a model invents for a command it just met', () => {
    /*
     * MEASURED on a 4B driving Chrome: `mac click x:500 y:400` and
     * `mac click menu:"File > New Tab"`. The argument NAMES are right — it had
     * read the help — and only the punctuation is invented, so refusing it
     * measures the parser rather than the model.
     */
    expect(call('browser click x:500 y:400')).toEqual({
      kind: 'call',
      tool: 'browser_click',
      args: { x: 500, y: 400 },
    });
  });

  it('does not read a colon inside a VALUE as an argument name', () => {
    // `https://example.com` and `note: a thing` are values with colons in them;
    // only a colon whose key is an argument of THIS command is punctuation.
    expect(call('media generate image a fox at 5:30pm')).toEqual({
      kind: 'call',
      tool: 'generate_image',
      args: { prompt: 'a fox at 5:30pm' },
    });
  });

  it('reads two bare numbers as a POINT, not as one mangled index', () => {
    /*
     * MEASURED on a 27B driving Blender — an app with no Accessibility tree, so
     * every act is a coordinate. It wrote `mac click 660 558`, the natural form,
     * and was told "provide an element index, or x and y": with nothing required
     * in the schema, both numbers were joined into `index` as the string
     * "660 558", which is not a number, so the tool refused the form it had just
     * asked for. These tools take EITHER an index OR a point, which the schema
     * cannot express — the count of values says which one was meant.
     */
    expect(call('browser click 660 558')).toEqual({
      kind: 'call',
      tool: 'browser_click',
      args: { x: 660, y: 558 },
    });
    expect(call('browser click 7')).toEqual({
      kind: 'call',
      tool: 'browser_click',
      args: { index: 7 },
    });
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

  it('reads a kebab-case flag as the snake_case property it names', () => {
    // `--save-to` is what a command line teaches; `save_to` is what the schema
    // has. Only when the snake spelling really exists — nothing is invented.
    const media = {
      type: 'object',
      properties: { prompt: { type: 'string' }, save_to: { type: 'string' } },
    };
    expect(coerceArgs({ 'save-to': '/pics/fox.png' }, media)).toEqual({ save_to: '/pics/fox.png' });
    expect(coerceArgs({ save_to: '/pics/fox.png' }, media)).toEqual({ save_to: '/pics/fox.png' });
    expect(coerceArgs({ 'no-such': 'x' }, media)).toEqual({ 'no-such': 'x' });
  });
});

describe('delegation is reachable from the CLI', () => {
  const groups = [
    { name: 'browser', summary: 'Drive the browser.', tools: ['browser_navigate'] },
    {
      name: 'team',
      summary: 'Hand work to a subagent, or to the manager who runs a whole team.',
      tools: ['spawn_subagent', 'talk_to_manager'],
    },
  ];
  const tools = [
    { name: 'browser_navigate', description: 'Go to a URL.', parameters: undefined },
    {
      name: 'spawn_subagent',
      description: 'Hand a scoped task to a subagent.',
      parameters: undefined,
    },
    { name: 'talk_to_manager', description: 'Hand work to a manager.', parameters: undefined },
  ];

  it('gives both delegation tools a short command', () => {
    // The regression: only `bash` is advertised in CLI mode, and these two
    // belong to no capability — so at max effort with the CLI on there was no
    // delegation path at all, while the prompt told the model to delegate.
    const cli = buildCli(groups, tools);
    const team = cli.groups.find((g) => g.name === 'team');
    // `delegate`, not `spawn`: the tail is named for what the command DOES, now
    // that these live in `coordinate` alongside ask and plan rather than in a
    // group already called `team`.
    expect(team?.commands.map((c) => c.path.join(' '))).toEqual(['delegate', 'manager']);
    expect(resolveCli(cli, ['team', 'delegate', '--task', 'x']).kind).toBe('call');
  });

  it('drops the group when this build registered neither (a depth-capped child)', () => {
    const cli = buildCli(groups, tools.slice(0, 1));
    expect(cli.groups.map((g) => g.name)).toEqual(['browser']);
  });
});

describe('the word a model reaches for', () => {
  const schema = {
    type: 'object',
    properties: { app: { type: 'string' }, screenshot: { type: 'boolean' } },
  } as const;

  /* The user: "add a flag to snapshot to force a visual eg snapshot --image/visual".
     It existed as --screenshot, and the synonyms silently did nothing. */
  it('accepts --image, --visual and friends as --screenshot', () => {
    for (const alias of ['image', 'visual', 'picture', 'shot', 'see']) {
      expect(coerceArgs({ [alias]: true }, schema), alias).toEqual({ screenshot: true });
    }
  });

  it('still accepts the real flag', () => {
    expect(coerceArgs({ screenshot: true }, schema)).toEqual({ screenshot: true });
  });

  it('coerces an aliased string the way the real property is typed', () => {
    expect(coerceArgs({ visual: 'true' }, schema)).toEqual({ screenshot: true });
  });

  /* An alias must never shadow a flag a tool genuinely has. */
  it('leaves a real `image` property alone', () => {
    const own = { type: 'object', properties: { image: { type: 'string' } } } as const;
    expect(coerceArgs({ image: 'cat.png' }, own)).toEqual({ image: 'cat.png' });
  });

  it('leaves an unknown flag unknown, so it still reaches the tool as an error', () => {
    expect(coerceArgs({ nonsense: 'x' }, schema)).toEqual({ nonsense: 'x' });
  });
});

describe('the notation the snapshot prints', () => {
  const call = (line: string) => resolveCli(cli, line.split(' ').filter(Boolean));

  /* MEASURED, MiniCPM5 driving Maps: the element list prints `[2] Apple Maps`,
     so the model wrote `mac type [2] "Table Mountain"` — the notation it had
     just been shown — and was told "refusing to type without an index". It
     burned four calls arguing with that before reading --help and rewriting the
     identical line as `--text "…" --index 2`. Teaching one notation in the
     output and accepting only another in the input is our mistake. */
  it('reads [2] as the index', () => {
    expect(call('browser click [2]')).toEqual({
      kind: 'call',
      tool: 'browser_click',
      args: { index: 2 },
    });
  });

  it('still accepts the bare number and the flag form', () => {
    expect(call('browser click 7')).toMatchObject({ args: { index: 7 } });
    expect(call('browser click --index 7')).toMatchObject({ args: { index: 7 } });
  });
});

describe('svg — a group whose one tool IS the command', () => {
  /* The user: "svg <optional prompt> --image <optional reference image path(s)>".
     generate_svg maps to an empty path under the `svg` group, so the group
     name is the whole command and the prompt is its positional. */
  const svgTools: CliTool[] = [
    {
      name: 'generate_svg',
      description: 'Make an SVG.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          image: { type: 'string' },
          candidates: { type: 'number' },
          out: { type: 'string' },
          figure: { type: 'boolean' },
        },
      },
    },
  ];
  const svgCli = buildCli(
    [{ name: 'svg', summary: 'Make an SVG.', tools: ['generate_svg'] }],
    svgTools,
  );
  const call = (line: string) => resolveCli(svgCli, line.split(' ').filter(Boolean));

  it('is reached as `svg`, with no sub-word', () => {
    expect(commandNameFor('svg')).toBe('svg');
    expect(pathFor('svg', 'generate_svg')).toEqual([]);
  });

  it('takes the prompt as the positional', () => {
    expect(call('svg a red heart')).toMatchObject({
      kind: 'call',
      tool: 'generate_svg',
      args: { prompt: 'a red heart' },
    });
  });

  it('takes a reference image as a flag, with or without a prompt', () => {
    expect(call('svg --image ref.png')).toMatchObject({
      kind: 'call',
      args: { image: 'ref.png' },
    });
    expect(call('svg a fox --image ref.png')).toMatchObject({
      kind: 'call',
      args: { prompt: 'a fox', image: 'ref.png' },
    });
  });

  it('puts the file where a page will reference it: --out', () => {
    /* The user: a website should "utilize the svgs firsthand" — the graphic has
       to land beside the page, not in Generated, for <img src> to work. */
    expect(call('svg a gear icon, single colour --out assets/gear.svg')).toMatchObject({
      kind: 'call',
      args: { prompt: 'a gear icon, single colour', out: 'assets/gear.svg' },
    });
  });

  it('reads a file name among the positionals as the output', () => {
    /* MEASURED on a 4B: `svg "--prompt=a bicycle" bicycle.svg` — the name it
       gave was the prompt slot's, the file landed in Generated, and two cp
       calls followed. A word with an extension is a path, not a prompt. */
    expect(call('svg --prompt=a_bicycle bicycle.svg')).toMatchObject({
      kind: 'call',
      args: { prompt: 'a_bicycle', out: 'bicycle.svg' },
    });
    expect(call('svg a red heart heart.svg')).toMatchObject({
      kind: 'call',
      args: { prompt: 'a red heart', out: 'heart.svg' },
    });
    // On its own a file name is still the prompt slot's — nothing else fills it.
    expect(call('svg bicycle.svg')).toMatchObject({
      kind: 'call',
      args: { prompt: 'bicycle.svg' },
    });
  });

  it('reads a word after a switch as the command’s text, the switch on', () => {
    /* MEASURED (4B, the maths suite's lever): `svg --figure "<svg …>"` — the
       markup given to the switch, coerced to figure: false, the prompt gone. */
    expect(resolveCli(svgCli, ['svg', '--figure', '<svg width="600"></svg>'])).toMatchObject({
      kind: 'call',
      args: { figure: true, prompt: '<svg width="600"></svg>' },
    });
    expect(call('svg a lever --figure yes')).toMatchObject({
      kind: 'call',
      args: { prompt: 'a lever', figure: true },
    });
    expect(call('svg a lever --figure false')).toMatchObject({
      kind: 'call',
      args: { prompt: 'a lever', figure: false },
    });
  });

  it('names a flag the command does not have, and says so in the result', () => {
    /* MEASURED (4B, the visual suite): `svg recipe-app-icons --icons timer,…`
       — the icon list went into a flag svg does not have, and the answer was
       one drawing with no word that the list had gone nowhere. */
    const res = call('svg recipe-app-icons --icons timer,servings');
    expect(res).toMatchObject({
      kind: 'call',
      args: { prompt: 'recipe-app-icons', icons: 'timer,servings' },
      unread: ['icons'],
    });
    const note = res.kind === 'call' ? unreadFlagsNote(svgCli, res.tool, res.unread ?? []) : '';
    expect(note).toContain('--icons is not an argument of `svg`, so it did nothing');
    expect(note).toContain('--prompt');
    expect(note).toContain('--out');
    // A flag it does have is not named.
    expect(call('svg a fox --out assets/fox.svg')).not.toHaveProperty('unread');
  });
});

describe('a one-command group named by its group word', () => {
  const svg: CliTool = {
    name: 'generate_svg',
    description: 'Draw an SVG.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, image: { type: 'string' } },
    },
  };
  const one = buildCli([{ name: 'svg', summary: 'Draw vectors.', tools: ['generate_svg'] }], [svg]);

  it('`svg --help` is the COMMAND help — usage and arguments, not the group page', () => {
    const res = resolveCli(one, ['svg', '--help']);
    expect(res.kind).toBe('text');
    expect(res.kind === 'text' && res.text).toMatch(/^Usage:/m);
    expect(res.kind === 'text' && res.text).toContain('--prompt');
    expect(res.kind === 'text' && res.text).not.toContain('svg <command> --help');
  });

  it('a bare `svg` still shows the group page, and flags still call', () => {
    expect(resolveCli(one, ['svg']).kind).toBe('text');
    expect(resolveCli(one, ['svg', '--prompt=a star'])).toEqual({
      kind: 'call',
      tool: 'generate_svg',
      args: { prompt: 'a star' },
    });
  });
});

describe('a tool call that named the command — turned back into the line', () => {
  /*
   * MEASURED 2026-09-15: in bash-CLI mode a 4B emitted `media generate image`
   * as a structured tool call with the command's flags as its arguments, then
   * `media --help`, then `coordinate present {file_path}`. Each is the shell
   * line in the other notation; the translation is mechanical.
   */
  const present: CliTool = {
    name: 'present',
    description: 'Show the user a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, note: { type: 'string' } },
      required: ['path'],
    },
  };
  const full = buildCli(
    [...SPECS, { name: 'coordinate', summary: 'Settle things with people.', tools: ['present'] }],
    [...TOOLS, present],
  );
  const shims = ['tools', 'media', 'browser', 'coordinate'];

  /** What /bin/sh hands the shim: the line split on unquoted spaces. */
  const argvOf = (line: string): string[] =>
    (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((w) =>
      w.startsWith('"') ? w.slice(1, -1).replace(/\\(.)/g, '$1') : w,
    );

  it('the command as a name, its flags as arguments → the line, and it resolves', () => {
    const line = commandLineForCall(
      full,
      'media generate image',
      { prompt: 'a cow on the moon', n: 2 },
      shims,
    );
    expect(line).toBe('media generate image "--prompt=a cow on the moon" --n=2');
    const res = resolveCli(full, argvOf(line ?? ''));
    expect(res).toEqual({
      kind: 'call',
      tool: 'generate_image',
      args: { prompt: 'a cow on the moon', n: 2 },
    });
  });

  it('`media --help` typed as a name is the help', () => {
    const line = commandLineForCall(full, 'media --help', {}, shims);
    expect(line).toBe('media --help');
    expect(resolveCli(full, argvOf(line ?? '')).kind).toBe('text');
  });

  it('an argument the command does not know becomes a positional, so it still lands', () => {
    const line = commandLineForCall(
      full,
      'coordinate present',
      { file_path: 'image-of-a-cow/cow-on-moon.png' },
      shims,
    );
    expect(line).toBe('coordinate present image-of-a-cow/cow-on-moon.png');
    expect(resolveCli(full, argvOf(line ?? ''))).toEqual({
      kind: 'call',
      tool: 'present',
      args: { path: 'image-of-a-cow/cow-on-moon.png' },
    });
  });

  it("a tool's registered name is the same intent", () => {
    expect(commandLineForCall(full, 'present', { path: 'a.png' }, shims)).toBe(
      'coordinate present --path=a.png',
    );
    expect(commandLineForCall(full, 'generate_image', { prompt: 'fox' }, shims)).toBe(
      'media generate image --prompt=fox',
    );
  });

  it('accepts the joiners a model writes instead of spaces', () => {
    expect(commandLineForCall(full, 'media_generate_image', { prompt: 'fox' }, shims)).toBe(
      'media generate image --prompt=fox',
    );
    expect(commandLineForCall(full, 'browser.snapshot', {}, shims)).toBe('browser snapshot');
  });

  it('refuses anything whose head is not one of our shims', () => {
    expect(commandLineForCall(full, 'python3', { code: '1' }, shims)).toBeUndefined();
    expect(commandLineForCall(full, 'ls -la', {}, shims)).toBeUndefined();
    expect(commandLineForCall(full, 'some_tool', {}, shims)).toBeUndefined();
    expect(commandLineForCall(full, '', {}, shims)).toBeUndefined();
  });

  it('quotes for the shell: dollars, quotes, newlines, and the values a schema types', () => {
    const line = commandLineForCall(
      full,
      'media generate image',
      { prompt: 'Revenue was $412,000 "up" 14%\nsecond line', size: '512x512', n: true },
      shims,
    );
    expect(line).toBe(
      'media generate image "--prompt=Revenue was \\$412,000 \\"up\\" 14%\nsecond line" --size=512x512 --n=true',
    );
    const res = resolveCli(full, argvOf(line ?? ''));
    expect(res.kind === 'call' && res.args.prompt).toBe(
      'Revenue was $412,000 "up" 14%\nsecond line',
    );
  });

  it('a nested value travels as JSON', () => {
    const line = commandLineForCall(full, 'coordinate present', { path: 'a', note: 'n' }, shims);
    expect(line).toBe('coordinate present --path=a --note=n');
    expect(commandLineForCall(full, 'browser click', { pos: { x: 1, y: 2 } }, shims)).toBe(
      'browser click "{\\"x\\":1,\\"y\\":2}"',
    );
  });
});

describe('connectorCommandForCall — a connector named as a tool', () => {
  const ids = ['time', 'google-drive'];
  it("turns the 4B's `time` {} into the connector's own help", () => {
    expect(connectorCommandForCall(ids, 'time', {})).toBe('pi-tool time');
  });
  it('carries a named tool and its arguments as flags, whatever the joiner', () => {
    const want = 'pi-tool time get_current_time --timezone=Asia/Tokyo';
    expect(connectorCommandForCall(ids, 'time get_current_time', { timezone: 'Asia/Tokyo' })).toBe(
      want,
    );
    expect(connectorCommandForCall(ids, 'time_get_current_time', { timezone: 'Asia/Tokyo' })).toBe(
      want,
    );
    expect(connectorCommandForCall(ids, 'time.get_current_time', { timezone: 'Asia/Tokyo' })).toBe(
      want,
    );
    expect(
      connectorCommandForCall(ids, 'pi-tool time get_current_time', { timezone: 'Asia/Tokyo' }),
    ).toBe(want);
    expect(connectorCommandForCall(ids, 'google-drive_search', { query: 'q 1' })).toBe(
      'pi-tool google-drive search "--query=q 1"',
    );
  });
  it('leaves anything that is not a connector alone', () => {
    expect(connectorCommandForCall(ids, 'timer', {})).toBeUndefined();
    expect(connectorCommandForCall(ids, 'weather', {})).toBeUndefined();
    expect(connectorCommandForCall([], 'time', {})).toBeUndefined();
  });
});
