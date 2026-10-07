import { describe, expect, it } from 'vitest';
import { missingRuntimeMessage, resolveServerCommand } from './resolve-command';

const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const at = (...files: string[]) => ({
  exists: (f: string) => files.includes(f),
  home: '/Users/p',
  listDir: () => [],
});

describe('resolveServerCommand — a Bobble opened from the Finder', () => {
  it('finds npx in Homebrew and puts that folder in front of the server PATH', async () => {
    const r = await resolveServerCommand(
      'npx',
      ['-y', '@x/server'],
      FINDER_PATH,
      at('/opt/homebrew/bin/npx'),
    );
    expect(r).toEqual({
      command: '/opt/homebrew/bin/npx',
      args: ['-y', '@x/server'],
      pathPrefix: ['/opt/homebrew/bin'],
    });
  });

  it('uses what is already on PATH as it is', async () => {
    const r = await resolveServerCommand(
      'uvx',
      ['t'],
      '/a:/b',
      at('/b/uvx', '/Users/p/.local/bin/uvx'),
    );
    expect(r).toEqual({ command: '/b/uvx', args: ['t'], pathPrefix: [] });
  });

  it('finds uvx in ~/.local/bin, and the newest nvm Node', async () => {
    expect(
      (await resolveServerCommand('uvx', [], FINDER_PATH, at('/Users/p/.local/bin/uvx'))).command,
    ).toBe('/Users/p/.local/bin/uvx');
    const nvm = {
      exists: (f: string) => f === '/Users/p/.nvm/versions/node/v22.11.0/bin/npx',
      home: '/Users/p',
      listDir: () => ['v18.20.1', 'v22.11.0', 'v20.3.0'],
    };
    expect((await resolveServerCommand('npx', [], FINDER_PATH, nvm)).command).toBe(
      '/Users/p/.nvm/versions/node/v22.11.0/bin/npx',
    );
  });

  it('runs a missing uvx through the app’s own uv', async () => {
    const r = await resolveServerCommand('uvx', ['mcp-server-time'], FINDER_PATH, {
      ...at(),
      ensureUv: async () => '/Users/p/.cache/bobble/uv/0.9/uv',
    });
    expect(r).toEqual({
      command: '/Users/p/.cache/bobble/uv/0.9/uv',
      args: ['tool', 'run', 'mcp-server-time'],
      pathPrefix: ['/Users/p/.cache/bobble/uv/0.9'],
    });
  });

  it('says plainly when the runtime is not on this Mac', async () => {
    await expect(resolveServerCommand('npx', [], FINDER_PATH, at())).rejects.toThrow(
      /runs on Node\.js .* isn't installed on this Mac/,
    );
    expect(missingRuntimeMessage('docker')).toMatch(/Docker/);
  });

  it('leaves a path alone', async () => {
    expect(await resolveServerCommand('/x/server', ['a'], FINDER_PATH, at())).toEqual({
      command: '/x/server',
      args: ['a'],
      pathPrefix: [],
    });
  });
});
