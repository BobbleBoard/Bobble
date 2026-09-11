import { describe, expect, it } from 'vitest';
import { BASE_EXTENSION_PACKAGE_DIRS, extensionPackageDirs } from './extension-dirs';

describe('extensionPackageDirs (gen-tools flag gating)', () => {
  /*
   * gen-tools loads whether or not the generation experiment is on: the
   * OmniSVG connector's `svg` tool lives in it, and a default build has to be
   * able to offer that after a download. What keeps the default model surface
   * clean moved INSIDE the extension — the media tools register only under
   * PI_DESKTOP_GEN_MEDIA, `svg` only under PI_OMNISVG_READY.
   */
  it('loads gen-tools even with the generation flag off (the tools inside are gated)', () => {
    const dirs = extensionPackageDirs(false);
    expect(dirs).toContain('gen-tools');
    expect(dirs.slice(0, -1)).toEqual(BASE_EXTENSION_PACKAGE_DIRS);
  });

  it('APPENDS gen-tools when the generation flag is on', () => {
    const dirs = extensionPackageDirs(true);
    expect(dirs).toContain('gen-tools');
    expect(dirs.at(-1)).toBe('gen-tools');
    // Additive: every base extension is still present, in order.
    expect(dirs.slice(0, BASE_EXTENSION_PACKAGE_DIRS.length)).toEqual([
      ...BASE_EXTENSION_PACKAGE_DIRS,
    ]);
  });

  it('base list carries the always-on providers/tools', () => {
    expect(BASE_EXTENSION_PACKAGE_DIRS).toContain('provider-llamacpp');
    expect(BASE_EXTENSION_PACKAGE_DIRS).toContain('web-tools');
    expect(BASE_EXTENSION_PACKAGE_DIRS).not.toContain('gen-tools');
  });
});
