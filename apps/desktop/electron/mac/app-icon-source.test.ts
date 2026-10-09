import { describe, expect, it, vi } from 'vitest';
import { APP_ICON_MISS_MS, createAppIconSource } from './app-icon-source';

const PNG = 'aWNvbg==';

function source(opts: {
  helper?: (app: string) => Promise<{ base64?: string; mimeType?: string }>;
  installed?: (app: string) => Promise<string | null>;
  clock?: { t: number };
}) {
  const helperIcon = vi.fn(
    opts.helper ??
      (async () => {
        throw new Error('no icon for that app');
      }),
  );
  const installedIcon = vi.fn(opts.installed ?? (async () => null));
  const clock = opts.clock ?? { t: 0 };
  const icon = createAppIconSource({ helperIcon, installedIcon, now: () => clock.t });
  return { icon, helperIcon, installedIcon, clock };
}

describe("main's per-app icon lookup", () => {
  it("hands back the running helper's answer as a data URL", async () => {
    const { icon, installedIcon } = source({
      helper: async () => ({ base64: PNG, mimeType: 'image/png' }),
    });
    expect(await icon('Safari')).toBe(`data:image/png;base64,${PNG}`);
    expect(installedIcon).not.toHaveBeenCalled();
  });

  it('asks the helper once per app — case and padding are the same app', async () => {
    const { icon, helperIcon } = source({ helper: async () => ({ base64: PNG }) });
    const [a, b] = await Promise.all([icon('Safari'), icon('Safari')]);
    expect(await icon(' safari ')).toBe(a);
    expect(a).toBe(b);
    expect(helperIcon).toHaveBeenCalledTimes(1);
    expect(helperIcon).toHaveBeenCalledWith('Safari');
  });

  it('falls back to the installed app when the helper cannot place the name', async () => {
    const { icon, installedIcon } = source({
      installed: async (app) => (app === 'chrome' ? 'data:image/png;base64,Y2hyb21l' : null),
    });
    expect(await icon('chrome')).toBe('data:image/png;base64,Y2hyb21l');
    expect(installedIcon).toHaveBeenCalledWith('chrome');
  });

  it('treats an empty helper answer as none and tries the installed app', async () => {
    const { icon, installedIcon } = source({
      helper: async () => ({}),
      installed: async () => 'data:image/png;base64,eA==',
    });
    expect(await icon('Notes')).toBe('data:image/png;base64,eA==');
    expect(installedIcon).toHaveBeenCalledTimes(1);
  });

  it('keeps a miss for a while, then asks again', async () => {
    const clock = { t: 1_000 };
    const { icon, helperIcon, installedIcon } = source({ clock });
    expect(await icon('Not Installed Yet')).toBeNull();
    clock.t += APP_ICON_MISS_MS - 1;
    expect(await icon('Not Installed Yet')).toBeNull();
    expect(helperIcon).toHaveBeenCalledTimes(1);
    expect(installedIcon).toHaveBeenCalledTimes(1);
    clock.t += 2;
    expect(await icon('Not Installed Yet')).toBeNull();
    expect(helperIcon).toHaveBeenCalledTimes(2);
  });

  it('keeps a found icon for good', async () => {
    const clock = { t: 0 };
    const { icon, helperIcon } = source({ clock, helper: async () => ({ base64: PNG }) });
    await icon('Finder');
    clock.t += APP_ICON_MISS_MS * 100;
    await icon('Finder');
    expect(helperIcon).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when both lookups do', async () => {
    const { icon } = source({
      installed: async () => {
        throw new Error('list failed');
      },
    });
    expect(await icon('TextEdit')).toBeNull();
  });

  it('asks nothing for an empty or absurd name', async () => {
    const { icon, helperIcon, installedIcon } = source({});
    expect(await icon('')).toBeNull();
    expect(await icon('   ')).toBeNull();
    expect(await icon('x'.repeat(1000))).toBeNull();
    expect(helperIcon).not.toHaveBeenCalled();
    expect(installedIcon).not.toHaveBeenCalled();
  });
});
