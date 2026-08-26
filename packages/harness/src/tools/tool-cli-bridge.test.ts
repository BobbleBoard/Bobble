import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * ASYNC exec, not the sync one. The bridge's socket server lives in THIS
 * process during the test, and `execFileSync` blocks the event loop — so the
 * shim connects, the server can never accept, and both sides sit until the
 * timeout. In the app the bridge is in the pi child and bash is a separate
 * process, so the deadlock is a property of the test, not of the design.
 */
const run = promisify(execFile);

import type { CliGroupSpec, CliTool } from './tool-cli';
import { buildShim, dispatchToolCli, registerToolCli, type ToolCliHost } from './tool-cli-bridge';

const TOOLS: CliTool[] = [
  {
    name: 'generate_image',
    description: 'Make a picture.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, n: { type: 'integer' } },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_sfx',
    description: 'Make a short sound effect.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
  },
];

const GROUPS: CliGroupSpec[] = [
  { name: 'generation', summary: 'Make media locally.', tools: TOOLS.map((t) => t.name) },
];

function host(calls: { name: string; args: Record<string, unknown> }[] = []): ToolCliHost {
  return {
    tools: () => TOOLS,
    groups: () => GROUPS,
    call: async (name, args) => {
      calls.push({ name, args });
      return { text: `${name} ran`, isError: false };
    },
  };
}

describe('dispatchToolCli', () => {
  it('runs the tool a command line names', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const r = await dispatchToolCli(host(calls), ['media', 'generate', 'image', 'a red fox']);
    expect(r).toEqual({ text: 'generate_image ran', isError: false });
    expect(calls).toEqual([{ name: 'generate_image', args: { prompt: 'a red fox' } }]);
  });

  it('answers discovery without calling anything', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const r = await dispatchToolCli(host(calls), ['tools']);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('media');
    expect(calls).toEqual([]);
  });

  it('reports a tool’s own failure as the command failing', async () => {
    const boom: ToolCliHost = {
      tools: () => TOOLS,
      groups: () => GROUPS,
      call: async () => {
        throw new Error('the model is not installed');
      },
    };
    const r = await dispatchToolCli(boom, ['media', 'generate', 'image', 'x']);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('the model is not installed');
  });

  it('rebuilds the surface per request, so a late tool is reachable', async () => {
    let tools: CliTool[] = [];
    const late: ToolCliHost = {
      tools: () => tools,
      groups: () => GROUPS,
      call: async (name) => ({ text: `${name} ran`, isError: false }),
    };
    // Nothing registered yet: the group does not exist at all.
    expect((await dispatchToolCli(late, ['media'])).isError).toBe(true);
    tools = TOOLS;
    expect((await dispatchToolCli(late, ['media'])).isError).toBe(false);
  });
});

describe('the installed shell', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('writes one executable per group, plus tools, and puts them on PATH', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const shimDir = mkdtempSync(path.join(tmpdir(), 'toolcli-test-'));
    dirs.push(shimDir);
    const handle = registerToolCli(host(), {
      shimDir,
      socketPath: path.join(shimDir, 's.sock'),
      env,
    });

    expect(handle.commands).toEqual(['tools', 'media']);
    const written = readdirSync(shimDir).sort();
    expect(written).toContain('media');
    expect(written).toContain('tools');
    // Executable, and the directory is not world-readable.
    expect(statSync(path.join(shimDir, 'media')).mode & 0o111).toBeGreaterThan(0);
    expect(statSync(shimDir).mode & 0o077).toBe(0);
    expect(env.PATH?.startsWith(shimDir)).toBe(true);

    handle.dispose();
    // PATH restored exactly, and nothing left behind.
    expect(env.PATH).toBe('/usr/bin');
    expect(readdirSync(tmpdir()).includes(path.basename(shimDir))).toBe(false);
  });

  it('a shim really executes and reaches the bridge', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const shimDir = mkdtempSync(path.join(tmpdir(), 'toolcli-live-'));
    dirs.push(shimDir);
    const handle = registerToolCli(host(), {
      shimDir,
      socketPath: path.join(shimDir, 's.sock'),
      env,
      // Plain node stands in for Electron-as-Node here; the dispatcher is the
      // same file either way, which is the part worth exercising.
      execPath: process.execPath,
    });
    try {
      const { stdout } = await run(path.join(shimDir, 'tools'), [], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 15_000,
      });
      expect(stdout).toContain('media');
    } finally {
      handle.dispose();
    }
  });

  it('refuses a request without the session token', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const shimDir = mkdtempSync(path.join(tmpdir(), 'toolcli-auth-'));
    dirs.push(shimDir);
    const handle = registerToolCli(host(), {
      shimDir,
      socketPath: path.join(shimDir, 's.sock'),
      env,
      execPath: process.execPath,
    });
    try {
      const { stdout } = await run(path.join(shimDir, 'tools'), [], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', PI_TOOLCLI_TOKEN: 'wrong' },
        timeout: 15_000,
      }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? String(e) }));
      expect(stdout).toContain('unauthorized');
    } finally {
      handle.dispose();
    }
  });
});

describe('buildShim', () => {
  it('execs the app binary as node against the dispatcher', () => {
    const s = buildShim('/Applications/Bobble.app/Contents/MacOS/Bobble', '/tmp/d.js', 'media');
    expect(s.startsWith('#!/bin/sh')).toBe(true);
    expect(s).toContain('ELECTRON_RUN_AS_NODE=1');
    // The command name is passed as argv[0] of the dispatcher's own args, so one
    // dispatcher serves every command.
    expect(s).toContain('"/tmp/d.js" media "$@"');
  });
});
