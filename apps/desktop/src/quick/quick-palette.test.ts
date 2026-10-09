// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { whenLabel } from './QuickHistory';
import { rankPaletteRows } from './QuickPalette';

const rows = [
  { section: 'Chats', label: 'Trip to Lisbon' },
  { section: 'Settings', label: 'Settings: Appearance' },
  { section: 'Ask about', label: 'An area of the screen' },
  { section: 'This panel', label: 'New thread' },
  { section: 'Studios', label: 'Make a picture in the Image studio' },
];

describe('rankPaletteRows', () => {
  it("with no query, groups rows in the panel's section order", () => {
    expect(rankPaletteRows(rows, '').map((r) => r.section)).toEqual([
      'Ask about',
      'This panel',
      'Chats',
      'Studios',
      'Settings',
    ]);
  });

  it('with a query, the best match leads — initials count', () => {
    expect(rankPaletteRows(rows, 'nt')[0]?.label).toBe('New thread');
    expect(rankPaletteRows(rows, 'area')[0]?.label).toBe('An area of the screen');
    expect(rankPaletteRows(rows, 'lisb')[0]?.label).toBe('Trip to Lisbon');
    expect(rankPaletteRows(rows, 'zzz')).toEqual([]);
  });
});

describe('whenLabel', () => {
  const now = 1_000_000_000_000;
  it('says when in the words a person uses', () => {
    expect(whenLabel(now - 10_000, now)).toBe('just now');
    expect(whenLabel(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(whenLabel(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(whenLabel(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(whenLabel(now - 5 * 86_400_000, now)).toBe('5 days ago');
  });
});
