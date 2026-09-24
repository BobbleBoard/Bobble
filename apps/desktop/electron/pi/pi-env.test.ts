import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  piEnvContributions,
  registerPiEnvContributor,
  resetPiEnvContributorsForTests,
} from './pi-env';

afterEach(() => resetPiEnvContributorsForTests());

describe('pi env contributors', () => {
  it('contribute nothing — and cost nothing — until a feature registers one', () => {
    expect(piEnvContributions({ cwd: '/w' })).toEqual({});
  });

  it('see the spawn cwd, apply in registration order, and unregister', () => {
    registerPiEnvContributor(({ cwd }) => ({
      PI_DESKTOP_MEMORY_FILE: `${cwd}/memory.json`,
      X: 'a',
    }));
    const off = registerPiEnvContributor(() => ({ X: 'b' }));
    expect(piEnvContributions({ cwd: '/w' })).toEqual({
      PI_DESKTOP_MEMORY_FILE: '/w/memory.json',
      X: 'b',
    });
    off();
    expect(piEnvContributions({ cwd: '/w' }).X).toBe('a');
  });

  it('a contributor that throws is reported and skipped; the rest still apply', () => {
    const onError = vi.fn();
    registerPiEnvContributor(() => {
      throw new Error('feature bug');
    });
    registerPiEnvContributor(() => ({ SHELL: '/bin/bash' }));
    expect(piEnvContributions({ cwd: undefined }, onError)).toEqual({ SHELL: '/bin/bash' });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('cannot override a key the app sets itself — the spread order buildPiEnv uses', () => {
    registerPiEnvContributor(() => ({ PI_DESKTOP_FS_FENCE: '0', PATH: '/custom/bin' }));
    // pi-main: { ...process.env, ...contributions, <the app's own keys> }
    const env = {
      ...{ PATH: '/usr/bin', HOME: '/h' },
      ...piEnvContributions({ cwd: '/w' }),
      PI_DESKTOP_FS_FENCE: '1',
    };
    expect(env.PI_DESKTOP_FS_FENCE).toBe('1');
    expect(env.PATH).toBe('/custom/bin');
    expect(env.HOME).toBe('/h');
  });
});
