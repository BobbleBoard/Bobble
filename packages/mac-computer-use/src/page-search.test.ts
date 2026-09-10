import { describe, expect, it } from 'vitest';
import { nearMissNote, type PageLine, searchPage, searchPageBoth } from './page-search';

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

describe('both searches, merged', () => {
  /* A stub embedder: two texts are "similar" when they share a topic word we
     control, so the merge logic is tested rather than a model. */
  const TOPICS = ['storage', 'bag', 'ship'];
  const embed = async (texts: readonly string[]) =>
    texts.map((t) => {
      const l = t.toLowerCase();
      const v = new Float32Array(TOPICS.length);
      TOPICS.forEach((topic, i) => {
        v[i] = l.includes(topic) ? 1 : 0;
      });
      /* "checkout" is a synonym for the bag line — the case keyword cannot do. */
      if (l.includes('checkout')) v[1] = 1;
      return v;
    });

  it('is honest when there is no embedder, rather than pretending', async () => {
    const r = await searchPageBoth(PAGE, '2TB');
    expect(r.semantic).toBe('unavailable');
    expect(r.hits[0]?.text).toBe('2TB');
  });

  /* THE case that justifies a model at all: "checkout" reaches "Add to Bag",
     which token overlap provably cannot. */
  it('finds a synonym the keyword search cannot', async () => {
    const plain = searchPage(PAGE, 'checkout');
    expect(plain).toEqual([]);
    const r = await searchPageBoth(PAGE, 'checkout', { embed });
    expect(r.semantic).toBe('used');
    expect(r.hits.map((h) => h.text)).toContain('Add to Bag');
  });

  it('lists a line both halves found ONCE, marked as agreed', async () => {
    const r = await searchPageBoth(PAGE, 'bag', { embed });
    const bag = r.hits.filter((h) => h.text === 'Add to Bag');
    expect(bag).toHaveLength(1);
    expect(bag[0]?.kind).toBe('both');
    expect(r.hits[0]?.text).toBe('Add to Bag');
  });

  it('bounds each half so a big page cannot flood the answer', async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ text: `storage row ${i}`, index: i + 1 }));
    const r = await searchPageBoth(big, 'storage', { embed, perKind: 10 });
    expect(r.hits.length).toBeLessThanOrEqual(20);
  });

  /* Half an answer beats an error: the keyword side already found something. */
  it('still answers when the embedder throws', async () => {
    const r = await searchPageBoth(PAGE, '2TB', {
      embed: async () => {
        throw new Error('embedding server is down');
      },
    });
    expect(r.semantic).toBe('failed');
    expect(r.hits[0]?.text).toBe('2TB');
  });
});
