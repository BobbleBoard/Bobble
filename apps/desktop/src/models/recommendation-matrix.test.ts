import { describe, it } from 'vitest';
import { recommendAll } from './model-recommender';

/**
 * THE MATRIX, PRINTED — every machine class against every modality.
 *
 * Not an assertion: a table, so the judgement calls can be READ rather than
 * inferred from a passing test. Running it is how three real bugs surfaced that
 * no unit test had caught — a GGUF quant ladder applied to a safetensors repo
 * ("Qwen3-VL 8B at Q3_K_M" for a model that publishes no GGUF), a size sort that
 * put every LTX-2.5 recipe below the 2B so a 96 GB workstation was offered the
 * small one, and a family that had welded Qwen3.6's sizes into Qwen3.8's card.
 *
 * Keep it. A recommender is a pile of judgement calls, and the cheapest way to
 * audit a pile of judgement calls is to look at all of them at once.
 */
describe('the recommendation matrix', () => {
  it('prints what every machine class is told to run', () => {
    const machines: Array<[string, number, number]> = [
      ['8 GB MacBook Air', 6, 8],
      ['16 GB laptop', 12, 16],
      ['24 GB M5 Pro (this Mac)', 18, 24],
      ['RTX 3060 12 GB', 12, 32],
      ['RTX 4090 24 GB', 24, 64],
      ['48 GB M4 Max', 36, 48],
      ['128 GB workstation', 96, 128],
    ];
    for (const [name, usable, total] of machines) {
      const all = recommendAll({ usableMemoryGB: usable, totalRamGB: total });
      console.log(`\n── ${name} (${usable} GB usable)`);
      for (const m of ['text', 'image', 'video', 'audio', '3d'] as const) {
        const r = all[m];
        const line = r
          ? `${`${r.family.name} ${r.variant.label}`.padEnd(32)} ${(r.quant?.rung.quant ?? '').padEnd(8)} ${r.needsGB} GB`
          : '— nothing fits';
        console.log(`   ${m.padEnd(6)} ${line}`);
      }
    }
  });
});
