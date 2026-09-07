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
import {
  buildDecoy,
  buildShim,
  dispatchToolCli,
  registerToolCli,
  type ToolCliHost,
} from './tool-cli-bridge';

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

describe('installing must not touch the live registry', () => {
  /*
   * THE REGRESSION THAT COST THE WHOLE EXTENSION.
   *
   * `registerToolCli` used to call `host.tools()` while naming its shims, and
   * in the app that closure is `pi.getAllTools()` — an ACTION METHOD. Install
   * happens inside `activate()`, and pi refuses to load an extension that calls
   * one at load time: "Extension runtime not initialized". The harness never
   * registered, every hook it owns died with it, and the only symptom the user
   * saw was `write EPIPE` on their next message.
   *
   * The command names come from the capability GROUPS, which are static data.
   */
  it('never calls tools() during registration', () => {
    let toolsCalls = 0;
    const shimDir = mkdtempSync(path.join(tmpdir(), 'toolcli-lazy-'));
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const handle = registerToolCli(
      {
        tools: () => {
          toolsCalls += 1;
          return TOOLS;
        },
        groups: () => GROUPS,
        call: async (name) => ({ text: `${name} ran`, isError: false }),
      },
      { shimDir, socketPath: path.join(shimDir, 's.sock'), env },
    );
    try {
      expect(toolsCalls).toBe(0);
      // …and the shims still exist, named from the groups alone.
      expect(handle.commands).toEqual(['tools', 'media']);
    } finally {
      handle.dispose();
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('a group with nothing registered still answers, from the live registry', async () => {
    // The filtering that used to happen at install now happens per request,
    // where asking the registry is legal.
    const empty: ToolCliHost = {
      tools: () => [],
      groups: () => GROUPS,
      call: async (name) => ({ text: `${name} ran`, isError: false }),
    };
    const r = await dispatchToolCli(empty, ['media']);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no such command');
  });
});

describe('the shadowed media tools', () => {
  /*
   * MEASURED in the app with `bash` as the only tool: asked for a picture the
   * model wrote its own PNG; asked for a door slam it synthesised a 0.1s noise
   * burst. It never ran `media`. A CLI mode hands the model a real Unix box, and
   * a real Unix box is a competing implementation of everything we offer.
   */
  it('names the command to use instead, and fails', () => {
    const s = buildDecoy('ffmpeg', 'media');
    expect(s).toContain('ffmpeg is not how this app makes media');
    expect(s).toContain('Use: media');
    // 127 = "command not found", which is what it effectively is here.
    expect(s).toContain('exit 127');
  });

  it('is installed beside the real commands', () => {
    const shimDir = mkdtempSync(path.join(tmpdir(), 'toolcli-decoy-'));
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const handle = registerToolCli(host(), {
      shimDir,
      socketPath: path.join(shimDir, 's.sock'),
      env,
    });
    try {
      const written = readdirSync(shimDir);
      expect(written).toContain('say');
      expect(written).toContain('media');
      /*
       * ffmpeg is NOT shadowed. It was, pointing at `media` — but no transcode,
       * trim or concat command exists, so a legitimate ffmpeg job was not
       * redirected, it was blocked, and the redirect named a command that could
       * not do the work. A signpost is only better than a dead end when it
       * points somewhere.
       */
      expect(written).not.toContain('ffmpeg');
      expect(written).not.toContain('convert');
      // …but a general-purpose interpreter is NOT shadowed: it has real work to
      // do, and a shell that lies about its own contents breaks that work.
      expect(written).not.toContain('python3');
      expect(written).not.toContain('node');
    } finally {
      handle.dispose();
      rmSync(shimDir, { recursive: true, force: true });
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

describe('the CLI never advertises what it cannot run', () => {
  /*
   * THE BUG A 21-AGENT AUDIT FOUND IN THE FIX FOR THE SAME BUG.
   *
   * The harness advertised its command surface from `pi.getAllTools()` — which
   * sees every extension — and executed through a registry that holds only its
   * own. `media generate image` was listed, documented by `--help`, and answered
   * "not registered in this build" when run. That is false availability, which
   * is the exact defect this mode was built to remove.
   *
   * The rule this pins: whatever `tools()` returns must be runnable by `call()`.
   */
  it('a command that resolves must be executable', async () => {
    const runnable = new Set(['generate_image']);
    const calls: string[] = [];
    const partial: ToolCliHost = {
      // The registry can only run one of the two; `tools()` must say so.
      tools: () => TOOLS.filter((t) => runnable.has(t.name)),
      groups: () => GROUPS,
      call: async (name) => {
        calls.push(name);
        if (!runnable.has(name)) return { text: `${name}: not registered`, isError: true };
        return { text: `${name} ran`, isError: false };
      },
    };

    // The runnable one works…
    expect(await dispatchToolCli(partial, ['media', 'generate', 'image', 'x'])).toEqual({
      text: 'generate_image ran',
      isError: false,
    });

    // …and the one that cannot run is not offered at all, rather than being
    // listed and then failing.
    const listed = await dispatchToolCli(partial, ['media']);
    expect(listed.text).not.toContain('generate sfx');
    const attempted = await dispatchToolCli(partial, ['media', 'generate', 'sfx', 'x']);
    expect(attempted.isError).toBe(true);
    expect(attempted.text).toContain('no such command');
    // It never reached execution, so it never produced "not registered".
    expect(calls).toEqual(['generate_image']);
  });
});
