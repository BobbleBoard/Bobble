/**
 * b12: the palette's ranking.
 *
 * One list, ranked together — a person typing "sett" does not first decide
 * which category "Settings" lives in. Deliberately not fuzzy-with-a-library:
 * the corpus is a few hundred short labels, and initials are what people
 * actually type.
 */
import { describe, expect, it } from 'vitest';
import { paletteScore, rankRows } from './CommandPalette';

const rows = [
  { id: 'a', label: 'New chat', section: 'Actions' as const, run: () => {} },
  { id: 'b', label: 'Settings', section: 'Actions' as const, run: () => {} },
  { id: 'c', label: 'Model management', section: 'Actions' as const, run: () => {} },
  {
    id: 'd',
    label: 'set up the release build',
    subtitle: '~/work',
    section: 'Chats' as const,
    run: () => {},
  },
  {
    id: 'e',
    label: '/compact',
    subtitle: 'Summarise',
    section: 'Commands' as const,
    run: () => {},
  },
];
const first = (q: string) => rankRows(rows, q)[0]?.label;

describe('paletteScore', () => {
  it('prefers an exact label over anything else', () => {
    expect(paletteScore('Settings', 'settings')).toBeGreaterThan(paletteScore('Settings', 'sett'));
  });

  it('matches initials, which is what people type', () => {
    expect(paletteScore('New chat', 'nc')).toBeGreaterThan(0);
    expect(paletteScore('Model management', 'mm')).toBeGreaterThan(0);
  });

  it('scores a subsequence by how tightly it sits', () => {
    const tight = paletteScore('abcdef', 'abc');
    const loose = paletteScore('axxxbxxxc', 'abc');
    expect(tight).toBeGreaterThan(loose);
  });

  it('returns 0 when a letter is missing', () => {
    expect(paletteScore('Settings', 'zq')).toBe(0);
  });

  it('matches everything on an empty query', () => {
    expect(paletteScore('anything', '')).toBe(1);
  });
});

describe('rankRows', () => {
  it('ranks across sections, not within them', () => {
    // "set up the release build" is a CHAT and must be able to beat an action.
    expect(first('set up')).toBe('set up the release build');
    expect(first('sett')).toBe('Settings');
  });

  it('finds a command by its slash name', () => {
    expect(first('/comp')).toBe('/compact');
  });

  it('searches the subtitle too', () => {
    expect(rankRows(rows, 'summarise').map((r) => r.label)).toContain('/compact');
  });

  it('drops what does not match rather than showing everything', () => {
    expect(rankRows(rows, 'zzzz')).toHaveLength(0);
  });

  it('honours the limit', () => {
    expect(rankRows(rows, '', 2)).toHaveLength(2);
  });
});

describe('section grouping', () => {
  it('shows each section once, not interleaved', () => {
    // Ranking globally and rendering that order directly produced
    // CHATS, ACTIONS, CHATS, ACTIONS — unscannable, and it reads as a bug.
    const sections = rankRows(rows, '').map((r) => r.section);
    const seen = new Set();
    for (let i = 0; i < sections.length; i++) {
      if (sections[i] !== sections[i - 1]) {
        expect(seen.has(sections[i])).toBe(false);
        seen.add(sections[i]);
      }
    }
  });

  it('still puts the section holding the best match first', () => {
    expect(rankRows(rows, 'set up')[0]?.section).toBe('Chats');
    expect(rankRows(rows, 'sett')[0]?.section).toBe('Actions');
  });
});
