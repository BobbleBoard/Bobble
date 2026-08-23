/**
 * WHAT THIS MACHINE SHOULD RUN — one card per modality, at the top of the hub.
 *
 * the user: "for now, in model manager->reccomended, you just show these as the top
 * things in each modality… this is the core of the entire idea."
 *
 * WHAT EACH CARD HAS TO SAY, and why nothing less will do. A recommendation
 * nobody believes is worse than none, because it teaches people to scroll past
 * the thing that was supposed to save them the research. So every card carries:
 *
 *   - the MODEL and the exact variant, not a family name that could mean any of
 *     six downloads;
 *   - the QUANT, when there was a choice to make, because that is the decision
 *     a person who knows what they are doing would have made by hand;
 *   - the MEMORY it expects to need against what this machine has — the number
 *     the whole thing turns on;
 *   - the ENGINE that will run it, and where a better one exists that we have
 *     not integrated, that too. Hiding the gap would make the ranking a claim
 *     rather than a report.
 *
 * The reason line is written per family in model-recommender.ts, where the
 * judgement lives, rather than assembled here from adjectives.
 */
import type { JSX } from 'react';
import type { LlmHardware } from '../../electron/ipc-contract';
import { OrgAvatar } from '../settings/brand-icons';
import { formatOfRepo, pickEngine, summarisePick } from '../settings/engine-picker';
import { type ModelRecommendation, recommendAll } from './model-recommender';
import { compactBytes } from './models-layout';
import { Pill } from './Pill';
import { OUTPUT_LABEL, type OutputModality } from './recommended-catalog';

export interface BestForYourMachineProps {
  readonly hardware: LlmHardware | null;
  /** Repos already on disk, so a card can say it is done rather than offering it. */
  readonly downloaded: ReadonlySet<string>;
  readonly installedEngines: readonly string[];
  readonly onSelect: (repo: string) => void;
  readonly onDownload: (rec: ModelRecommendation) => void;
}

/** The machine as the two recommenders need it, from the IPC's hardware DTO. */
function hostsFrom(hw: LlmHardware) {
  const usable = hw.usableMemoryGB ?? Math.max(1, Math.round(hw.totalRamGB * 0.75));
  return {
    recommender: { usableMemoryGB: usable, totalRamGB: hw.totalRamGB },
    picker: {
      platform: hw.platform ?? 'darwin',
      appleSilicon: hw.isAppleSilicon,
      gpuVendor: hw.gpuVendor ?? (hw.isAppleSilicon ? ('apple' as const) : ('unknown' as const)),
      ...(hw.cudaMajor === undefined ? {} : { cudaMajor: hw.cudaMajor }),
      npu: hw.npu ?? false,
      usableMemoryGB: usable,
    },
  };
}

function Card({
  rec,
  hardware,
  downloaded,
  installedEngines,
  onSelect,
  onDownload,
}: {
  rec: ModelRecommendation;
  hardware: LlmHardware;
  downloaded: ReadonlySet<string>;
  installedEngines: readonly string[];
  onSelect: (repo: string) => void;
  onDownload: (rec: ModelRecommendation) => void;
}): JSX.Element {
  const { picker } = hostsFrom(hardware);
  const pick = pickEngine(
    {
      repo: rec.variant.repo,
      modality: rec.modality,
      format: formatOfRepo(rec.variant.repo, rec.variant.allow ?? []),
    },
    picker,
    installedEngines,
  );
  const engineLine = summarisePick(pick);
  const have = downloaded.has(rec.variant.repo);
  const size =
    rec.variant.approxBytes !== undefined ? compactBytes(rec.variant.approxBytes) : undefined;

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-raised p-3"
      data-testid={`best-${rec.modality}`}
    >
      <div className="flex items-center gap-2">
        <Pill tone="accent" testid={`best-modality-${rec.modality}`}>
          {OUTPUT_LABEL[rec.modality]}
        </Pill>
        {rec.quant !== undefined ? (
          <Pill tone="info" testid={`best-quant-${rec.modality}`}>
            {rec.quant.rung.quant}
          </Pill>
        ) : null}
        {have ? (
          <Pill tone="success" testid={`best-ondisk-${rec.modality}`}>
            On disk
          </Pill>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onSelect(rec.variant.repo)}
        className="pd-focusable flex min-w-0 items-center gap-2.5 text-left"
      >
        <OrgAvatar org={rec.family.org} size={28} />
        <span className="min-w-0">
          <span className="block truncate text-body text-text-primary">
            {rec.family.name} {rec.variant.label}
          </span>
          <span className="block truncate text-caption text-text-muted">
            {size ?? `${rec.needsGB} GB`} · needs {rec.needsGB} GB of {hardware.totalRamGB} GB
          </span>
        </span>
      </button>

      <p className="text-caption text-text-secondary">{rec.reason}</p>
      {engineLine !== undefined ? (
        <p className="text-caption text-text-muted" data-testid={`best-engine-${rec.modality}`}>
          Runs on {engineLine}
        </p>
      ) : null}

      {have ? null : (
        <button
          type="button"
          data-testid={`best-download-${rec.modality}`}
          onClick={() => onDownload(rec)}
          className="pd-focusable mt-1 rounded-lg bg-accent-primary px-2.5 py-1 text-caption font-medium text-text-on-accent transition-opacity hover:opacity-90"
        >
          Download
        </button>
      )}
    </div>
  );
}

export function BestForYourMachine({
  hardware,
  downloaded,
  installedEngines,
  onSelect,
  onDownload,
}: BestForYourMachineProps): JSX.Element | null {
  if (hardware === null) return null;
  const { recommender } = hostsFrom(hardware);
  const all = recommendAll(recommender);
  const order: OutputModality[] = ['text', 'image', 'video', 'audio', '3d'];
  const cards = order.map((m) => all[m]).filter((r): r is ModelRecommendation => r !== undefined);
  if (cards.length === 0) return null;

  const machine =
    hardware.gpuName !== undefined && hardware.gpuName.length > 0
      ? hardware.gpuName
      : (hardware.chip ?? 'this machine');
  const budget = hardware.usableMemoryGB ?? Math.round(hardware.totalRamGB * 0.75);

  return (
    <section className="mb-5" data-testid="best-for-your-machine">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-body font-medium text-text-primary">Best for your machine</h2>
        <span className="text-footnote text-text-muted">
          {machine} · {budget} GB to work with
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((rec) => (
          <Card
            key={rec.modality}
            rec={rec}
            hardware={hardware}
            downloaded={downloaded}
            installedEngines={installedEngines}
            onSelect={onSelect}
            onDownload={onDownload}
          />
        ))}
      </div>
    </section>
  );
}
