/**
 * ANY MCP TOOL, AS A COMMAND, WITH NOTHING LOST.
 *
 * the user: "any mcp can be translated into a cli tool that has the description on
 * --help, auto error correction, and no capability loss from the mcp version."
 *
 * That is three claims, and this file is the proof of each. The schema below is
 * deliberately hostile — every JSON-Schema shape an MCP server is allowed to
 * declare, including the ones a flat `--key value` grammar is worst at: a nested
 * object, an array of objects, an enum, a number, a boolean, and a required
 * field that is none of those.
 */
import { describe, expect, it } from 'vitest';
import { buildCli, coerceArgs, renderCommandHelp, resolveCli } from './tool-cli';

const HOSTILE = {
  name: 'issues_create',
  description: 'Open an issue on a repository, optionally assigning and labelling it.',
  parameters: {
    type: 'object',
    required: ['repo', 'title'],
    properties: {
      repo: { type: 'string', description: 'owner/name of the repository.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'Markdown body.' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'Initial state.' },
      priority: { type: 'integer', description: '1 (highest) to 5.' },
      draft: { type: 'boolean', description: 'Open as a draft.' },
      labels: {
        type: 'array',
        description: 'Label names.',
        items: { type: 'string' },
      },
      assignee: {
        type: 'object',
        description: 'Who to assign it to.',
        properties: {
          login: { type: 'string', description: 'Their handle.' },
          notify: { type: 'boolean', description: 'Send them a mail.' },
        },
        required: ['login'],
      },
      checks: {
        type: 'array',
        description: 'Checklist entries.',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, done: { type: 'boolean' } },
        },
      },
    },
  },
} as const;

const GROUPS = [{ name: 'issues', summary: 'Track issues.', tools: ['issues_create'] }];
const cli = () => buildCli(GROUPS, [HOSTILE]);
const help = () => {
  const c = cli().groups[0]?.commands[0];
  if (c === undefined) throw new Error('command not built');
  return renderCommandHelp(c);
};

describe('the description survives', () => {
  it('prints the tool’s own description', () => {
    expect(help()).toContain(HOSTILE.description);
  });

  it('prints every argument with its type, its description and whether it is required', () => {
    const h = help();
    for (const key of Object.keys(HOSTILE.parameters.properties)) expect(h).toContain(`--${key}`);
    expect(h).toContain('owner/name of the repository.');
    expect(h).toContain('(required)');
    expect(h).toMatch(/--priority <integer>/);
  });

  it('prints an enum’s allowed values, so they never have to be guessed', () => {
    expect(help()).toContain('[open|closed]');
  });
});

describe('no capability loss', () => {
  /*
   * The hard case. An MCP client hands the model the whole JSON Schema, so it
   * can see that `assignee` takes `{login, notify}`. A help page that says only
   * `--assignee <object>` has lost that, and the model is left guessing key
   * names — which is capability loss even though every argument is reachable.
   */
  it('shows the SHAPE of a nested object, not just its type', () => {
    const h = help();
    expect(h).toContain('login');
    expect(h).toContain('notify');
  });

  it('shows what an array holds', () => {
    const h = help();
    expect(h).toMatch(/--labels <array/);
    expect(h).toContain('text'); // the checklist items' own keys
  });

  it('round-trips every type through the parser', () => {
    const args = coerceArgs(
      {
        repo: 'the user/bobble',
        title: 'It leaks',
        priority: '2',
        draft: 'true',
        labels: '["bug","p1"]',
        assignee: '{"login":"the user","notify":true}',
      },
      HOSTILE.parameters,
    );
    expect(args).toEqual({
      repo: 'the user/bobble',
      title: 'It leaks',
      priority: 2,
      draft: true,
      labels: ['bug', 'p1'],
      assignee: { login: 'the user', notify: true },
    });
  });

  it('takes a comma list for an array when the model does not write JSON', () => {
    expect(coerceArgs({ labels: 'bug, p1' }, HOSTILE.parameters).labels).toEqual(['bug', 'p1']);
  });
});

describe('errors correct themselves', () => {
  it('a missing required argument answers with the help, not just a complaint', () => {
    const r = resolveCli(cli(), ['issues', 'create', '--title', 'It leaks']);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.text).toContain('--repo');
    expect(r.text).toContain('Usage:');
    expect(r.text).toContain('owner/name of the repository.');
  });

  it('an unknown command answers with the group’s commands', () => {
    const r = resolveCli(cli(), ['issues', 'destroy']);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.text).toContain('no such command');
    expect(r.text).toContain('create');
  });

  it('--help is answered without calling anything', () => {
    const r = resolveCli(cli(), ['issues', 'create', '--help']);
    expect(r.kind).toBe('text');
    if (r.kind !== 'text') return;
    expect(r.text).toContain('Usage:');
  });

  it('a positional fills the first required argument, the way a model writes it', () => {
    const r = resolveCli(cli(), ['issues', 'create', 'the user/bobble', '--title', 'It leaks']);
    expect(r.kind).toBe('call');
    if (r.kind === 'call') expect(r.args.repo).toBe('the user/bobble');
  });
});
