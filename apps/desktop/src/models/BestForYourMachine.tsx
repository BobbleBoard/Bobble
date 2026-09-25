/**
 * THE TOP OF THE HUB: one card per modality, for whoever opens this app.
 *
 * the user, on the first version: "there's a lot of unnessasary info for users, for
 * example <size> is fine, but not immediately after putting needs <size> out of
 * <vram>. that's redundant. 'what the 3d studio generates with' 'runs on
 * comfyui' 'runs everywhere' doesn't need to be there either… don't display the
 * 'best for your machine' 'apple m5 pro' '18gb to work with' all that stuff
 * needs to go. keep in mind you're not talking to me when you write this you're
 * talking to any random user using this app."
 *
 * That last line is the whole brief. The first version was a report on the
 * reasoning — chip name, memory budget, which engine, why this model — because
 * that is what the person who ASKED for the system wants to see. A user does not
 * want the reasoning; they want the result, and every extra line pushes the one
 * thing they came for further down. So the card is now: what it is, how big, the
 * job it does, and a button.
 *
 * WHAT STAYED AND WHY:
 *   - the SIZE, once. It is the only number that changes what someone does next.
 *   - the QUANT, beside it, because two downloads of the same model differ by
 *     little else and someone who does not know what Q4 means loses nothing.
 *   - the HUGGING FACE TASK TAG, bottom left, per the user's "show the modality from
 *     HF eg. 'image-3d'" — it says what goes in and what comes out, in the
 *     vocabulary the rest of the ecosystem already uses.
 *   - one button, bottom right, half the card. "Use" when it is already here,
 *     which is why no separate on-disk badge is needed: the button IS the state.
 *
 * The reasoning did not disappear, it moved. Fit verdicts still live on the
 * family rows below, where someone comparing options is actually looking.
 */
import type { JSX } from 'react';
import { OrgAvatar } from '../settings/brand-icons';
import { Carousel } from './Carousel';
import { DownloadBar } from './DownloadBar';
import { type ModelRecommendation, type RecommenderHost, recommendAll } from './model-recommender';
import { compactBytes } from './models-layout';
import { Pill } from './Pill';
import { installKindOf, type ModelTask, type OutputModality } from './recommended-catalog';

export interface BestForYourMachineProps {
  /**
   * The machine to recommend for — the hub's `hostFor(hardware)`, the same one
   * every family's Quick Download decides against. null = not yet detected.
   */
  readonly host: RecommenderHost | null;
  /** Repos already on disk — decides whether the button offers or activates. */
  readonly downloaded: ReadonlySet<string>;
  readonly onSelect: (repo: string) => void;
  readonly onDownload: (rec: ModelRecommendation) => void;
  /** Already here: put it to work rather than fetching it again. */
  readonly onUse: (rec: ModelRecommendation) => void;
  readonly onCancel: (rec: ModelRecommendation) => void;
  /** Live transfers keyed by repo, so a card can become its own progress bar. */
  readonly progress?: Readonly<
    Record<string, { readonly received: number; readonly total: number; readonly fraction: number }>
  >;
  /**
   * The file each GGUF pick will fetch, by repo, once its listing has been read
   * — what the model's own picker pins and what Download asks for.
   */
  readonly picks?: Readonly<Record<string, { readonly quant: string; readonly bytes: number }>>;
}

/**
 * The Hugging Face task tag for a recommendation.
 *
 * Prefers the variant's own declared task, because a recipe knows exactly what
 * its files do (MiniMax's keyframe weights are `keyframes-to-video`, not
 * "video"). Falls back to the modality's ordinary tag, which is what the repo
 * would carry on the Hub anyway.
 */
const FALLBACK_TAG: Record<OutputModality, string> = {
  text: 'text-generation',
  image: 'text-to-image',
  video: 'text-to-video',
  audio: 'text-to-speech',
  '3d': 'image-to-3d',
};

export function taskTagFor(rec: {
  modality: OutputModality;
  tasks?: readonly ModelTask[];
}): string {
  return rec.tasks?.[0] ?? FALLBACK_TAG[rec.modality];
}

function Card({
  rec,
  downloaded,
  progress,
  pick,
  onSelect,
  onDownload,
  onUse,
  onCancel,
}: {
  rec: ModelRecommendation;
  downloaded: ReadonlySet<string>;
  progress?: { readonly received: number; readonly total: number; readonly fraction: number };
  pick?: { readonly quant: string; readonly bytes: number };
  onSelect: (repo: string) => void;
  onDownload: (rec: ModelRecommendation) => void;
  onUse: (rec: ModelRecommendation) => void;
  onCancel: (rec: ModelRecommendation) => void;
}): JSX.Element {
  const have = downloaded.has(rec.variant.repo);
  /*
   * A GGUF PICK NAMES THE FILE ITS BUTTON FETCHES. The recommender chose this
   * MODEL from a bytes-per-weight estimate and used to name the quant too —
   * "17.2 GB · Q3_K_M" on the 27B, a quant its repo does not publish, above a
   * picker that pinned UD-Q3_K_XL at 12 GB. Size and quant now come from the
   * repo's listing (`pick`), and until that arrives the line stays empty
   * rather than showing a guess it would then have to take back.
   */
  const ladder = rec.quant !== undefined && installKindOf(rec.family) === 'gguf';
  const size = ladder
    ? pick === undefined
      ? undefined
      : compactBytes(pick.bytes)
    : rec.variant.approxBytes !== undefined
      ? compactBytes(rec.variant.approxBytes)
      : `${rec.needsGB} GB`;
  const quant = ladder ? pick?.quant : rec.quant?.rung.quant;
  const tag = taskTagFor({
    modality: rec.modality,
    ...(rec.variant.tasks === undefined ? {} : { tasks: rec.variant.tasks }),
  });

  return (
    <div
      /* the user: "buffer between the download and edge, margins borders needed.
         bordering of the card something like shown or like a shadow, reasonably
         noticable, apply to all the cards aswell." A hairline `border-subtle` on
         a dark surface is invisible; this is the default border plus a real
         shadow, and p-4 keeps the footer button off the edge it was touching. */
      className="pd-hub-card flex w-[300px] shrink-0 flex-col gap-3 p-4"
      data-testid={`best-${rec.modality}`}
      data-repo={rec.variant.repo}
      data-variant={rec.variant.label}
    >
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
          <span
            className="block truncate text-caption text-text-muted"
            data-testid={`best-size-${rec.modality}`}
          >
            {/* A no-break space holds the line while the listing is on its way. */}
            {size ?? '\u00a0'}
            {quant === undefined ? '' : ` · ${quant}`}
          </span>
        </span>
      </button>

      {/* The footer: what it does, and the one thing to do about it. */}
      <div className="mt-auto flex items-center gap-2">
        <Pill tone="info" testid={`best-task-${rec.modality}`}>
          {tag}
        </Pill>
        {progress !== undefined ? (
          /* The button BECOMES the bar, in place and at the same width — the user:
             "blue download button changes to a blue bar that is most of the
             width of the button, however with some space left on the right for
             a red X button". */
          <span className="ml-auto flex w-1/2 items-center">
            <DownloadBar
              grow
              fraction={progress.total > 0 ? progress.fraction : null}
              received={progress.received}
              total={progress.total}
              label={`Cancel ${rec.family.name}`}
              testid={`best-progress-${rec.modality}`}
              onCancel={() => onCancel(rec)}
            />
          </span>
        ) : (
          <button
            type="button"
            data-testid={have ? `best-use-${rec.modality}` : `best-download-${rec.modality}`}
            onClick={() => (have ? onUse(rec) : onDownload(rec))}
            /* The pill ends where the word ends — the user: "no extra akward blue
               space left and right, don't stretch the pill excessively at all".
               So no width class: the padding sizes it, and `ml-auto` keeps it
               against the right edge without stretching to meet it. */
            className="pd-focusable ml-auto rounded-full bg-accent-primary px-4 py-1.5 text-body font-medium text-text-on-accent transition-opacity hover:opacity-90"
          >
            {have ? 'Use' : 'Download'}
          </button>
        )}
      </div>
    </div>
  );
}

export function BestForYourMachine({
  host,
  downloaded,
  progress = {},
  picks = {},
  onSelect,
  onDownload,
  onUse,
  onCancel,
}: BestForYourMachineProps): JSX.Element | null {
  if (host === null) return null;
  const all = recommendAll(host);
  const order: OutputModality[] = ['text', 'image', 'video', 'audio', '3d'];
  const cards = order.map((m) => all[m]).filter((r): r is ModelRecommendation => r !== undefined);
  if (cards.length === 0) return null;

  return (
    /* ONE ROW, scrolled sideways — the user: "top reccomended needs to be 1 row no
       stacking and h scrollable", with the edge arrows Unsloth uses. */
    <section className="mb-5" data-testid="best-for-your-machine">
      <Carousel testid="best-carousel">
        {cards.map((rec) => (
          <Card
            key={rec.modality}
            rec={rec}
            downloaded={downloaded}
            {...(progress[rec.variant.repo] === undefined
              ? {}
              : { progress: progress[rec.variant.repo] })}
            {...(picks[rec.variant.repo] === undefined ? {} : { pick: picks[rec.variant.repo] })}
            onSelect={onSelect}
            onDownload={onDownload}
            onUse={onUse}
            onCancel={onCancel}
          />
        ))}
      </Carousel>
    </section>
  );
}
