import { describe, expect, it } from 'vitest';
import {
  availableOutputs,
  familySizeB,
  fitFor,
  type OutputModality,
  RECOMMENDED_FAMILIES,
  recommendedFamilies,
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

  it('never lists the same BUNDLE twice', () => {
    // A repo may legitimately appear several times — MiniMax-H3 publishes the
    // keyframe weights, the reference-image weights and the text encoder in one
    // tree, and each is its own download. What must be unique is the recipe:
    // repo plus the files it takes. Two identical recipes would race each other
    // into the same directory.
    const bundles = RECOMMENDED_FAMILIES.flatMap((f) =>
      f.variants.map((v) => `${v.repo}::${(v.allow ?? []).join(',')}`),
    );
    expect(new Set(bundles).size).toBe(bundles.length);
  });

  it('never offers a whole repo where the whole repo is an archive', () => {
    /*
     * The bug the user caught on screen: "0% · 466 MB of 237 GB". The LTX 2B entry
     * named `Lightricks/LTX-Video` with no `allow`, and that repo is a 254 GB
     * archive of every LTX release ever published — so Download meant all of it.
     * Any variant of a family whose repo is one of these archives must be a
     * recipe, never the bare repo.
     */
    const ARCHIVES = new Set([
      'Lightricks/LTX-Video',
      'Lightricks/LTX-2.5',
      'city96/t5-v1_1-xxl-encoder-gguf',
      'unsloth/MiniMax-H3-GGUF',
      'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    ]);
    for (const f of RECOMMENDED_FAMILIES) {
      for (const v of f.variants) {
        if (!ARCHIVES.has(v.repo)) continue;
        expect(v.allow, `${v.repo} ${v.label} would download the whole archive`).toBeDefined();
      }
    }
  });

  it('fetches an encoder and a VAE alongside every quantized video transformer', () => {
    /*
     * A GGUF transformer on its own cannot generate anything — a ComfyUI video
     * graph loads a transformer, a text encoder and a VAE, and the quantized
     * community builds publish them in SEPARATE repos. A recipe that named only
     * the transformer would leave someone with weights that will not run and no
     * hint as to why.
     */
    for (const f of RECOMMENDED_FAMILIES) {
      if (f.output !== 'video') continue;
      for (const v of f.variants) {
        if (!/\.gguf$/i.test((v.allow ?? []).join(' '))) continue;
        const everything = [
          ...(v.allow ?? []),
          ...(v.parts ?? []).flatMap((part) => part.allow ?? [part.repo]),
        ].join(' ');
        expect(/t5|gemma|encoder|qwen3vl/i.test(everything), `${f.id} ${v.label}`).toBe(true);
      }
    }
  });

  it('gives every partial-repo variant a real measured size', () => {
    // A recipe's size cannot be inferred from the repo (LTX-2.5's tree is ~200GB
    // and no configuration is), so an `allow` without `approxBytes` would make
    // the card guess. Better to require the number than to show a wrong one.
    for (const f of RECOMMENDED_FAMILIES) {
      for (const v of f.variants) {
        if (v.allow === undefined) continue;
        expect(v.approxBytes, `${v.repo} ${v.label}`).toBeGreaterThan(0);
      }
    }
  });

  it('says what this machine can do with the big ones', () => {
    // the user: "of course all of these are vram dependent, show a not recommended
    // for this machine if it can't run".
    const ltx = RECOMMENDED_FAMILIES.find((f) => f.id === 'ltx');
    if (ltx === undefined) throw new Error('LTX is missing');
    const big = ltx.variants.find((v) => v.label.includes('22B · Q4'));
    if (big === undefined) throw new Error('the 22B Q4 recipe is missing');
    expect(fitFor(big, 24)).toBe('too-big');
    expect(fitFor(big, 128)).toBe('fits');
    // …and the small quant is the one that makes the family usable here, which
    // is the whole reason the recipes are GGUF rather than bf16.
    const small = ltx.variants.find((v) => v.label.includes('2B distilled · Q4'));
    if (small === undefined) throw new Error('the 2B Q4 recipe is missing');
    expect(fitFor(small, 24)).toBe('fits');
    // A model that fits but leaves nothing over is neither a yes nor a no.
    expect(fitFor({ repo: 'a/b', label: 'x', minMemoryGB: 22 }, 24)).toBe('tight');
    expect(fitFor({ repo: 'a/b', label: 'x' }, 24)).toBe('unknown');
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
    /*
     * The blurb is no longer drawn on the cards — the user: "no descriptions on the
     * model cards please" — but it stays REQUIRED, and deliberately. It is the
     * one-sentence justification for a family being in a curated list at all,
     * and a list where entries can be added without one is a list that fills up
     * with things nobody can defend. It also still feeds the recommender's
     * reason text and the family's own detail copy.
     */
    for (const f of RECOMMENDED_FAMILIES) {
      expect(f.org.length).toBeGreaterThan(0);
      expect(f.blurb.length).toBeGreaterThan(10);
      expect(f.variants.every((v) => v.repo.includes('/'))).toBe(true);
    }
  });
});
