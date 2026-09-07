import { describe, expect, it } from 'vitest';
import { detectToken } from './tokens';

describe('detectToken', () => {
  it('finds a command at the start of the line', () => {
    expect(detectToken('/mod')).toEqual({ mode: 'slash', query: 'mod', tokenStart: 0 });
    expect(detectToken('one line\n/mod')).toMatchObject({ mode: 'slash', query: 'mod' });
  });

  it('finds a mention anywhere at a word boundary', () => {
    expect(detectToken('look at @src/f')).toMatchObject({ mode: 'mention', query: 'src/f' });
    expect(detectToken('@a')).toMatchObject({ mode: 'mention', query: 'a' });
  });

  /*
   * THE CASE THAT SENT ME BACK HERE. A `/` only counted at the start of a line,
   * so "check /gmail for the receipt" offered nothing — and the user asked for
   * exactly that reference: "/gmail … should just change to the blue thing with
   * the icon".
   */
  it('finds a connector reference mid-sentence', () => {
    expect(detectToken('check /gm')).toEqual({ mode: 'connector', query: 'gm', tokenStart: 6 });
    expect(detectToken('a long run of words before it /notion')).toMatchObject({
      mode: 'connector',
      query: 'notion',
    });
  });

  it('leaves a bare / at the start to the command list', () => {
    expect(detectToken('/gm').mode).toBe('slash');
  });

  /* A path is not a reference — otherwise typing about a folder opens a menu. */
  it('ignores a slash inside a word', () => {
    expect(detectToken('open src/utils').mode).toBe(null);
    expect(detectToken('either/or').mode).toBe(null);
    expect(detectToken('https://example').mode).toBe(null);
  });

  it('reports where the trigger is, so it can be replaced in place', () => {
    const t = detectToken('check /gm');
    expect('check /gm'.slice(t.tokenStart)).toBe('/gm');
  });

  it('says nothing about ordinary prose', () => {
    expect(detectToken('just some words').mode).toBe(null);
    expect(detectToken('').mode).toBe(null);
  });
});
