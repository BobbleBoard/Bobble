import { describe, expect, it } from 'vitest';
import { pathForModel, sayPath } from './workspace-relative.js';

const ROOT = '/Users/user/Bobble/show-me-how-svg-is-generlaly';

describe('pathForModel', () => {
  it('says a file inside the working folder relative to it', () => {
    expect(pathForModel(`${ROOT}/sample.svg`, ROOT)).toBe('sample.svg');
    expect(pathForModel(`${ROOT}/assets/logo.svg`, ROOT)).toBe('assets/logo.svg');
  });

  it('keeps the full path of a file the person named elsewhere', () => {
    expect(pathForModel('/Users/user/Desktop/brief.pdf', ROOT)).toBe(
      '/Users/user/Desktop/brief.pdf',
    );
  });

  it('is the path itself when there is no root to speak of', () => {
    expect(pathForModel(`${ROOT}/x.md`, null)).toBe(`${ROOT}/x.md`);
  });

  it('a sibling folder that merely shares the prefix is not inside', () => {
    expect(pathForModel(`${ROOT}-2/x.md`, ROOT)).toBe(`${ROOT}-2/x.md`);
  });
});

describe('sayPath', () => {
  it("rewrites pi's own success line", () => {
    expect(
      sayPath(`Successfully wrote 88 bytes to ${ROOT}/sample.svg`, `${ROOT}/sample.svg`, ROOT),
    ).toBe('Successfully wrote 88 bytes to sample.svg');
    expect(sayPath(`Successfully replaced 1 block(s) in ${ROOT}/a.ts.`, `${ROOT}/a.ts`, ROOT)).toBe(
      'Successfully replaced 1 block(s) in a.ts.',
    );
  });

  it('touches only the whole path, never a longer one it prefixes', () => {
    expect(sayPath(`see ${ROOT}/a.ts.bak and ${ROOT}/a.ts`, `${ROOT}/a.ts`, ROOT)).toBe(
      `see ${ROOT}/a.ts.bak and a.ts`,
    );
  });
});
