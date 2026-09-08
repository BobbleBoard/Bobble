/**
 * The pure parts of the connectors model: how a failure is read, what tools
 * cost, and the words the screen puts on things. The store-backed hooks are
 * exercised by the e2e probes against the real app.
 */
import type { KnownConnector } from '@pi-desktop/mcp-lite';
import { describe, expect, it } from 'vitest';
import {
  agoLabel,
  attentionLine,
  type ConnectorItem,
  type CustomItem,
  classifyFailure,
  examplePrompt,
  failureLabel,
  failureLine,
  failureReason,
  formatTokens,
  humanizeKey,
  humanizeTool,
  isInstalled,
  isToolOn,
  matches,
  needsAttention,
  reachLine,
  SECTIONS,
  sectionOf,
  type ToolFailure,
  toolCost,
  unfilled,
} from './model';

function connector(over: Partial<KnownConnector> & { id: string }): KnownConnector {
  return {
    name: over.id,
    icon: '🔌',
    description: `${over.id} description`,
    category: 'dev',
    official: false,
    template: { id: over.id, name: over.id, icon: '🔌', description: '', command: 'npx' },
    ...over,
  };
}

const github = connector({
  id: 'github',
  name: 'GitHub',
  requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
});

function item(over: Partial<ConnectorItem>): ConnectorItem {
  return {
    kind: 'connector',
    id: 'github',
    name: 'GitHub',
    description: 'd',
    connector: github,
    server: undefined,
    state: 'available',
    reason: undefined,
    failure: undefined,
    ...over,
  };
}

describe('classifyFailure / failureReason', () => {
  it('tells a server that could not start from one that did not answer', () => {
    expect(classifyFailure('MCP server process exited (code 1)')).toBe('start');
    expect(classifyFailure('spawn uvx ENOENT')).toBe('start');
    expect(classifyFailure("MCP request 'initialize' timed out after 15000ms")).toBe('timeout');
    expect(classifyFailure('MCP error: something odd')).toBe('other');
  });

  it('prefers the server’s own last stderr line, else says the host’s message plainly', () => {
    expect(
      failureReason({
        error: 'MCP server process exited (code 1)',
        stderr: ['GitHub API: 401 Bad credentials'],
      }),
    ).toBe('GitHub API: 401 Bad credentials');
    expect(failureReason({ error: 'MCP server process exited (code 1)' })).toBe(
      'The process exited (code 1) before it answered.',
    );
    expect(failureReason({ error: 'spawn uvx ENOENT' })).toBe(
      'uvx is not installed, or not on the PATH.',
    );
    expect(failureReason({ error: "MCP request 'initialize' timed out after 15000ms" })).toBe(
      'No answer within 15 seconds.',
    );
  });
});

describe('a failing server', () => {
  const server = { id: 'github', name: 'GitHub', command: 'npx', args: ['-y', 'x'], enabled: true };
  const at = Date.now() - 4 * 60_000;

  it('needs attention, says so on the row, and offers the key as the fix where it has one', () => {
    const failed = item({
      server,
      state: 'on',
      failure: { at, cmd: 'npx -y x', error: 'MCP server process exited (code 1)', kind: 'start' },
    });
    expect(needsAttention(failed)).toBe(true);
    expect(failureLine(failed)).toBe('Could not start · tried 4 min ago');
    expect(attentionLine(failed)).toBe('Could not start · tried 4 min ago');
    expect(failureLabel(failed)).toBe('Needs setup');
    expect(isInstalled(failed)).toBe(true);
  });

  it('says on the row what a server still needs before it can run', () => {
    const waiting = item({ server: { ...server, enabled: false }, state: 'needs-setup' });
    expect(attentionLine(waiting)).toBe('Needs a key before it can run');
    expect(isInstalled(waiting)).toBe(true);
    expect(attentionLine(item({ server, state: 'on' }))).toBeNull();
    expect(isInstalled(item({}))).toBe(false);
  });

  it('says "Not responding" only for a timeout, on a server without keys', () => {
    const failure: ToolFailure = {
      at,
      cmd: 'node',
      error: 'timed out after 15000ms',
      kind: 'timeout',
    };
    const custom: CustomItem = {
      kind: 'custom',
      id: 'custom:weather',
      name: 'Weather',
      description: 'Runs node · added by you',
      server: { id: 'weather', name: 'Weather', command: 'node' },
      state: 'on',
      failure,
    };
    expect(failureLabel(custom)).toBe('Not responding');
    expect(failureLine(custom)).toBe('Did not answer · tried 4 min ago');
    expect(failureLabel({ ...custom, failure: { ...failure, kind: 'start' } })).toBe(
      'Could not start',
    );
  });
});

describe('sections', () => {
  it('folds every catalog category into one of six sections, in page order', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(['dev', 'data', 'browse', 'comms', 'docs', 'media']);
    expect(sectionOf('dev')).toBe('dev');
    expect(sectionOf('devops')).toBe('dev');
    expect(sectionOf('observability')).toBe('dev');
    expect(sectionOf('files')).toBe('data');
    expect(sectionOf('database')).toBe('data');
    expect(sectionOf('analytics')).toBe('data');
    expect(sectionOf('browser')).toBe('browse');
    expect(sectionOf('search')).toBe('browse');
    expect(sectionOf('comms')).toBe('comms');
    expect(sectionOf('meetings')).toBe('comms');
    expect(sectionOf('docs')).toBe('docs');
    expect(sectionOf('project')).toBe('docs');
    expect(sectionOf('design')).toBe('media');
    expect(sectionOf('creative')).toBe('media');
    expect(sectionOf('media')).toBe('media');
  });
});

describe('setup', () => {
  it('lists the keys still empty, and none once one is pasted', () => {
    expect(unfilled(github, undefined)).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(
      unfilled(github, { ...github.template, env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } }),
    ).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(
      unfilled(github, { ...github.template, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' } }),
    ).toEqual([]);
  });
});

describe('tool cost', () => {
  const tools = [
    { name: 'get_me', description: 'Get details of the authenticated user.', tokens: 120 },
    { name: 'create_issue', description: 'Create an issue.', tokens: 300 },
    { name: 'push_files', description: 'Push files.', tokens: 400 },
  ];

  it('counts only the tools that are on, in both modes', () => {
    const all = toolCost(tools, undefined);
    expect(all.on).toBe(3);
    expect(all.total).toBe(3);
    expect(all.native).toBe(820);
    expect(all.lite).toBeGreaterThan(0);
    expect(all.lite).toBeLessThan(all.native);
    const some = toolCost(tools, { disabledTools: ['push_files'] });
    expect(some.on).toBe(2);
    expect(some.native).toBe(420);
    expect(isToolOn({ disabledTools: ['push_files'] }, 'push_files')).toBe(false);
    expect(isToolOn(undefined, 'push_files')).toBe(true);
  });

  it('formats as a rounded estimate', () => {
    expect(formatTokens(320)).toBe('≈ 320');
    expect(formatTokens(2140)).toBe('≈ 2.1k');
    expect(formatTokens(27400)).toBe('≈ 27k');
  });
});

describe('words', () => {
  it('humanises tool names and keys', () => {
    expect(humanizeTool('list_channel_members')).toBe('List channel members');
    expect(humanizeTool('getFileContents')).toBe('Get file contents');
    expect(humanizeTool('github_get_me', 'github')).toBe('Get me');
    expect(humanizeTool('create_pr')).toBe('Create PR');
    expect(humanizeKey('GITHUB_PERSONAL_ACCESS_TOKEN', 'GitHub')).toBe(
      'a GitHub personal access token',
    );
    expect(humanizeKey('OBSIDIAN_API_KEY')).toBe('an obsidian API key');
  });

  it('leads with an authored ask, and derives one from the first look-up tool otherwise', () => {
    expect(examplePrompt(item({}), [])).toMatch(/pull requests/);
    const custom: CustomItem = {
      kind: 'custom',
      id: 'custom:weather',
      name: 'Weather',
      description: 'Runs node · added by you',
      server: { id: 'weather', name: 'Weather', command: 'node' },
      state: 'on',
      failure: undefined,
    };
    expect(
      examplePrompt(custom, [
        { name: 'set_units', description: '', tokens: 1 },
        { name: 'get_forecast', description: '', tokens: 1 },
      ]),
    ).toBe('Use Weather to get forecast for me.');
    expect(examplePrompt(custom, [])).toBe('Use Weather in this chat.');
  });

  it('says what a connector touches in under a row’s width', () => {
    expect(reachLine(github, undefined)).toBe('Signs in with your GitHub token');
    const fs = connector({ id: 'filesystem' });
    // The home folder as `~`: the one ledger row that truncated was this path.
    expect(reachLine(fs, { ...fs.template, args: ['-y', 'x', '/Users/me/Projects'] })).toBe(
      'Reads and writes files under ~/Projects',
    );
    expect(reachLine(fs, { ...fs.template, args: ['-y', 'x', '/Volumes/Data'] })).toBe(
      'Reads and writes files under /Volumes/Data',
    );
    expect(reachLine(connector({ id: 'other', appBundles: ['Thing.app'] }), undefined)).toBe(
      'Works with Thing on this Mac',
    );
  });

  it('dates a cached list', () => {
    const now = 1_000_000_000;
    expect(agoLabel(now - 10_000, now)).toBe('just now');
    expect(agoLabel(now - 4 * 60_000, now)).toBe('4 min ago');
    expect(agoLabel(now - 26 * 3_600_000, now)).toBe('yesterday');
  });

  it('matches the search against the category label and a custom server’s command', () => {
    expect(matches(item({}), 'developer tools')).toBe(true);
    expect(matches(item({}), 'zzz')).toBe(false);
    const custom: CustomItem = {
      kind: 'custom',
      id: 'custom:weather',
      name: 'Weather',
      description: 'Runs node · added by you',
      server: { id: 'weather', name: 'Weather', command: 'node', args: ['/x/weather-mcp.js'] },
      state: 'on',
      failure: undefined,
    };
    expect(matches(custom, 'weather-mcp')).toBe(true);
  });
});
