import { describe, expect, it } from 'vitest';
import { ChartDataError, parseNumber, parseNumberList } from './numbers.ts';

describe('parseNumber — every way a model writes one number', () => {
  it.each([
    ['22M', 22_000_000],
    ['$38k', 38_000],
    ['1.2B', 1_200_000_000],
    ['3bn', 3_000_000_000],
    ['$24,000', 24_000],
    ['3,100', 3_100],
    ['1,234,567.5', 1_234_567.5],
    ['12 million', 12_000_000],
    ['€4.5m', 4_500_000],
    ['1.2e6', 1_200_000],
    ['-4', -4],
    ['−4', -4],
    ['(5)', -5],
    ['$-5', -5],
    ['+7', 7],
    ['.5', 0.5],
    ['0', 0],
  ])('%s → %d', (text, value) => {
    expect(parseNumber(text)?.value).toBe(value);
  });

  it('keeps what was written around the number: the currency, the percent, a unit word', () => {
    expect(parseNumber('$1.2M')).toEqual({ value: 1_200_000, currency: '$' });
    expect(parseNumber('5€')).toEqual({ value: 5, currency: '€' });
    expect(parseNumber('12.5%')).toEqual({ value: 12.5, percent: true });
    expect(parseNumber('12 GW')).toEqual({ value: 12, unitWord: 'GW' });
    expect(parseNumber('3 units')).toEqual({ value: 3, unitWord: 'units' });
    expect(parseNumber('2.4 million users')).toEqual({ value: 2_400_000, unitWord: 'users' });
  });

  it('is not fooled into a number', () => {
    for (const t of ['', 'abc', '$', '1.2.3', '1,23', 'twelve', '--']) {
      expect(parseNumber(t), t).toBeNull();
    }
    expect(parseNumber(Number.NaN)).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
});

describe('parseNumberList — the list, counted against the labels', () => {
  it('"22M, 3,100" with two labels is 22,000,000 and 3,100 (it drew Market 3, Today 100)', () => {
    expect(parseNumberList('22M, 3,100', 2)).toEqual({ values: [22_000_000, 3_100] });
    // …and with no labels to count against, the thousands reading still wins.
    expect(parseNumberList('22M, 3,100').values).toEqual([22_000_000, 3_100]);
  });

  it('"$1.2M, $2.4M" is 1.2e6 and 2.4e6 in dollars (it was refused as "needs its data")', () => {
    expect(parseNumberList('$1.2M, $2.4M', 2)).toEqual({
      values: [1_200_000, 2_400_000],
      unit: '$',
    });
    expect(parseNumberList('12%, 30%').unit).toBe('%');
    expect(parseNumberList('12 GW, 19 GW').unit).toBe('GW');
    expect(parseNumberList('$12, 30').unit).toBeUndefined(); // not every value says it
  });

  it('commas without spaces are separators when that is what fits the labels', () => {
    expect(parseNumberList('12,19,15,22', 4).values).toEqual([12, 19, 15, 22]);
    expect(parseNumberList('100,150,120,180,200', 5).values).toEqual([100, 150, 120, 180, 200]);
    expect(parseNumberList('45000,52000,48000', 3).values).toEqual([45_000, 52_000, 48_000]);
    expect(parseNumberList('1,200, 3,400', 2).values).toEqual([1_200, 3_400]);
  });

  it('other separators: semicolons, newlines, runs of spaces, spaces between numbers', () => {
    expect(parseNumberList('1; 2; 3').values).toEqual([1, 2, 3]);
    expect(parseNumberList('1\n2\n3').values).toEqual([1, 2, 3]);
    expect(parseNumberList('12k 19k 27k').values).toEqual([12_000, 19_000, 27_000]);
    expect(parseNumberList('4 8 12').values).toEqual([4, 8, 12]);
  });

  it('takes a list as it came — numbers or strings', () => {
    expect(parseNumberList([48, 61, 79]).values).toEqual([48, 61, 79]);
    expect(parseNumberList(['22M', '3,100', '$5'], 3).values).toEqual([22_000_000, 3_100, 5]);
  });

  it('a token that is not a number is named, with the forms that work — never dropped', () => {
    expect(() => parseNumberList('12, abc, 15', 3)).toThrow(ChartDataError);
    expect(() => parseNumberList('12, abc, 15', 3)).toThrow(
      /could not read "abc" \(value 2 of 3\) as a number: a value may be written 3100, 3,100, 22M, \$1\.2M/,
    );
    expect(() => parseNumberList(['12', 'n/a'])).toThrow(/"n\/a" \(value 2 of 2\)/);
  });

  it('a list that reads two ways, neither of them one value per label, says so', () => {
    expect(() => parseNumberList('3,100, 4,200', 3)).toThrow(
      /with the commas as thousands it is 2 values, as separators 4, and there are 3 labels/,
    );
  });
});
