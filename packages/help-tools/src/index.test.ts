import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as entry from './index.ts';

/*
 * The skeleton's contract: the package resolves under its own name and its
 * entry point loads. It holds until the owning lane replaces it with real tests.
 */
describe('@pi-desktop/help-tools', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('is the package its directory says it is', () => {
    expect(manifest.name).toBe('@pi-desktop/help-tools');
  });

  it('points its export at a file that exists, and that file loads', () => {
    expect(existsSync(new URL(`../${manifest.exports['.']}`, import.meta.url))).toBe(true);
    expect(typeof entry).toBe('object');
  });
});
