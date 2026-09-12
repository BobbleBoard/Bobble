import { describe, expect, it } from 'vitest';
import { settingsWriteIsFenced } from './settings-main';

/**
 * A probe without its own HOME must not be able to write the person's
 * settings.json — SEEN twice (powerMode 'full' before the freeze; toolInterface
 * 'schemas' that made the shipped build look like CLI was not the default).
 */
describe('settingsWriteIsFenced', () => {
  const real = () => '/Users/person';
  it('is off outside PI_E2E', () => {
    expect(settingsWriteIsFenced({}, real, '/Users/person')).toBe(false);
  });
  it('refuses a PI_E2E run whose HOME is the real home', () => {
    expect(settingsWriteIsFenced({ PI_E2E: '1' }, real, '/Users/person')).toBe(true);
    expect(settingsWriteIsFenced({ PI_E2E: '1' }, real, '/Users/person/')).toBe(true);
  });
  it('lets a PI_E2E run with its own HOME write there', () => {
    expect(settingsWriteIsFenced({ PI_E2E: '1' }, real, '/tmp/pd-home-probe-x')).toBe(false);
  });
  it('never fences when the real home cannot be read', () => {
    expect(
      settingsWriteIsFenced(
        { PI_E2E: '1' },
        () => {
          throw new Error('no passwd entry');
        },
        '/Users/person',
      ),
    ).toBe(false);
  });
});
