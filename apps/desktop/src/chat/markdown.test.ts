import { describe, expect, it } from 'vitest';
import { localImagePath } from './markdown';

describe('localImagePath', () => {
  const cwd = '/Users/j/Bobble';
  it('takes an absolute path as the model writes it', () => {
    expect(localImagePath('/Users/j/Bobble/generated/heart/01.svg', cwd)).toBe(
      '/Users/j/Bobble/generated/heart/01.svg',
    );
  });
  it('unwraps a file:// URL, decoding what the model encoded', () => {
    expect(localImagePath('file:///Users/j/My%20Pics/a.png', cwd)).toBe('/Users/j/My Pics/a.png');
  });
  it('resolves a relative path against the session folder', () => {
    expect(localImagePath('generated/heart/01.svg', cwd)).toBe(
      '/Users/j/Bobble/generated/heart/01.svg',
    );
    expect(localImagePath('./out.png', `${cwd}/`)).toBe('/Users/j/Bobble/out.png');
  });
  it('leaves the web alone', () => {
    expect(localImagePath('https://example.com/a.png', cwd)).toBeNull();
    expect(localImagePath('data:image/png;base64,AAAA', cwd)).toBeNull();
    expect(localImagePath('//cdn.example.com/a.png', cwd)).toBeNull();
  });
  it('cannot place a relative path without a session folder', () => {
    expect(localImagePath('out.png', undefined)).toBeNull();
  });
});
