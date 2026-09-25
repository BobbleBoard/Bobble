/**
 * WHAT "USE" STARTS — decided once, here.
 *
 * Top Recommended's button says Use once the recommended repo is on disk, and
 * Use starts a model. It started `catalog.find((e) => e.hfRepo === repo)` at the
 * recommender's quant. Driven on unsloth/Qwen3.8-27B-GGUF on the 24 GB Mac, with
 * the start and every download refused in main (model-fit-ui-probe), it asked:
 *
 *   - `llm:start-server qwen3.8-27b-mtp · Q3_K_M` with the curated entry's
 *     UD-Q3_K_XL on disk. Q3_K_M is the recommender's ladder RUNG
 *     (quant-ladder.ts) — an estimate's name for a size class, which that repo
 *     does not publish — so the supervisor answers "unknown quant" and Use did
 *     nothing, under a card reading "12 GB · UD-Q3_K_XL".
 *   - `llm:download-model qwen3.8-27b-mtp · Q3_K_M` with only the hub's own
 *     download on disk. The hub registers what it fetches as a catalog entry of
 *     its own (`unsloth-qwen3-8-27b-gguf-ud-q3-k-xl`, from hf:register), and the
 *     FIRST entry naming the repo is the curated one, which was not downloaded —
 *     so Use set off a download, of a quant that does not exist, from the button
 *     of a model that was already here.
 *
 * So the choice is read off the disk: an entry of the repo with a quant on disk
 * (`downloadedQuants`, the supervisor's own disk truth), the hub's pick — the file
 * its Download fetches (hf-download.ts) — whenever that is here, and otherwise the
 * best of what is here by the picker's own ranking.
 */
import type { LlmCatalogEntry } from '../../electron/ipc-contract';
import { type QuantFitInput, recommendedQuant } from '../settings/model-manager-logic';

/** What the choice reads of a catalog entry. */
export type LocalEntry = Pick<
  LlmCatalogEntry,
  'id' | 'hfRepo' | 'quants' | 'downloadedQuants' | 'source'
>;

/** A model that Use can start without fetching anything. */
export interface LocalUse {
  /** The catalog entry to start: one whose file is on disk. */
  readonly modelId: string;
  /** A quant of that entry that is on disk. */
  readonly quant: string;
  /** Its size, for the card that names what Use starts (0 when unknown). */
  readonly bytes: number;
}

export interface LocalUseOptions {
  /**
   * The hub's pick for the repo — the file its Download fetches (`picks` in
   * ModelsView). Started whenever it is on disk.
   */
  readonly pick?: string;
  /** The picker's inputs, to rank what IS on disk when the pick is not. */
  readonly fit?: Omit<QuantFitInput, 'modelBytes'>;
}

/**
 * The entry and quant Use starts for `repo`, or undefined when nothing of it is
 * on disk. Never a quant that is not on disk, never an entry whose file is not.
 */
export function pickLocalUse(
  catalog: readonly LocalEntry[],
  repo: string,
  { pick, fit = { totalRamGB: 0 } }: LocalUseOptions = {},
): LocalUse | undefined {
  /*
   * CURATED BEFORE REGISTERED, when both hold a file. The same GGUF under the
   * curated entry launches with that entry's context window, chat template and
   * speculative settings; an entry the hub registered from a listing carries an
   * 8k window and none of the rest. The sort is stable, so the catalog's order
   * stands within each.
   */
  const entries = catalog
    .filter((e) => e.hfRepo === repo)
    .sort((a, b) => Number(a.source === 'hf') - Number(b.source === 'hf'));
  const held: LocalUse[] = entries.flatMap((e) =>
    (e.downloadedQuants ?? []).map((quant) => ({
      modelId: e.id,
      quant,
      bytes: e.quants.find((q) => q.quant === quant)?.bytes ?? 0,
    })),
  );
  if (held.length === 0) return undefined;
  const pinned = pick === undefined ? undefined : held.find((h) => h.quant === pick);
  if (pinned !== undefined) return pinned;
  /* The pick is not here: rank what is by the picker's own call, so a machine
     that cannot hold a 29 GB Q8_0 starts the 9.8 GB quant beside it. */
  const options = new Map<string, { quant: string; bytes: number }>();
  for (const h of held) {
    if (!options.has(h.quant)) options.set(h.quant, { quant: h.quant, bytes: h.bytes });
  }
  const best = recommendedQuant([...options.values()], fit)?.quant;
  return held.find((h) => h.quant === best) ?? held[0];
}
