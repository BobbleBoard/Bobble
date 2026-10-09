import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { userLaunchEnv } from './launch-env';

describe("a user's own app is launched into the USER's home", () => {
  /*
   * The failure this exists for reached the user's screen: a throwaway HOME leaked
   * into Chrome, which came up with no profile and no keychain — the profile
   * picker and a keychain alert, and a run that drove a blank Chrome that was
   * not their. $HOME is whatever this process was handed; the password database
   * is the user's actual home.
   */
  it('uses the password-database home, not $HOME', () => {
    const out = userLaunchEnv({ HOME: '/tmp/some-throwaway-home' });
    expect(out.HOME).toBe(userInfo().homedir);
    expect(out.HOME).not.toBe('/tmp/some-throwaway-home');
  });

  it('passes the rest of the environment through untouched', () => {
    const out = userLaunchEnv({ HOME: '/tmp/x', PI_TEST_MARKER: 'kept' });
    expect(out.PI_TEST_MARKER).toBe('kept');
  });

  it('does not mutate the environment it was given', () => {
    const src = { HOME: '/tmp/x' };
    userLaunchEnv(src);
    expect(src.HOME).toBe('/tmp/x');
  });
});
