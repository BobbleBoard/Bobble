/**
 * THE BASH-vs-TOOL GATE the Activity terminal sits behind.
 *
 * In tool-CLI mode every tool is a command on PATH, so `mac snapshot` and
 * `ls -la` arrive through the SAME `bash` tool call. The user: "bash command? (once
 * verified they aren't a special cli tool, so if they don't start with any
 * registered tools) shows up in a terminal."
 *
 * The list is asserted against the REGISTRY rather than restated here — a test
 * that hard-codes the names would pass forever while a new capability quietly
 * started opening terminals.
 */
import { describe, expect, it } from 'vitest';
import { toolCliShimCommands } from '../../../../../packages/harness/src/tools/tool-cli-groups.ts';
import {
  firstCommandWord,
  isRegisteredCliCommand,
  isTerminalCommand,
  REGISTERED_CLI_COMMANDS,
} from './activity-cli';

describe('REGISTERED_CLI_COMMANDS', () => {
  it('is exactly the shim list the harness installs on PATH', () => {
    expect([...REGISTERED_CLI_COMMANDS].sort()).toEqual([...toolCliShimCommands()].sort());
  });

  it('carries the groups that really exist (a sanity check on the registry seam)', () => {
    // Named because a silently EMPTY set would make every command a terminal
    // command and this whole gate a no-op that still passed its other tests.
    for (const command of ['tools', 'browser', 'mac', 'media', 'web', 'file', 'coordinate']) {
      expect(REGISTERED_CLI_COMMANDS.has(command)).toBe(true);
    }
  });

  it('does NOT shadow real shell commands with the tools inside a group', () => {
    // `ls`, `read`, `write` and `edit` are tools in the `file` group — typed
    // `file ls`, never `ls`. If they were shims, the user's own example (`ls -la`
    // in a terminal) would be impossible.
    for (const tool of ['ls', 'read', 'write', 'edit', 'cat', 'grep']) {
      expect(REGISTERED_CLI_COMMANDS.has(tool)).toBe(false);
    }
  });
});

describe('firstCommandWord', () => {
  it('takes the program, not the arguments', () => {
    expect(firstCommandWord('ls -la')).toBe('ls');
    expect(firstCommandWord('  git   status  ')).toBe('git');
  });

  it('reduces a path to its basename', () => {
    expect(firstCommandWord('/usr/bin/ls -la')).toBe('ls');
    expect(firstCommandWord('./scripts/build.sh')).toBe('build.sh');
  });

  it('steps over leading environment assignments', () => {
    expect(firstCommandWord('FOO=1 ls')).toBe('ls');
    expect(firstCommandWord('NODE_ENV=test DEBUG="a b" npm test')).toBe('npm');
  });

  it('unwraps a quoted program name', () => {
    expect(firstCommandWord('"media" generate image')).toBe('media');
  });

  it('has no answer for an empty line', () => {
    expect(firstCommandWord('')).toBeUndefined();
    expect(firstCommandWord('   ')).toBeUndefined();
  });
});

describe('isRegisteredCliCommand', () => {
  it('recognises a tool invocation by its group shim', () => {
    expect(isRegisteredCliCommand('mac snapshot --app Notes')).toBe(true);
    expect(isRegisteredCliCommand('media generate image "a red fox"')).toBe(true);
    expect(isRegisteredCliCommand('file write notes.md --content hi')).toBe(true);
    expect(isRegisteredCliCommand('web search "electron webcontentsview"')).toBe(true);
    expect(isRegisteredCliCommand('tools search terminal')).toBe(true);
  });

  it('leaves ordinary shell commands alone', () => {
    expect(isRegisteredCliCommand('ls -la')).toBe(false);
    expect(isRegisteredCliCommand('npm run build')).toBe(false);
    expect(isRegisteredCliCommand('cat package.json')).toBe(false);
  });
});

describe('isTerminalCommand', () => {
  it('is the inverse for a real command', () => {
    expect(isTerminalCommand('ls -la')).toBe(true);
    expect(isTerminalCommand('git log --oneline -5')).toBe(true);
    expect(isTerminalCommand('mac snapshot')).toBe(false);
  });

  it('reads a line that STARTS in the shell as a shell line', () => {
    // Documented behaviour, not an accident: the first word is the test, so a
    // line that begins by changing directory is a shell line whatever follows.
    expect(isTerminalCommand('cd /tmp && media generate image "x"')).toBe(true);
  });

  it('shows nothing for a half-streamed or empty command', () => {
    expect(isTerminalCommand('')).toBe(false);
    expect(isTerminalCommand('   \n ')).toBe(false);
  });

  it('takes an explicit name set, for a build whose registry differs', () => {
    const names = new Set(['tools', 'gizmo']);
    expect(isTerminalCommand('gizmo do-thing', names)).toBe(false);
    expect(isTerminalCommand('mac snapshot', names)).toBe(true);
  });
});
