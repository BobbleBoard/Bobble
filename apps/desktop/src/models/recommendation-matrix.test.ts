import { describe, it } from 'vitest';
import { hostFor, quickPickFor, recommendAll } from './model-recommender';
import { fitFor, RECOMMENDED_FAMILIES } from './recommended-catalog';

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

  /*
   * AND EVERY FAMILY'S QUICK DOWNLOAD — the same judgement scoped to one
   * family, so it runs on the same host (★ = a family Top Recommended picks
   * from). `≠` marks where total RAM, which FamilyCard used to pass as the
   * budget, fetches something else, with the verdict that variant's own row
   * shows. Printing this is how that mismatch was found: 18 family × machine
   * pairs on 8–32 GB Macs, none at 64, and a 32 GB budget on a 12 GB card.
   */
  it('prints what every family’s Quick Download fetches, and where total RAM would not', () => {
    const machines: Array<[string, number, number | undefined]> = [
      ['8 GB Mac', 8, undefined],
      ['16 GB Mac', 16, undefined],
      ['24 GB Mac (this Mac)', 24, undefined],
      ['32 GB Mac', 32, undefined],
      ['64 GB Mac', 64, undefined],
      ['RTX 3060 12 GB, 32 GB RAM', 32, 12],
    ];
    const said = (p: ReturnType<typeof quickPickFor>): string =>
      p === undefined
        ? '—'
        : `${p.variant.label}${p.quant === undefined ? '' : ` ${p.quant.rung.quant}`} · ${p.needsGB} GB`;
    for (const [name, total, vram] of machines) {
      const host = hostFor({
        totalRamGB: total,
        ...(vram === undefined ? {} : { usableMemoryGB: vram }),
      });
      const top = new Set(Object.values(recommendAll(host)).map((r) => r.family.id));
      const lines: string[] = [];
      let differ = 0;
      for (const f of RECOMMENDED_FAMILIES) {
        const pick = quickPickFor(f, host);
        const asTotal = quickPickFor(f, { usableMemoryGB: total, totalRamGB: total });
        const same = asTotal?.variant === pick?.variant;
        if (!same) differ += 1;
        const was = same
          ? ''
          : `≠ ${total} GB: ${said(asTotal)}${asTotal === undefined ? '' : ` (${fitFor(asTotal.variant, total)})`}`;
        lines.push(
          `   ${top.has(f.id) ? '★' : ' '} ${f.name.padEnd(22)} ${said(pick).padEnd(34)} ${was}`,
        );
      }
      console.log(
        `\n── ${name}: Quick Download at ${host.usableMemoryGB} GB — ${differ} famil${differ === 1 ? 'y differs' : 'ies differ'} at ${total} GB`,
      );
      console.log(lines.join('\n'));
    }
  });
});
