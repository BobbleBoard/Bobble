import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * subscribeSettings — side effects subscribe to the part of the document they
 * care about (PLAN.md R6), and hear EVERY write: main's own and the renderer's
 * `settings:set`. settings-main resolves HOME at import, so the module is
 * loaded fresh under a throwaway one.
 */
const home = mkdtempSync(path.join(tmpdir(), 'pd-subscribe-settings-'));
type Main = typeof import('./settings-main');
let main: Main;

beforeAll(async () => {
  vi.stubEnv('HOME', home);
  vi.resetModules();
  main = await import('./settings-main');
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('subscribeSettings', () => {
  it('fires for a change under its prefix, after the write, with next and before', () => {
    const seen: Array<[boolean, boolean]> = [];
    const off = main.subscribeSettings('memory.enabled', (next, before) => {
      // The document is already on disk when a listener runs.
      const disk = JSON.parse(readFileSync(path.join(home, '.pi/desktop/settings.json'), 'utf8'));
      expect(disk.memory.enabled).toBe(next.memory.enabled);
      seen.push([before.memory.enabled, next.memory.enabled]);
    });
    main.writeSettingsPatch({ memory: { enabled: true } });
    main.writeSettingsPatch({ memory: { enabled: true } }); // no change: silent
    main.writeSettingsPatch({ effort: 'high' }); // elsewhere: silent
    main.writeSettingsPatch({ memory: { enabled: false } });
    off();
    main.writeSettingsPatch({ memory: { enabled: true } }); // unsubscribed
    expect(seen).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it('a group prefix hears any field of the group; the empty prefix hears everything', () => {
    const group = vi.fn();
    const all = vi.fn();
    const offGroup = main.subscribeSettings('capabilities', group);
    const offAll = main.subscribeSettings('', all);
    main.writeSettingsPatch({ capabilities: { training: true } });
    main.writeSettingsPatch({ iconScale: 1.1 });
    offGroup();
    offAll();
    expect(group).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('a listener that throws does not stop the others, nor the write', () => {
    const after = vi.fn();
    const offBad = main.subscribeSettings('design', () => {
      throw new Error('listener bug');
    });
    const offGood = main.subscribeSettings('design', after);
    const next = main.writeSettingsPatch({ design: { enabled: true } });
    offBad();
    offGood();
    expect(next.design.enabled).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    expect(main.readSettings().design.enabled).toBe(true);
  });

  it("hears the renderer's settings:set too", async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, fn: (event: unknown, request: unknown) => unknown) =>
        handlers.set(channel, fn),
      removeHandler: (channel: string) => handlers.delete(channel),
    };
    main.registerSettingsIpc(ipcMain as never, () => true);
    const heard = vi.fn();
    const off = main.subscribeSettings('devices', heard);
    await handlers.get('settings:set')?.({}, { patch: { devices: { enabled: true } } });
    off();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]?.[0].devices.enabled).toBe(true);
  });
});
