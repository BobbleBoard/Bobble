import { describe, expect, it } from 'vitest';
import { degenerateCommandRefusal, repeatedUnit } from './degenerate-command';

describe('a command that is one token repeated', () => {
  it('catches the one that cost a run 36 seconds', () => {
    expect(repeatedUnit('read'.repeat(40))).toBe('read');
    expect(degenerateCommandRefusal('read'.repeat(40))).toMatch(/"read" repeated 40 times/);
  });

  /* Refusing a real command is far worse than running a silly one, so the rule
     has to be provably narrow. */
  it('leaves ordinary commands alone', () => {
    for (const cmd of [
      'ls',
      'mac snapshot "Google Chrome"',
      'chrome tabs',
      'yes yes yes yes yes yes yes yes yes yes',
      'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'printf "%s" abcabcabcabcabcabcabcabcabc',
    ]) {
      expect(repeatedUnit(cmd), cmd).toBeNull();
    }
  });

  it('needs an EXACT tiling, not something that merely looks periodic', () => {
    expect(repeatedUnit(`${'abc'.repeat(20)}ab`)).toBeNull();
  });

  it('needs length: a short repeat is not evidence of anything', () => {
    expect(repeatedUnit('hihihihi')).toBeNull();
  });

  it('is not fooled by a base64-looking blob', () => {
    expect(repeatedUnit('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w')).toBeNull();
  });
});
