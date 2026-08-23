import { describe, expect, it } from 'vitest';
import { recommendAll, recommendFor } from './model-recommender';
import { DIFFUSION_LADDER, floorApplies, quantForBudget, TEXT_LADDER } from './quant-ladder';

/**
 * These encode the user's rules directly, because they are judgements rather than
 * derivations — the tests ARE the specification, and a later change that
 * "improves" the ranking should have to argue with them.
 */
const machine = (usableMemoryGB: number, totalRamGB = usableMemoryGB) => ({
  usableMemoryGB,
  totalRamGB,
});

describe('the quant floor', () => {
  it('never goes below IQ3_XS for a model under 100B', () => {
    // the user: "don't go below Q3 xs on any model <100b".
    const tiny = quantForBudget(27, 6, TEXT_LADDER);
    expect(tiny).toBeUndefined();
    expect(TEXT_LADDER.at(-1)?.quant).toBe('IQ3_XS');
  });

  it('lets a very large MoE past the floor, deliberately', () => {
    // A 400B at Q2 is still better than anything else that fits, and refusing it
    // would leave a workstation running a 27B.
    expect(floorApplies(27)).toBe(true);
    expect(floorApplies(400)).toBe(false);
  });

  it('holds a HIGHER floor for diffusion than for text', () => {
    // A language model degrades legibly; a diffusion model at too few bits
    // produces artefacts that read as a broken app.
    expect(DIFFUSION_LADDER.at(-1)?.quant).toBe('Q4_K_M');
    expect(TEXT_LADDER.at(-1)?.quant).toBe('IQ3_XS');
  });

  it('picks the best rung that fits, not the first that does', () => {
    const roomy = quantForBudget(9, 24, TEXT_LADDER);
    expect(roomy?.rung.quant).toBe('Q8_0');
    // 27B at Q4_K_M is ~17 GB of weights and ~21 GB with a working context, so
    // 20 GB does NOT hold it — which matches what this repo already learned the
    // hard way ("27B does not fit 24GB", corp test cycle 2026-08-06) and what is
    // actually on this disk (a 13 GB Qwen3.8 27B, i.e. a Q3-class file).
    const tight = quantForBudget(27, 20, TEXT_LADDER);
    expect(tight?.rung.quant).toBe('Q3_K_M');
    // …and with genuinely enough room it takes the better rung.
    expect(quantForBudget(27, 24, TEXT_LADDER)?.rung.quant).toBe('Q4_K_M');
  });
});

describe('text', () => {
  it('picks Qwen3.8 27B whenever it fits — the user's standing instruction', () => {
    const rec = recommendFor('text', machine(24, 32));
    expect(rec?.family.id).toBe('qwen3.8');
    expect(rec?.reason).toMatch(/strongest open model/i);
  });

  it('steps down a MODEL SIZE rather than below the quant floor', () => {
    // 8 GB cannot hold a 27B above IQ3_XS. The wrong answer is Q2 of the 27B;
    // the right one is a smaller model at a quant that still works.
    const rec = recommendFor('text', machine(8, 16));
    expect(rec?.family.id).not.toBe('qwen3.8');
    expect(rec?.needsGB).toBeLessThanOrEqual(8);
    expect(rec?.quant?.rung.quant).toBeDefined();
  });

  it('still finds something for a very small machine', () => {
    const rec = recommendFor('text', machine(3, 8));
    expect(rec).toBeDefined();
    expect(rec?.needsGB).toBeLessThanOrEqual(3);
  });

  it('gives up rather than recommending something that cannot load', () => {
    // A machine with under a gigabyte to spare gets nothing, and the UI has to
    // say so — a suggestion that OOMs is worse than an empty state.
    expect(recommendFor('text', machine(0.4, 2))).toBeUndefined();
  });
});

describe('image', () => {
  it('leads with Mage Flow, which is the point on a slow machine', () => {
    // the user: "mage flow models are inevitably going to be like an order of
    // magnitude faster than any flux 2 klien or even something like z image".
    expect(recommendFor('image', machine(12, 16))?.family.id).toBe('mage-flow');
    expect(recommendFor('image', machine(48, 64))?.family.id).toBe('mage-flow');
  });

  it('explains itself in terms of speed, not size', () => {
    expect(recommendFor('image', machine(16))?.reason).toMatch(/few-step/i);
  });
});

describe('video', () => {
  it('favours LTX over MiniMax-H3', () => {
    // the user: "ltx 2.5 is significantly faster… I can tell virtually no quality
    // difference in general side by sides, so favor ltx".
    expect(recommendFor('video', machine(18, 24))?.family.id).toBe('ltx');
  });

  it('picks an LTX recipe the machine can actually hold', () => {
    const rec = recommendFor('video', machine(18, 24));
    expect(rec?.needsGB).toBeLessThanOrEqual(18);
  });

  it('falls back to H3 only when no LTX recipe fits', () => {
    const small = recommendFor('video', machine(11, 16));
    // The smallest LTX kit needs 10 GB, so it should still be LTX here.
    expect(small?.family.id).toBe('ltx');
  });
});

describe('every modality at once', () => {
  it('answers for a 24 GB Mac', () => {
    const all = recommendAll(machine(18, 24));
    expect(all.text?.family.id).toBe('qwen3.8');
    expect(all.image?.family.id).toBe('mage-flow');
    expect(all.video?.family.id).toBe('ltx');
    expect(all.audio).toBeDefined();
    expect(all['3d']).toBeDefined();
  });

  it('answers for an 8 GB laptop without promising anything that will not run', () => {
    const all = recommendAll(machine(6, 8));
    for (const rec of Object.values(all)) {
      expect(rec.needsGB, `${rec.modality}: ${rec.family.name}`).toBeLessThanOrEqual(6);
    }
  });

  it('answers for a 128 GB workstation with the biggest things available', () => {
    const all = recommendAll(machine(96, 128));
    expect(all.text?.family.id).toBe('qwen3.8');
    // With room to spare it should take a better quant, not a bigger floor.
    expect(all.text?.quant?.rung.quant).toBe('Q8_0');
  });
});
