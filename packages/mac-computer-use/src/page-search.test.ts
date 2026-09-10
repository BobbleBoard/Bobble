import { describe, expect, it } from 'vitest';
import { nearMissNote, type PageLine, searchPage } from './page-search';

const PAGE: PageLine[] = [
  { text: 'iPhone Duo', index: 1 },
  { text: 'Buy from $3199 or $133.29/mo. for 24 mo.', index: 2 },
  { text: '1TB', index: 3 },
  { text: '2TB', index: 4 },
  { text: 'Add to Bag', index: 5 },
  { text: 'Free shipping', index: 6 },
  { text: 'Not sure how much storage to get?', index: 7 },
];

describe('finding something on a page', () => {
  it('puts an exact match first, which is what find has always meant', () => {
    const hits = searchPage(PAGE, '2TB');
    expect(hits[0]?.text).toBe('2TB');
    expect(hits[0]?.exact).toBe(true);
  });

  /* Same words, different order — no substring to find, but unmistakably the
     line the model meant. */
  it('still answers when the words are there but not in that order', () => {
    const hits = searchPage(PAGE, 'storage much');
    expect(hits[0]?.text).toContain('storage');
    expect(hits[0]?.exact).toBe(false);
  });

  /* A page always has SOME line sharing a word; returning it would be worse
     than saying nothing, because the model would act on it. */
  it('says nothing rather than offering a weak match', () => {
    expect(searchPage(PAGE, 'checkout')).toEqual([]);
  });

  it('is honest that a near miss is a near miss', () => {
    const hits = searchPage(PAGE, 'storage much');
    expect(nearMissNote('storage much', hits)).toContain('nothing contains');
    expect(nearMissNote('2TB', searchPage(PAGE, '2TB'))).toBe('');
  });

  it('ignores an empty query instead of matching everything', () => {
    expect(searchPage(PAGE, '   ')).toEqual([]);
  });

  /* The honest limit, written down: token overlap cannot cross a synonym.
     "checkout" vs "Add to Bag" is the case that would justify an embedding
     model, and it is the case this scorer provably does not solve. */
  it('cannot do synonyms, and the test says so', () => {
    expect(searchPage(PAGE, 'checkout').length).toBe(0);
    expect(searchPage(PAGE, 'bag')[0]?.text).toBe('Add to Bag');
  });
});
