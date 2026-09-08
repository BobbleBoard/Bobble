import { describe, expect, it } from 'vitest';
import { SHORT_DESCRIPTION_MAX, shortDescription } from './short-description';

describe('the one line each command gets in the prompt', () => {
  it('does not stop at an abbreviation', () => {
    // `mac key`'s real description begins "Press a key combo, e.g. cmd+s".
    // Split naively it ended at "e.g." and told the model nothing at all.
    expect(shortDescription('Press a key combo, e.g. cmd+s or ctrl+alt+delete.')).toContain(
      'cmd+s',
    );
    expect(shortDescription('Read it, i.e. the whole file. Then stop.')).toBe(
      'Read it, i.e. the whole file.',
    );
  });

  it('takes the first real sentence and no more', () => {
    expect(shortDescription('Do the thing. Then do another thing entirely.')).toBe('Do the thing.');
  });

  it('keeps a decimal intact', () => {
    expect(shortDescription('Render at 1.5x scale for print.')).toContain('1.5x');
  });

  it('does not break on a stop followed by a lower-case word', () => {
    expect(shortDescription('Trim to 0.5s. then encode')).toContain('then encode');
  });

  it('collapses the whitespace a multi-line description arrives with', () => {
    expect(shortDescription('Open a Mac app\n  IN THE BACKGROUND and take control.')).toBe(
      'Open a Mac app IN THE BACKGROUND and take control.',
    );
  });

  it('truncates rather than running away', () => {
    const long = shortDescription(`${'x'.repeat(300)}.`);
    expect(long.length).toBeLessThanOrEqual(SHORT_DESCRIPTION_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('says something for a tool with no description at all', () => {
    expect(shortDescription('   ')).toBe('no description');
  });
});
