import { describe, expect, it } from 'vitest';
import type { HfGgufFileDTO } from '../../electron/ipc-contract';
import { recommendedQuant } from '../settings/model-manager-logic';
import { hfLadder, pickHfDownload, pickRefusal, quantLabel } from './hf-download';

/**
 * unsloth/Qwen3.8-27B-GGUF as `hf:list-files` returned it on 2026-09-25, in the
 * order it returned it: alphabetical, so a split BF16 first, then the speed
 * head, then the quants, then the imatrix and the two projectors. Every bug in
 * this file was found on this listing, so the tests run on the real thing.
 */
const f = (path: string, sizeBytes: number, quant?: string, extra: Partial<HfGgufFileDTO> = {}) =>
  ({ path, sizeBytes, ...(quant === undefined ? {} : { quant }), ...extra }) as HfGgufFileDTO;
const QWEN38_27B: HfGgufFileDTO[] = [
  f('BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf', 49_986_159_616, 'BF16'),
  f('BF16/Qwen3.8-27B-BF16-00002-of-00002.gguf', 4_671_576_000, 'BF16'),
  f('MTP/mtp-Qwen3.8-27B-Q4_0.gguf', 1_369_590_656, 'Q4_0', { mtp: true }),
  f('Qwen3.8-27B-Q4_0.gguf', 16_056_478_688, 'Q4_0'),
  f('Qwen3.8-27B-Q4_1.gguf', 17_540_705_248, 'Q4_1'),
  f('Qwen3.8-27B-Q8_0.gguf', 29_047_086_048, 'Q8_0'),
  f('Qwen3.8-27B-UD-IQ1_M.gguf', 6_729_166_848, 'UD-IQ1_M'),
  f('Qwen3.8-27B-UD-IQ1_S.gguf', 6_192_222_208, 'UD-IQ1_S'),
  f('Qwen3.8-27B-UD-IQ2_S.gguf', 8_371_970_048, 'UD-IQ2_S'),
  f('Qwen3.8-27B-UD-IQ2_XXS.gguf', 7_266_070_528, 'UD-IQ2_XXS'),
  f('Qwen3.8-27B-UD-IQ3_S.gguf', 12_040_883_104, 'UD-IQ3_S'),
  f('Qwen3.8-27B-UD-IQ3_XXS.gguf', 10_934_860_704, 'UD-IQ3_XXS'),
  f('Qwen3.8-27B-UD-IQ4_XS.gguf', 14_252_845_984, 'UD-IQ4_XS'),
  f('Qwen3.8-27B-UD-Q2_K_XL.gguf', 9_828_981_664, 'UD-Q2_K_XL'),
  f('Qwen3.8-27B-UD-Q3_K_XL.gguf', 13_146_393_504, 'UD-Q3_K_XL'),
  f('Qwen3.8-27B-UD-Q4_K_M.gguf', 16_464_440_224, 'UD-Q4_K_M'),
  f('Qwen3.8-27B-UD-Q4_K_S.gguf', 15_358_213_024, 'UD-Q4_K_S'),
  f('Qwen3.8-27B-UD-Q4_K_XL.gguf', 17_559_178_144, 'UD-Q4_K_XL'),
  f('Qwen3.8-27B-UD-Q5_K_M.gguf', 19_771_509_664, 'UD-Q5_K_M'),
  f('Qwen3.8-27B-UD-Q5_K_S.gguf', 18_665_753_504, 'UD-Q5_K_S'),
  f('Qwen3.8-27B-UD-Q5_K_XL.gguf', 20_876_938_144, 'UD-Q5_K_XL'),
  f('Qwen3.8-27B-UD-Q6_K.gguf', 21_983_677_344, 'UD-Q6_K'),
  f('Qwen3.8-27B-UD-Q6_K_L.gguf', 24_193_919_904, 'UD-Q6_K_L'),
  f('Qwen3.8-27B-UD-Q6_K_M.gguf', 23_088_409_504, 'UD-Q6_K_M'),
  f('Qwen3.8-27B-UD-Q6_K_XL.gguf', 25_299_061_664, 'UD-Q6_K_XL'),
  f('Qwen3.8-27B-UD-Q8_K_L.gguf', 28_045_695_904, 'UD-Q8_K_L'),
  f('Qwen3.8-27B-UD-Q8_K_XL.gguf', 31_457_991_680, 'UD-Q8_K_XL'),
  f('imatrix_unsloth.gguf', 13_642_656),
  f('mmproj-BF16.gguf', 931_146_432, 'BF16', { mmproj: true }),
  f('mmproj-F16.gguf', 927_607_488, 'F16', { mmproj: true }),
];

/** the user's machine: what the hub's picker is given on it (`hw.ramGiB`). */
const MAC_24GB = { totalRamGB: 24, mmprojBytes: 931_146_432 };

/** The file a pick names, or why there is none — what the tests read. */
const pathOf = (pick: ReturnType<typeof pickHfDownload>) =>
  pick.kind === 'file' ? pick.file.path : pick.kind;

describe('pickHfDownload — Download without opening the picker', () => {
  it('fetches the pick the picker pins, not the first file of the listing', () => {
    const pinned = recommendedQuant(hfLadder(QWEN38_27B).options, MAC_24GB);
    const pick = pickHfDownload(QWEN38_27B, MAC_24GB);
    expect(pinned?.quant).toBe('UD-Q3_K_XL');
    expect(pick).toMatchObject({ kind: 'file', quant: 'UD-Q3_K_XL' });
    // Before: BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf — 50 GB of a 54.7 GB
    // model that cannot load on the machine it was downloaded for.
    expect(pathOf(pick)).toBe('Qwen3.8-27B-UD-Q3_K_XL.gguf');
  });

  it('agrees with the picker on every machine size, whatever order the listing comes in', () => {
    const shuffled = [...QWEN38_27B].reverse();
    for (const totalRamGB of [8, 12, 16, 24, 32, 48, 64, 96, 128, 256]) {
      const fit = { totalRamGB, mmprojBytes: MAC_24GB.mmprojBytes };
      const pinned = recommendedQuant(hfLadder(QWEN38_27B).options, fit)?.quant;
      for (const listing of [QWEN38_27B, shuffled]) {
        expect(pickHfDownload(listing, fit)).toMatchObject({ kind: 'file', quant: pinned });
      }
    }
  });

  it('prefers what is already on disk, exactly as the picker does', () => {
    const onDisk = (q: string) => q === 'Q4_0';
    const pinned = recommendedQuant(hfLadder(QWEN38_27B).options, MAC_24GB, onDisk);
    expect(pinned?.quant).toBe('Q4_0');
    expect(pathOf(pickHfDownload(QWEN38_27B, MAC_24GB, { isDownloaded: onDisk }))).toBe(
      'Qwen3.8-27B-Q4_0.gguf',
    );
  });

  it('brings the projector and the speed head along, as the download always did', () => {
    const pick = pickHfDownload(QWEN38_27B, MAC_24GB);
    expect(pick.kind === 'file' ? pick.mmproj?.path : undefined).toBe('mmproj-BF16.gguf');
    expect(pick.kind === 'file' ? pick.mtpFile?.path : undefined).toBe(
      'MTP/mtp-Qwen3.8-27B-Q4_0.gguf',
    );
  });
});

describe('pickHfDownload — a label the picker showed', () => {
  it('finds the weights, not the speed head that shares their label', () => {
    // Before: MTP/mtp-Qwen3.8-27B-Q4_0.gguf, the 1.4 GB draft head, which sorts
    // first — registered as the model.
    const pick = pickHfDownload(QWEN38_27B, MAC_24GB, { quant: 'Q4_0' });
    expect(pathOf(pick)).toBe('Qwen3.8-27B-Q4_0.gguf');
    expect(pick.kind === 'file' ? pick.file.sizeBytes : 0).toBe(16_056_478_688);
  });

  it('never resolves a label to a projector', () => {
    const listing = [
      f('mmproj-F16.gguf', 0.9e9, 'F16', { mmproj: true }),
      f('m-F16.gguf', 8e9, 'F16'),
    ];
    expect(pathOf(pickHfDownload(listing, MAC_24GB, { quant: 'F16' }))).toBe('m-F16.gguf');
  });

  it('says so when the label is not in the listing, rather than fetching something else', () => {
    expect(pickHfDownload(QWEN38_27B, MAC_24GB, { quant: 'Q3_K_M' })).toEqual({
      kind: 'missing',
      quant: 'Q3_K_M',
    });
  });
});

describe('split quants are not offered', () => {
  it('leaves BF16 out of the ladder — its Download could only fetch shard 1', () => {
    const ladder = hfLadder(QWEN38_27B);
    expect(ladder.options.map((o) => o.quant)).not.toContain('BF16');
    expect(ladder.split.get('BF16')).toBe(2);
    // …and nothing that is not a model got in either.
    expect(ladder.options.map((o) => o.quant)).not.toContain('imatrix_unsloth');
    expect(ladder.options.filter((o) => o.quant === 'Q4_0')).toEqual([
      { quant: 'Q4_0', bytes: 16_056_478_688 },
    ]);
    // 30 files: 24 single-file quants, BF16 in two parts, a head, an imatrix, two projectors.
    expect(ladder.options).toHaveLength(24);
  });

  it('refuses a split quant asked for by name', () => {
    expect(pickHfDownload(QWEN38_27B, MAC_24GB, { quant: 'BF16' })).toEqual({
      kind: 'split',
      quant: 'BF16',
      parts: 2,
    });
  });

  it('never recommends one, even where it is the biggest file that fits', () => {
    // With BF16 in the ladder, a 128 GB machine was recommended the 54.7 GB
    // split — the largest thing that fits — and only its first shard moved.
    const big = { totalRamGB: 128, mmprojBytes: MAC_24GB.mmprojBytes };
    expect(pathOf(pickHfDownload(QWEN38_27B, big))).toBe('Qwen3.8-27B-UD-Q8_K_XL.gguf');
  });

  it('a lone file named as a part is split too', () => {
    const listing = [
      f('Q4_K_M/big-Q4_K_M-00001-of-00003.gguf', 30e9, 'Q4_K_M'),
      f('big-Q2_K.gguf', 20e9, 'Q2_K'),
    ];
    expect(hfLadder(listing).options.map((o) => o.quant)).toEqual(['Q2_K']);
  });

  it('a repo that only publishes split quants says that, not "no weights"', () => {
    const listing = [
      f('A/m-Q4_K_M-00001-of-00002.gguf', 30e9, 'Q4_K_M'),
      f('A/m-Q4_K_M-00002-of-00002.gguf', 30e9, 'Q4_K_M'),
    ];
    expect(pickHfDownload(listing, MAC_24GB)).toEqual({ kind: 'split' });
  });
});

describe('nothing to fetch', () => {
  it('an empty listing (an image model, a safetensors repo) is "none"', () => {
    expect(pickHfDownload([], MAC_24GB)).toEqual({ kind: 'none' });
  });

  it('projectors, heads and an imatrix alone are not a model', () => {
    const listing = QWEN38_27B.filter((x) => x.mmproj === true || x.mtp === true || !x.quant);
    expect(hfLadder(listing).options).toEqual([]);
    expect(pickHfDownload(listing, MAC_24GB)).toEqual({ kind: 'none' });
  });
});

describe('quantLabel', () => {
  it('uses the parsed quant when it looks like one', () => {
    expect(quantLabel('UD-Q3_K_XL', 'Qwen3.8-27B-UD-Q3_K_XL.gguf')).toBe('UD-Q3_K_XL');
  });

  it('pulls the quant out of the filename when the parse fell back to it', () => {
    expect(quantLabel('model-Q4_K_M.gguf', 'x/model-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantLabel(undefined, 'Qwen3.8-27B-UD-IQ3_XXS.gguf')).toBe('UD-IQ3_XXS');
  });

  it('falls back to the stem when there is no quant in it at all', () => {
    expect(quantLabel(undefined, 'imatrix_unsloth.gguf')).toBe('imatrix_unsloth');
  });
});

describe('pickRefusal — saying which half failed', () => {
  const repo = 'unsloth/Qwen3.8-27B-GGUF';

  it('a repo with no GGUF is an image/video/audio model, and says so', () => {
    expect(pickRefusal(repo, { kind: 'none' })).toBe(
      `${repo} publishes no GGUF weights. The generation stack fetches it on first use.`,
    );
  });

  it('a listing that never arrived is not called a repo without weights', () => {
    const said = pickRefusal(repo, { kind: 'none' }, 'Could not reach Hugging Face.');
    expect(said).toContain('Could not reach Hugging Face.');
    expect(said).not.toContain('publishes no GGUF');
  });

  it('a split quant names itself and what to do instead', () => {
    expect(pickRefusal(repo, { kind: 'split', quant: 'BF16', parts: 2 })).toBe(
      'BF16 is split into 2 files, and Bobble can only download single-file quants for now. Pick another from the list.',
    );
    expect(pickRefusal(repo, { kind: 'split' })).toContain(`Every quant of ${repo} is split`);
  });

  it('a label that went missing says it is missing', () => {
    expect(pickRefusal(repo, { kind: 'missing', quant: 'Q3_K_M' })).toBe(
      `${repo} no longer lists Q3_K_M. Pick another from the list.`,
    );
  });
});
