import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentPlatform, KitShapeError, normalizeKitHex, parseKit } from './schema.ts';

const paperTeal = JSON.parse(
  readFileSync(new URL('./kits/paper-teal.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/** A copy of a real kit with one path changed. */
function withChange(path: string[], value: unknown): unknown {
  const copy = structuredClone(paperTeal) as Record<string, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

function problem(raw: unknown): string {
  try {
    parseKit(raw);
  } catch (err) {
    if (err instanceof KitShapeError) return err.message;
    throw err;
  }
  return 'parsed';
}

describe('parseKit — a kit file that is not a kit says where', () => {
  it('reads a real kit', () => {
    expect(parseKit(paperTeal).id).toBe('paper-teal');
  });

  it('names a missing colour role, a lower-case hex and a colour that is not one', () => {
    expect(problem(withChange(['light', 'mute'], undefined))).toBe(
      'kit.light.mute: must be a colour written #RRGGBB (upper case)',
    );
    expect(problem(withChange(['dark', 'accent'], '#3bb3a9'))).toMatch(/^kit\.dark\.accent:/);
    expect(problem(withChange(['light', 'ink'], 'black'))).toMatch(/^kit\.light\.ink:/);
  });

  it('refuses a field it does not know — a misspelt role would be silently ignored', () => {
    expect(problem({ ...(paperTeal as object), colour: {} })).toBe(
      'kit.colour: is not a kit field',
    );
  });

  it('wants five to eight series colours', () => {
    expect(problem(withChange(['light', 'series'], ['#000000']))).toBe(
      'kit.light.series: must hold 5 to 8 colours',
    );
  });

  it('refuses a type scale that is not a scale (a title smaller than its body)', () => {
    expect(problem(withChange(['type', 'slide', 'title'], 12))).toBe(
      'kit.type.slide.title: must not be smaller than the step below',
    );
  });

  it('refuses an id that is not lowercase-hyphenated, and a knob outside its set', () => {
    expect(problem(withChange(['id'], 'Paper Teal'))).toMatch(/^kit\.id:/);
    expect(problem(withChange(['chart', 'grid'], 'checks'))).toBe(
      'kit.chart.grid: must be one of lines, dots, none',
    );
    expect(problem(withChange(['diagram', 'curve'], 'wiggly'))).toMatch(/^kit\.diagram\.curve:/);
  });
});

describe('normalizeKitHex', () => {
  it('reads the spellings a person writes, and nothing else', () => {
    expect(normalizeKitHex('#0f7b74')).toBe('#0F7B74');
    expect(normalizeKitHex('0F7B74')).toBe('#0F7B74');
    expect(normalizeKitHex('#abc')).toBe('#AABBCC');
    expect(normalizeKitHex('teal')).toBeUndefined();
    expect(normalizeKitHex(12)).toBeUndefined();
  });
});

describe('currentPlatform', () => {
  it('maps Node platforms onto a kit font stack key', () => {
    expect(currentPlatform('darwin')).toBe('mac');
    expect(currentPlatform('win32')).toBe('windows');
    expect(currentPlatform('linux')).toBe('linux');
  });
});
