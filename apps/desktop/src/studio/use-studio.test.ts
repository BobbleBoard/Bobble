/**
 * WHEN A ROOM SHOULD REFUSE TO PRETEND.
 *
 * All three studios used to ask `models.length === 0`, which is a different
 * question from "can anything here run": a `reserved` catalogue entry is
 * enumerated and gated, so it counts towards that length while producing
 * nothing. MEASURED in the round-2 settings run — every video model is reserved
 * today, and the Video studio drew a live Generate button, three starters and a
 * model picker reading "Recommended" with nothing saying video cannot run yet.
 */
import { describe, expect, it } from 'vitest';
import { runnableModels, studioBlockedReason } from './use-studio';

const real = { id: 'a', reserved: false };
const soon = { id: 'b', reserved: true };
/* `reserved` genuinely absent — the catalogue leaves it off for most entries,
   and the rule has to read that as runnable rather than as unknown. Typed
   explicitly because an object literal with no overlapping property is not
   assignable to `{ reserved?: boolean }` in TypeScript. */
const unmarked: { id: string; reserved?: boolean } = { id: 'c' };

describe('runnableModels', () => {
  it('drops the ones whose backend has not landed', () => {
    expect(runnableModels([real, soon, unmarked])).toEqual([real, unmarked]);
  });

  it('treats an unmarked entry as runnable — absent is not reserved', () => {
    expect(runnableModels([unmarked])).toEqual([unmarked]);
  });
});

describe('studioBlockedReason', () => {
  it('says nothing when at least one model can run', () => {
    expect(studioBlockedReason([real, soon], 'image')).toBeUndefined();
  });

  it('distinguishes an EMPTY catalogue from a fully-reserved one', () => {
    // Two different pieces of news: something is wrong, versus nothing is
    // wrong and it is not built. Wording them the same would send someone
    // looking for a broken install that is not broken.
    const empty = studioBlockedReason([], 'video');
    const reserved = studioBlockedReason([soon], 'video');
    expect(empty).toBe('No video models are available.');
    expect(reserved).toBeDefined();
    expect(reserved).not.toBe(empty);
    expect(reserved).toMatch(/still to come/);
  });

  it('starts the sentence with a capital whatever the noun it is given', () => {
    expect(studioBlockedReason([soon], 'video')).toMatch(/^Video /);
    expect(studioBlockedReason([soon], 'sound')).toMatch(/^Sound /);
  });
});
