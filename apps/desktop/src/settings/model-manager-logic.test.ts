import { describe, expect, it } from 'vitest';
import type { LlmCatalogEntry } from '../../electron/ipc-contract';
import {
  baseModelName,
  categorizeByFamily,
  defaultVariant,
  displaySizeBytes,
  formatBytes,
  formatSpeed,
  groupCatalog,
  groupFits,
  isReliablePublisher,
  mergeQuantLadder,
  modelFamily,
  orderQuantsForDisplay,
  percent,
  quantFit,
  ramVerdict,
  recommendedQuant,
  selectedQuant,
  variantEntry,
} from './model-manager-logic';

/** the user's machine, and the one every "does it fit" claim has to survive. */
const M5_PRO_24GB = { totalRamGB: 24, modelMaxContext: 65_536 };
const GB = 1e9;

describe('ramVerdict', () => {
  it('unknown RAM (0) is neutral and states the requirement', () => {
    const v = ramVerdict(16, 0);
    expect(v.tone).toBe('default');
    expect(v.fits).toBe(true);
    expect(v.label).toContain('16 GB');
  });

  it('insufficient RAM is danger + does not fit', () => {
    expect(ramVerdict(32, 16)).toMatchObject({ tone: 'danger', label: "Won't fit", fits: false });
  });

  it('a tight-but-adequate fit is a warning', () => {
    // 18 total, needs 16 → 2 GB headroom (< 4) → tight.
    expect(ramVerdict(16, 18)).toMatchObject({
      tone: 'warning',
      label: 'Tight — will swap',
      fits: true,
    });
  });

  it('comfortable headroom is success', () => {
    expect(ramVerdict(16, 32)).toMatchObject({ tone: 'success', label: 'Fits', fits: true });
  });

  /* One vocabulary on screen; the DETAIL is what says this is the coarse one. */
  it('uses the same three words as quantFit, and says why it is different', () => {
    const words = new Set([
      ramVerdict(16, 32).label,
      ramVerdict(16, 18).label,
      ramVerdict(32, 16).label,
      quantFit({ modelBytes: 5 * GB, ...M5_PRO_24GB }).label,
      quantFit({ modelBytes: 40 * GB, ...M5_PRO_24GB }).label,
    ]);
    expect(words).toEqual(new Set(['Fits', 'Tight — will swap', "Won't fit"]));
    expect(ramVerdict(16, 32).detail).toMatch(/no file size known yet/);
  });

  it('exact minimum counts as a (tight) fit, not insufficient', () => {
    expect(ramVerdict(16, 16).fits).toBe(true);
    expect(ramVerdict(16, 16).tone).toBe('warning');
  });
});

describe('formatBytes', () => {
  it('formats GB with one decimal under 10, none at/above', () => {
    expect(formatBytes(2.53e9)).toBe('2.5 GB');
    expect(formatBytes(24e9)).toBe('24 GB');
  });
  it('falls back to MB under a GB', () => {
    expect(formatBytes(700e6)).toBe('700 MB');
  });
  it('renders a dash for unknown/zero sizes', () => {
    expect(formatBytes(0)).toBe('—');
  });
});

describe('formatSpeed', () => {
  it('MB/s above a megabyte, KB/s below, empty for null/zero', () => {
    expect(formatSpeed(12.4e6)).toBe('12.4 MB/s');
    expect(formatSpeed(500e3)).toBe('500 KB/s');
    expect(formatSpeed(null)).toBe('');
    expect(formatSpeed(0)).toBe('');
  });
});

describe('percent', () => {
  it('rounds + clamps a 0..1 fraction, passes null through', () => {
    expect(percent(0.256)).toBe(26);
    expect(percent(1.4)).toBe(100);
    expect(percent(-0.2)).toBe(0);
    expect(percent(null)).toBeNull();
  });
});

describe('selectedQuant / displaySizeBytes', () => {
  const entry = {
    quants: [
      { quant: 'Q4_K_M', bytes: 2e9 },
      { quant: 'Q6_K', bytes: 3e9 },
    ],
  };
  it('picks the named quant, else the first', () => {
    expect(selectedQuant(entry, 'Q6_K')?.bytes).toBe(3e9);
    expect(selectedQuant(entry)?.quant).toBe('Q4_K_M');
    expect(selectedQuant(entry, 'nope')?.quant).toBe('Q4_K_M');
  });
  it('displaySizeBytes uses the selected quant size', () => {
    const full = { ...entry, id: 'x', displayName: 'X' } as never;
    expect(displaySizeBytes(full, 'Q6_K')).toBe(3e9);
  });
});

// ── round-12: reliable publishers ───────────────────────────────────────────
describe('isReliablePublisher', () => {
  it('accepts allowlisted handles (exact) and rejects community re-quanters', () => {
    expect(isReliablePublisher('unsloth')).toBe(true);
    expect(isReliablePublisher('Qwen')).toBe(true);
    expect(isReliablePublisher('ggml-org')).toBe(true);
    expect(isReliablePublisher('nvidia')).toBe(true);
    // Community re-quanter — NOT reliable (mirrors keystone's catalog).
    expect(isReliablePublisher('mradermacher')).toBe(false);
    expect(isReliablePublisher('some-random-org')).toBe(false);
  });
});

// ── round-12: de-duplicated model grouping ──────────────────────────────────
/** Narrow away the `| undefined` that noUncheckedIndexedAccess adds to array
 * lookups, throwing (failing the test) when the value is genuinely missing. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

function entry(over: Partial<LlmCatalogEntry> & Pick<LlmCatalogEntry, 'id' | 'displayName'>) {
  return {
    quants: [{ quant: 'Q4_K_M', bytes: 4e9 }],
    minRamGB: 8,
    contextWindow: 32_768,
    input: ['text'],
    license: 'Apache-2.0',
    mtp: false,
    vision: false,
    downloaded: false,
    recommended: false,
    ...over,
  } as LlmCatalogEntry;
}

const GEMMA_12B = entry({
  id: 'gemma-4-12b-it',
  displayName: 'Gemma 4 12B Instruct',
  minRamGB: 16,
  spec: 'mtp',
  mtp: true,
  variants: [{ method: 'mtp' }, { method: 'dflash', draftRepo: 'x/gemma-12b-dflash' }],
  publisher: { handle: 'unsloth', reliable: true },
  tier: 'balanced',
});
const GEMMA_E2B = entry({
  id: 'gemma-4-e2b-it',
  displayName: 'Gemma 4 E2B Instruct',
  minRamGB: 6,
  spec: 'mtp',
  mtp: true,
  variants: [{ method: 'mtp' }],
  publisher: { handle: 'unsloth', reliable: true },
});
const QWEN_27B_MTP = entry({
  id: 'qwen3.6-27b-mtp',
  displayName: 'Qwen3.6 27B (MTP)',
  minRamGB: 24,
  spec: 'mtp',
  mtp: true,
  hfRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'eagle3', draftRepo: 'gelim/Qwen3.6-27B-EAGLE3-GGUF' },
    { method: 'dflash', draftRepo: 'x/qwen-27b-dflash' },
  ],
});
const QWEN_27B_EAGLE3 = entry({
  id: 'qwen3.6-27b-eagle3',
  displayName: 'Qwen3.6 27B (EAGLE-3)',
  minRamGB: 24,
  spec: 'eagle3',
  hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
  variants: [
    { method: 'eagle3', draftRepo: 'gelim/Qwen3.6-27B-EAGLE3-GGUF' },
    { method: 'dflash', draftRepo: 'x/qwen-27b-dflash' },
  ],
});

describe('baseModelName / modelFamily', () => {
  it('strips the speed-variant suffix so variants of one model collapse', () => {
    expect(baseModelName('Qwen3.6 27B (MTP)')).toBe('Qwen3.6 27B');
    expect(baseModelName('Qwen3.6 27B (EAGLE-3)')).toBe('Qwen3.6 27B');
    expect(baseModelName('Gemma 4 12B Instruct')).toBe('Gemma 4 12B Instruct');
  });
  it('derives the family (everything before the size token)', () => {
    expect(modelFamily('Gemma 4 12B Instruct')).toBe('Gemma 4');
    expect(modelFamily('Gemma 4 E2B Instruct')).toBe('Gemma 4');
    expect(modelFamily('Qwen3.6 27B (MTP)')).toBe('Qwen3.6');
    expect(modelFamily('NVIDIA Nemotron-3 Nano 30B-A3B')).toBe('NVIDIA Nemotron-3 Nano');
    expect(modelFamily('Gemma 4 26B-A4B Instruct')).toBe('Gemma 4');
  });
});

describe('groupCatalog (de-duplication)', () => {
  it('collapses the two Qwen3.6 27B entries into ONE group', () => {
    const groups = groupCatalog([GEMMA_E2B, GEMMA_12B, QWEN_27B_MTP, QWEN_27B_EAGLE3]);
    expect(groups).toHaveLength(3); // e2b, 12b, and ONE qwen 27b
    const qwen = groups.find((g) => g.displayName === 'Qwen3.6 27B');
    expect(qwen).toBeDefined();
    expect(qwen?.entries).toHaveLength(2);
  });

  it('picks the MTP/embedded entry as the primary', () => {
    const qwen = must(groupCatalog([QWEN_27B_EAGLE3, QWEN_27B_MTP])[0]);
    expect(qwen.primary.id).toBe('qwen3.6-27b-mtp');
    expect(defaultVariant(qwen)).toBe('mtp');
  });

  it('offers the deduped variant union in [MTP, DFlash, EAGLE-3] order', () => {
    const qwen = must(groupCatalog([QWEN_27B_MTP, QWEN_27B_EAGLE3])[0]);
    expect(qwen.variants.map((v) => v.method)).toEqual(['mtp', 'dflash', 'eagle3']);
  });

  it('resolves each variant → the concrete entry (repo) that provides it', () => {
    const qwen = must(groupCatalog([QWEN_27B_MTP, QWEN_27B_EAGLE3])[0]);
    // MTP → the embedded MTP repo; EAGLE-3 → its dedicated repo (spec === eagle3).
    expect(variantEntry(qwen, 'mtp').id).toBe('qwen3.6-27b-mtp');
    expect(variantEntry(qwen, 'eagle3').id).toBe('qwen3.6-27b-eagle3');
    // DFlash has no dedicated entry → resolves to the entry declaring it (primary).
    expect(variantEntry(qwen, 'dflash').id).toBe('qwen3.6-27b-mtp');
    // The DFlash option carries its draft repo for the Advanced view.
    expect(qwen.variants.find((v) => v.method === 'dflash')?.draftRepo).toBe('x/qwen-27b-dflash');
  });

  it('a single-variant model resolves to itself (no dropdown needed)', () => {
    const g = must(groupCatalog([GEMMA_E2B])[0]);
    expect(g.variants).toHaveLength(1);
    expect(variantEntry(g, defaultVariant(g)).id).toBe('gemma-4-e2b-it');
  });
});

describe('categorizeByFamily', () => {
  it('groups by family and sorts models within a family by size (RAM)', () => {
    const groups = groupCatalog([GEMMA_12B, GEMMA_E2B, QWEN_27B_MTP, QWEN_27B_EAGLE3]);
    const sections = categorizeByFamily(groups);
    const gemma = sections.find((s) => s.family === 'Gemma 4');
    expect(gemma?.groups.map((g) => g.displayName)).toEqual([
      'Gemma 4 E2B Instruct', // 6 GB before 16 GB
      'Gemma 4 12B Instruct',
    ]);
    // Families ordered by their smallest member (Gemma 6 GB before Qwen 24 GB).
    expect(sections.map((s) => s.family)).toEqual(['Gemma 4', 'Qwen3.6']);
  });
});

describe('mergeQuantLadder', () => {
  const base = [
    { quant: 'Q4_K_M', bytes: 4e9 },
    { quant: 'Q6_K', bytes: 6e9 },
  ];
  it('returns the base list (sorted Q-low→high) when no ladder is fetched', () => {
    expect(mergeQuantLadder(base).map((q) => q.quant)).toEqual(['Q4_K_M', 'Q6_K']);
  });
  it('merges a live hf:list-files ladder, filling sizes + adding new quants', () => {
    const merged = mergeQuantLadder(base, [
      { quant: 'Q2_K', sizeBytes: 2e9 },
      { quant: 'Q8_0', sizeBytes: 8e9 },
      { quant: 'Q4_K_M', sizeBytes: 4.1e9 }, // live size wins
    ]);
    expect(merged.map((q) => q.quant)).toEqual(['Q2_K', 'Q4_K_M', 'Q6_K', 'Q8_0']);
    expect(merged.find((q) => q.quant === 'Q4_K_M')?.bytes).toBe(4.1e9);
  });
  it('ignores fetched files without a quant label', () => {
    const merged = mergeQuantLadder(base, [{ sizeBytes: 1e9 }]);
    expect(merged).toHaveLength(2);
  });
});

describe('quantFit — the verdict weighs the quant on screen', () => {
  /*
   * THE BUG THIS REPLACES. `ramVerdict(group.primary.minRamGB, totalRam)` was a
   * per-MODEL constant, so the badge could not move when the quant did. the user:
   * "it says things will fit I think without taking into account OS overhead or
   * unified memory or anything."
   */
  it('gives different answers for different quants of the same model', () => {
    // Real Qwen3.8-27B sizes from unsloth/Qwen3.8-27B-GGUF.
    const q3 = quantFit({ modelBytes: 13.44 * GB, ...M5_PRO_24GB });
    const q6 = quantFit({ modelBytes: 25.92 * GB, ...M5_PRO_24GB });
    expect(q3.fits).toBe(true);
    expect(q6.fits).toBe(false);
    expect(q6.label).toBe("Won't fit");
  });

  it('counts the KV cache, not just the weights on disk', () => {
    // 17.9 GB of weights is under 24 GB of RAM and still cannot be launched:
    // the context cache and runtime overhead push it past the budget.
    const q4 = quantFit({ modelBytes: 17.92 * GB, ...M5_PRO_24GB });
    expect(q4.tone).not.toBe('success');
  });

  /*
   * The projector is downloaded with the weights but only LOADED on an opt-in
   * multimodal restart, so it must not decide the default verdict — charging
   * every model for it handed the 27B's recommendation to a worse quant of the
   * same size. It is named in the detail instead, because switching vision on
   * later is a real cliff.
   */
  it('does not charge the default (text-only) launch for the projector', () => {
    const bare = quantFit({ modelBytes: 15 * GB, ...M5_PRO_24GB });
    const withVision = quantFit({ modelBytes: 15 * GB, mmprojBytes: 0.93 * GB, ...M5_PRO_24GB });
    expect(withVision.tone).toBe(bare.tone);
    expect(withVision.label).toBe(bare.label);
  });

  it('still names the vision cost, so the cliff is visible before you walk off it', () => {
    const v = quantFit({ modelBytes: 13.44 * GB, mmprojBytes: 0.93 * GB, ...M5_PRO_24GB });
    expect(v.detail).toMatch(/with vision on/);
    expect(quantFit({ modelBytes: 13.44 * GB, ...M5_PRO_24GB }).detail).not.toMatch(/vision/);
  });

  it('has a distinct verdict for "loads, then swaps"', () => {
    // Between the 80% budget and the full 24 GB: it will start and then thrash.
    const tight = quantFit({ modelBytes: 16.5 * GB, ...M5_PRO_24GB });
    expect(tight.tone).toBe('warning');
    expect(tight.fits).toBe(true);
  });

  it('shows the whole sum, in one unit, so the arithmetic adds up on screen', () => {
    const v = quantFit({ modelBytes: 13.44 * GB, ...M5_PRO_24GB });
    expect(v.detail).toMatch(/GB of 24 GB/);
    expect(v.detail).toMatch(/64k window/);
    // weights + context + runtime must actually equal the total shown.
    const m = /([\d.]+) weights \+ ([\d.]+) context \+ ([\d.]+) runtime ≈ ([\d.]+) GB/.exec(
      v.detail ?? '',
    );
    expect(m).not.toBeNull();
    const [w, c, r, total] = (m ?? ['0', '0', '0', '0', '0']).slice(1).map(Number) as number[];
    expect((w ?? 0) + (c ?? 0) + (r ?? 0)).toBeCloseTo(total ?? 0, 1);
    // And the weights term is the file in GiB, not the base-1000 GB on the card.
    expect(w ?? 0).toBeCloseTo((13.44 * GB) / 1024 ** 3, 1);
  });

  it('stays neutral when the machine is unknown rather than guessing', () => {
    expect(quantFit({ modelBytes: 13 * GB, totalRamGB: 0 }).tone).toBe('default');
  });
});

describe('orderQuantsForDisplay — row 0 is the recommendation', () => {
  const ladder = [
    { quant: 'UD-Q2_K_XL', bytes: 10.68 * GB },
    { quant: 'UD-Q3_K_XL', bytes: 13.44 * GB },
    { quant: 'Q3_K_M', bytes: 13.82 * GB },
    { quant: 'UD-Q4_K_XL', bytes: 17.92 * GB },
    { quant: 'UD-Q6_K_XL', bytes: 25.92 * GB },
  ];

  it('puts the best fitting quant first, not the smallest', () => {
    const out = orderQuantsForDisplay(ladder, M5_PRO_24GB);
    expect(out[0]?.quant).toBe('UD-Q3_K_XL');
    expect(recommendedQuant(ladder, M5_PRO_24GB)?.quant).toBe('UD-Q3_K_XL');
  });

  /*
   * MEASURED on the real card: strict size-descending picked Q3_K_M (13.82 GB)
   * over UD-Q3_K_XL (13.44 GB) — 0.4 GB of extra file bought at the cost of the
   * better quantisation, which is the whole reason UD quants exist.
   */
  it('prefers a dynamic quant over a marginally larger plain one', () => {
    const out = orderQuantsForDisplay(
      [
        { quant: 'Q3_K_M', bytes: 13.82 * GB },
        { quant: 'UD-Q3_K_XL', bytes: 13.44 * GB },
      ],
      M5_PRO_24GB,
    );
    expect(out[0]?.quant).toBe('UD-Q3_K_XL');
  });

  it('but not over a decisively larger one', () => {
    const out = orderQuantsForDisplay(
      [
        { quant: 'Q3_K_M', bytes: 13.82 * GB },
        { quant: 'UD-IQ2_M', bytes: 10.32 * GB },
      ],
      M5_PRO_24GB,
    );
    expect(out[0]?.quant).toBe('Q3_K_M');
  });

  it('sinks what will not fit below what will', () => {
    const out = orderQuantsForDisplay(ladder, M5_PRO_24GB).map((q) => q.quant);
    expect(out.indexOf('UD-Q6_K_XL')).toBeGreaterThan(out.indexOf('UD-Q2_K_XL'));
  });

  it('orders the wont-fit tail smallest-first — the near-misses are the useful end', () => {
    const tiny = { totalRamGB: 8, modelMaxContext: 65_536 };
    const out = orderQuantsForDisplay(ladder, tiny).map((q) => q.quant);
    expect(out[0]).toBe('UD-Q2_K_XL');
    expect(out.at(-1)).toBe('UD-Q6_K_XL');
  });

  it('floats a quant already on disk above a better one that is not', () => {
    const out = orderQuantsForDisplay(ladder, M5_PRO_24GB, (q) => q === 'UD-Q2_K_XL');
    expect(out[0]?.quant).toBe('UD-Q2_K_XL');
  });

  it('never drops or duplicates an option', () => {
    const out = orderQuantsForDisplay(ladder, M5_PRO_24GB);
    expect(out).toHaveLength(ladder.length);
    expect(new Set(out.map((q) => q.quant)).size).toBe(ladder.length);
  });
});

describe('mergeQuantLadder — size order, and a projector is not a quant', () => {
  /*
   * the user: "sort ggufs instead of alphabetically which as you can see might put
   * all the unsloth dynamics (labeled UD) below all the others".
   */
  it('does not strand UD- quants under plain ones of the same digit', () => {
    const out = mergeQuantLadder(
      [],
      [
        { quant: 'Q4_K_S', sizeBytes: 16.12 * GB },
        { quant: 'UD-Q4_K_XL', sizeBytes: 17.92 * GB },
        { quant: 'IQ4_XS', sizeBytes: 15.71 * GB },
      ],
    ).map((q) => q.quant);
    // Old key was quantRank then localeCompare, which put UD- dead last.
    expect(out).toEqual(['IQ4_XS', 'Q4_K_S', 'UD-Q4_K_XL']);
  });

  it('drops the mmproj row instead of offering it as a 0.9 GB "F16" model', () => {
    const out = mergeQuantLadder(
      [],
      [
        { quant: 'UD-Q3_K_XL', sizeBytes: 13.44 * GB },
        { quant: 'F16', sizeBytes: 0.93 * GB, mmproj: true },
      ],
    );
    expect(out.map((q) => q.quant)).toEqual(['UD-Q3_K_XL']);
  });
});

describe('groupFits — can this model run here at all', () => {
  const g = (quants: Array<{ quant: string; bytes: number }>) =>
    ({ entries: [{ quants, contextWindow: 65_536 }] }) as never;

  it('is true when the SMALLEST quant fits, even if the largest does not', () => {
    expect(
      groupFits(
        g([
          { quant: 'UD-Q2_K_XL', bytes: 10.68 * GB },
          { quant: 'UD-Q8_K_XL', bytes: 31.46 * GB },
        ]),
        { totalRamGB: 24 },
      ),
    ).toBe(true);
  });

  it('is false only when nothing on offer can load', () => {
    expect(groupFits(g([{ quant: 'Q8_0', bytes: 29 * GB }]), { totalRamGB: 16 })).toBe(false);
  });

  it('never hides on a guess — unknown hardware or unknown size passes', () => {
    expect(groupFits(g([{ quant: 'Q8_0', bytes: 29 * GB }]), null)).toBe(true);
    expect(groupFits(g([{ quant: 'Q8_0', bytes: 29 * GB }]), { totalRamGB: 0 })).toBe(true);
    expect(groupFits(g([{ quant: 'Q8_0', bytes: 0 }]), { totalRamGB: 8 })).toBe(true);
  });
});

describe('mergeQuantLadder — shards are one model', () => {
  /*
   * CAUGHT BY DRIVING THE REAL CARD. unsloth/Qwen3.8-27B-GGUF ships BF16 as two
   * shards (49.99 GB + 4.67 GB). parseQuant strips the -00001-of-00002 suffix,
   * so both reduced to "BF16" and the LATER one won — the dropdown offered
   * "BF16 · 4.7 GB · Fits" for a 54.7 GB model on a 24 GB Mac.
   */
  it('sums the shards of one quant instead of keeping the last', () => {
    const out = mergeQuantLadder(
      [],
      [
        { quant: 'BF16', sizeBytes: 49.99 * GB },
        { quant: 'BF16', sizeBytes: 4.67 * GB },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.bytes).toBeCloseTo(54.66 * GB, -8);
  });

  it('does not double-count a single-file quant that is also in the catalog', () => {
    const out = mergeQuantLadder(
      [{ quant: 'UD-Q3_K_XL', bytes: 13.44 * GB }],
      [{ quant: 'UD-Q3_K_XL', sizeBytes: 13.44 * GB }],
    );
    expect(out[0]?.bytes).toBeCloseTo(13.44 * GB, -6);
  });

  it('keeps the catalog size when the live listing has no size for it', () => {
    const out = mergeQuantLadder(
      [{ quant: 'Q4_K_M', bytes: 17.11 * GB }],
      [{ quant: 'Q4_K_M', sizeBytes: 0 }],
    );
    expect(out[0]?.bytes).toBeCloseTo(17.11 * GB, -6);
  });

  it('a summed shard family sorts and judges by its REAL size', () => {
    const ladder = mergeQuantLadder(
      [],
      [
        { quant: 'BF16', sizeBytes: 49.99 * GB },
        { quant: 'BF16', sizeBytes: 4.67 * GB },
        { quant: 'UD-Q3_K_XL', sizeBytes: 13.44 * GB },
      ],
    );
    const ordered = orderQuantsForDisplay(ladder, M5_PRO_24GB);
    expect(ordered[0]?.quant).toBe('UD-Q3_K_XL');
    expect(
      quantFit({ modelBytes: ladder.find((q) => q.quant === 'BF16')?.bytes ?? 0, ...M5_PRO_24GB })
        .fits,
    ).toBe(false);
  });
});
