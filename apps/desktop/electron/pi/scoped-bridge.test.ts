import { describe, expect, it } from 'vitest';
import { SCOPED_PI_ARGS, scopedPiBridgeOptions } from './scoped-bridge';

const base = {
  cwd: '/Users/p/Bobble/chat',
  env: { PATH: '/usr/bin', PI_DESKTOP_TOOL_CLI: '1', PI_DESKTOP_FS_FENCE: '1' },
  extensionPaths: ['/app/harness/src/index.ts', '/app/web-tools/src/index.ts'],
  killGraceMs: 1500,
  appRoot: '/app',
};

/*
 * `createChildBridge` and `createScheduledRunBridge` used to spell these
 * options out by hand. The literals below are what they built before the
 * extraction (pi-main.ts at 6eb58aaf); the scoped builder must reproduce them
 * exactly, so the extraction changed nothing a child or a scheduled run sees.
 */
describe('scopedPiBridgeOptions', () => {
  it('builds exactly what createChildBridge built', () => {
    const childEnv = {
      PI_DESKTOP_SUBAGENT_DEPTH: '1',
      PI_DESKTOP_AGENT_ID: 'child-7',
      PI_DESKTOP_SPECIALIST: 'image',
      PI_DESKTOP_TOOL_CLI: '0',
    };
    expect(scopedPiBridgeOptions(base, { env: childEnv })).toEqual({
      cwd: base.cwd,
      env: { ...base.env, ...childEnv },
      noSession: true,
      extensionPaths: base.extensionPaths,
      extraArgs: ['--no-extensions', '--no-skills'],
      killGraceMs: 1500,
      detached: true,
      appRoot: '/app',
    });
  });

  it('builds exactly what createScheduledRunBridge built', () => {
    const env = { PI_DESKTOP_FORBID_TOOLS: 'messages_send' };
    expect(scopedPiBridgeOptions(base, { env })).toEqual({
      cwd: base.cwd,
      env: { ...base.env, ...env },
      noSession: true,
      extensionPaths: base.extensionPaths,
      extraArgs: ['--no-extensions', '--no-skills'],
      killGraceMs: 1500,
      detached: true,
      appRoot: '/app',
    });
  });

  it('lets the scoped help pi bring its own extensions and resume its own session', () => {
    const opts = scopedPiBridgeOptions(base, {
      extensionPaths: ['/app/help-tools/src/index.ts'],
      sessionPath: '/h/.pi/desktop/help/threads/a.jsonl',
    });
    expect(opts.extensionPaths).toEqual(['/app/help-tools/src/index.ts']);
    expect(opts.sessionPath).toBe('/h/.pi/desktop/help/threads/a.jsonl');
    expect(opts.noSession).toBeUndefined();
    expect(opts.env).toEqual(base.env);
  });

  it('never shares its argument arrays with the caller', () => {
    const opts = scopedPiBridgeOptions(base);
    opts.extraArgs?.push('--x');
    opts.extensionPaths?.push('/y');
    expect(SCOPED_PI_ARGS).toEqual(['--no-extensions', '--no-skills']);
    expect(base.extensionPaths).toHaveLength(2);
  });
});
