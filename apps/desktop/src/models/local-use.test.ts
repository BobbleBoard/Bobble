import { describe, expect, it } from 'vitest';
import { type LocalEntry, pickLocalUse } from './local-use';

/**
 * unsloth/Qwen3.8-27B-GGUF as the catalog lists it once the hub has fetched it:
 * the curated entry (two files) and the entry hf:register made for the hub's own
 * download. Sizes are the listing's. `onDisk` is the supervisor's
 * `downloadedQuants`, which is all "on disk" means here.
 */
const REPO = 'unsloth/Qwen3.8-27B-GGUF';
const UD_Q3 = { quant: 'UD-Q3_K_XL', bytes: 13_146_393_504 };
const UD_Q2 = { quant: 'UD-Q2_K_XL', bytes: 9_828_981_664 };
const Q8 = { quant: 'Q8_0', bytes: 29_047_086_048 };
const curated = (...onDisk: string[]): LocalEntry => ({
  id: 'qwen3.8-27b-mtp',
  hfRepo: REPO,
  quants: [UD_Q3, UD_Q2],
  downloadedQuants: onDisk,
  source: 'curated',
});
const registered = (file: { quant: string; bytes: number }, onDisk = true): LocalEntry => ({
  id: `unsloth-qwen3-8-27b-gguf-${file.quant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  hfRepo: REPO,
  quants: [file],
  downloadedQuants: onDisk ? [file.quant] : [],
  source: 'hf',
});
/** Another model on disk, to show only this repo's files count. */
const ELSEWHERE: LocalEntry = {
  id: 'qwen3.5-9b-mtp',
  hfRepo: 'unsloth/Qwen3.5-9B-GGUF',
  quants: [{ quant: 'UD-Q4_K_XL', bytes: 5_970_000_000 }],
  downloadedQuants: ['UD-Q4_K_XL'],
  source: 'curated',
};

/** The hub's pick on the user's 24 GB Mac (hf-download.test.ts), and that machine. */
const PICK = 'UD-Q3_K_XL';
const MAC_24GB = { totalRamGB: 24 };

describe('pickLocalUse — what Top Recommended’s Use starts', () => {
  it('starts the hub’s own download when that is what is on disk — no download, no rung', () => {
    // Before: the first entry naming the repo (the curated one, not on disk) at
    // the recommender's Q3_K_M — `llm:download-model qwen3.8-27b-mtp · Q3_K_M`.
    const catalog = [curated(), registered(UD_Q3), ELSEWHERE];
    expect(pickLocalUse(catalog, REPO, { pick: PICK, fit: MAC_24GB })).toEqual({
      modelId: 'unsloth-qwen3-8-27b-gguf-ud-q3-k-xl',
      quant: 'UD-Q3_K_XL',
      bytes: UD_Q3.bytes,
    });
  });

  it('asks the curated entry for the file it has, never the rung the repo does not publish', () => {
    // Before: `llm:start-server qwen3.8-27b-mtp · Q3_K_M` → "unknown quant".
    expect(pickLocalUse([curated('UD-Q3_K_XL')], REPO, { pick: PICK, fit: MAC_24GB })).toEqual({
      modelId: 'qwen3.8-27b-mtp',
      quant: 'UD-Q3_K_XL',
      bytes: UD_Q3.bytes,
    });
  });

  it('prefers the curated entry when both hold the pick, whatever order the catalog is in', () => {
    const both = [curated('UD-Q3_K_XL'), registered(UD_Q3)];
    for (const catalog of [both, [...both].reverse()]) {
      expect(pickLocalUse(catalog, REPO, { pick: PICK, fit: MAC_24GB })).toMatchObject({
        modelId: 'qwen3.8-27b-mtp',
        quant: 'UD-Q3_K_XL',
      });
    }
  });

  it('starts the pick where it is, before another quant under the curated entry', () => {
    const catalog = [curated('UD-Q2_K_XL'), registered(UD_Q3)];
    expect(pickLocalUse(catalog, REPO, { pick: PICK, fit: MAC_24GB })).toMatchObject({
      modelId: 'unsloth-qwen3-8-27b-gguf-ud-q3-k-xl',
      quant: 'UD-Q3_K_XL',
    });
    // …and before a quant the ranking alone would prefer: the pick is the file
    // the card names, so it is the file the button starts.
    const smaller = [curated('UD-Q3_K_XL'), registered(UD_Q2)];
    expect(pickLocalUse(smaller, REPO, { fit: MAC_24GB })?.quant).toBe('UD-Q3_K_XL');
    expect(pickLocalUse(smaller, REPO, { pick: 'UD-Q2_K_XL', fit: MAC_24GB })).toMatchObject({
      modelId: 'unsloth-qwen3-8-27b-gguf-ud-q2-k-xl',
      quant: 'UD-Q2_K_XL',
    });
  });

  it('with the pick not on disk, starts the best of what is — for this machine', () => {
    // The lone file there is the one it starts, pick or not.
    expect(pickLocalUse([curated('UD-Q2_K_XL')], REPO, { pick: PICK, fit: MAC_24GB })).toEqual({
      modelId: 'qwen3.8-27b-mtp',
      quant: 'UD-Q2_K_XL',
      bytes: UD_Q2.bytes,
    });
    // A 29 GB Q8_0 beside it cannot load on 24 GB, and can on 64.
    const catalog = [curated('UD-Q2_K_XL'), registered(Q8)];
    expect(pickLocalUse(catalog, REPO, { pick: PICK, fit: MAC_24GB })?.quant).toBe('UD-Q2_K_XL');
    expect(pickLocalUse(catalog, REPO, { pick: PICK, fit: { totalRamGB: 64 } })?.quant).toBe(
      'Q8_0',
    );
  });

  it('with no pick yet (the listing unread), still only what is on disk', () => {
    expect(
      pickLocalUse([curated('UD-Q3_K_XL', 'UD-Q2_K_XL')], REPO, { fit: MAC_24GB }),
    ).toMatchObject({ modelId: 'qwen3.8-27b-mtp', quant: 'UD-Q3_K_XL' });
  });

  it('finds nothing when nothing of the repo is on disk — another model’s files do not count', () => {
    expect(pickLocalUse([curated(), registered(UD_Q3, false), ELSEWHERE], REPO)).toBeUndefined();
    expect(pickLocalUse([], REPO)).toBeUndefined();
  });

  it('always names an entry of the repo and a quant that entry holds on disk', () => {
    const subsets = [[], ['UD-Q3_K_XL'], ['UD-Q2_K_XL'], ['UD-Q3_K_XL', 'UD-Q2_K_XL']];
    for (const curatedOnDisk of subsets) {
      for (const hub of [[], [UD_Q3], [Q8], [UD_Q2, Q8]]) {
        const catalog = [
          ELSEWHERE,
          curated(...curatedOnDisk),
          ...hub.map((file) => registered(file)),
        ];
        for (const pick of [undefined, 'UD-Q3_K_XL', 'Q3_K_M']) {
          for (const totalRamGB of [0, 16, 24, 64]) {
            const use = pickLocalUse(catalog, REPO, {
              ...(pick === undefined ? {} : { pick }),
              fit: { totalRamGB },
            });
            const held = catalog.filter(
              (e) => e.hfRepo === REPO && (e.downloadedQuants ?? []).length > 0,
            );
            if (held.length === 0) {
              expect(use).toBeUndefined();
              continue;
            }
            const entry = catalog.find((e) => e.id === use?.modelId);
            expect(entry?.hfRepo).toBe(REPO);
            expect(entry?.downloadedQuants).toContain(use?.quant);
            expect(use?.bytes).toBe(entry?.quants.find((q) => q.quant === use?.quant)?.bytes);
            // The pick, whenever any entry holds it; the rung (Q3_K_M) never.
            if (pick !== undefined && held.some((e) => e.downloadedQuants?.includes(pick))) {
              expect(use?.quant).toBe(pick);
            }
          }
        }
      }
    }
  });
});
