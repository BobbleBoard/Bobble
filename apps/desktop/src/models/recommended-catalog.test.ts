import { describe, expect, it } from 'vitest';
import {
  availableOutputs,
  familySizeB,
  type OutputModality,
  RECOMMENDED_FAMILIES,
  recommendedFamilies,
  recommendedRepos,
} from './recommended-catalog';

/**
 * The curated list is DATA, and these are the invariants that make it usable as
 * a recommendation rather than just a list. The repo ids themselves were checked
 * against the Hugging Face API when the file was written (see its docstring);
 * a unit test cannot re-check that without a network call, so what is pinned
 * here is the shape and the promises the UI makes about it.
 */
describe('the curated recommended list', () => {
  it('is ordered smallest first, which is the promise the header makes', () => {
    const sizes = recommendedFamilies().map(familySizeB);
    const sorted = [...sizes].sort((a, b) => a - b);
    expect(sizes).toEqual(sorted);
  });

  it('puts families of unknown size LAST, not first', () => {
    // An unknown is not a small. Several image and video repos publish no
    // parameter count, and leading with them would break the ordering promise
    // for exactly the rows a newcomer looks at first.
    const ordered = recommendedFamilies();
    const firstUnknown = ordered.findIndex((f) => !Number.isFinite(familySizeB(f)));
    if (firstUnknown === -1) return;
    expect(ordered.slice(firstUnknown).every((f) => !Number.isFinite(familySizeB(f)))).toBe(true);
  });

  it('covers every output modality, not just text', () => {
    // the user: "needs to include all modalities also not just -text".
    const want: OutputModality[] = ['text', 'image', 'video', 'audio', '3d'];
    expect([...availableOutputs()].sort()).toEqual([...want].sort());
  });

  it('filters to one output', () => {
    const video = recommendedFamilies(['video']);
    expect(video.length).toBeGreaterThan(0);
    expect(video.every((f) => f.output === 'video')).toBe(true);
  });

  it('filters to several outputs at once', () => {
    const both = recommendedFamilies(['audio', '3d']);
    expect(new Set(both.map((f) => f.output))).toEqual(new Set(['audio', '3d']));
  });

  it('never lists the same repo twice', () => {
    // A repo in two families would download once and appear on disk in both,
    // which reads as a bug in the "on disk" count rather than in the data.
    const repos = recommendedRepos();
    expect(new Set(repos).size).toBe(repos.length);
  });

  it('gives every family at least one variant that is not a draft', () => {
    // Drafts ride with their parent; a family of nothing but drafts would draw
    // an expandable card that opens onto nothing.
    for (const f of RECOMMENDED_FAMILIES) {
      expect(f.variants.filter((v) => v.draftFor === undefined).length).toBeGreaterThan(0);
    }
  });

  it('sizes a family by its SMALLEST member', () => {
    // What decides where a family sits is the cheapest way in, not its flagship
    // — the ordering is there to answer "what can I actually run".
    const family = RECOMMENDED_FAMILIES.find((f) => f.id === 'qwen3.5');
    if (family === undefined) throw new Error('qwen3.5 is missing from the curated list');
    expect(familySizeB(family)).toBe(0.8);
  });

  it('names a real org and a blurb for every family', () => {
    for (const f of RECOMMENDED_FAMILIES) {
      expect(f.org.length).toBeGreaterThan(0);
      expect(f.blurb.length).toBeGreaterThan(10);
      expect(f.variants.every((v) => v.repo.includes('/'))).toBe(true);
    }
  });
});
