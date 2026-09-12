import type { JSX } from 'react';
import type { LoaderVariant } from '../chat/bobble-anim';
import { type PendingKind, PendingMediaCard } from '../media/PendingMediaCard';
import type { StudioJobState, StudioRun } from './use-studio';

/** mm:ss, because "127s" is not how anyone reads a wait. */
function _clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/**
 * What a running job should SAY it is doing, and how long it should claim is
 * left. Pure, and separated from the component, because the arithmetic is where
 * the bug was: `frac` is exactly 1 on the last step, so "about 0s left" sat on
 * screen for the 45 seconds of VAE decode and file write that follow it.
 */
export function jobStage(job: {
  readonly step?: number;
  readonly total?: number;
  readonly note?: string;
}): 'preparing' | 'stepping' | 'finishing' {
  const hasSteps = job.total !== undefined && job.total > 0 && job.step !== undefined;
  if (!hasSteps) return 'preparing';
  return (job.step ?? 0) >= (job.total ?? 1) ? 'finishing' : 'stepping';
}

/**
 * Milliseconds left, or undefined when there is no honest estimate.
 *
 * Undefined before two steps have landed (an estimate from one sample is a
 * guess with a number on it) and undefined once the steps are done (the work
 * that remains is not measured in steps).
 */
export function remainingMs(
  job: { readonly step?: number; readonly total?: number },
  elapsed: number,
): number | undefined {
  if (jobStage(job) !== 'stepping') return undefined;
  const frac = Math.min(1, (job.step ?? 0) / (job.total ?? 1));
  if ((job.step ?? 0) < 2 || frac <= 0) return undefined;
  return Math.round(elapsed / frac - elapsed);
}

/**
 * `"768x432"` → 1.777…
 *
 * The studio already knows the shape the reader chose, so the pending card can
 * be the right rectangle from its first frame rather than a square that resizes
 * once the result lands. the user allowed "a quick smooth resize … in case of
 * necessity" — this is what makes it unnecessary in the common case.
 */
export function aspectOf(size: string | undefined): number | undefined {
  if (size === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i.exec(size.trim());
  if (m === null) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : undefined;
}

/** `"768x432"` → 768, for the pending frame's width. */
export function widthOf(size: string | undefined): number | undefined {
  if (size === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*x\s*\d+/i.exec(size.trim());
  if (m === null) return undefined;
  const w = Number(m[1]);
  return w > 0 ? w : undefined;
}

export function StudioJob({
  job,
  variant = 'image',
  aspect,
  width,
  model,
  onRevealed,
}: {
  job: StudioJobState;
  /** The shape the reader asked for, so the box does not have to guess. */
  aspect?: number;
  /** The width they asked for, in px — the frame takes it, capped by the
   * column exactly as the finished card is, so the two are the same width. */
  width?: number;
  /** The model they chose, when they chose one — the header's fact line. */
  model?: string;
  /** Which closing act the loader plays — this studio's modality. */
  variant?: LoaderVariant;
  /** The card has finished uncovering the result. */
  onRevealed?: () => void;
}): JSX.Element {
  /*
   * THE CARD THE RESULT WILL OCCUPY, MOUNTED EARLY AND EMPTY.
   *
   * the user, on the row that used to be here — a thumbnail, a sentence about the
   * engine, an elapsed clock and a Stop button: "this type of card is not what I
   * want, just the same final video card, same final image card, same final 3d
   * card … just that container you have the animations in and then below it,
   * just floating, a white progress bar."
   *
   * Everything that row said is either already on screen or not worth a line of
   * chrome under every generation: the prompt is in the composer the reader just
   * typed it into, the elapsed clock measured the wait rather than shortening it,
   * and Stop moved to the button they pressed to start (StudioShell). What is
   * left is the frame and the bar, which is the ask.
   *
   * The step count still reaches the bar as a fraction — the honest number when
   * there is one — and the engine's own note is the caption when there is not.
   */
  const hasSteps = job.total !== undefined && job.total > 0 && job.step !== undefined;
  const frac = hasSteps ? Math.min(1, (job.step ?? 0) / (job.total ?? 1)) : 0;
  const kind: PendingKind =
    variant === 'video'
      ? 'video'
      : variant === '3d'
        ? 'model'
        : variant === 'audio'
          ? 'audio'
          : 'image';

  return (
    <section className="pd-studio-run" data-testid="studio-job">
      {/*
        THE SAME HEADER THE FINISHED RUN HAS, so the card does not move at the
        handover. SEEN: without it the finished run mounted its prompt bubble
        and fact line above the card and the card dropped 77px at the exact
        moment the picture arrived — the one jump the reveal exists to avoid.
        The fact line is the model when one was chosen; the seed is the
        engine's and arrives with the result.
      */}
      <header className="pd-studio-run-head" data-pending="true">
        <p className="pd-studio-run-prompt">{job.prompt}</p>
        <div className="pd-studio-run-meta">
          <span className="pd-studio-run-facts">
            {model !== undefined && model !== '' ? model : '\u00a0'}
          </span>
        </div>
      </header>
      <PendingMediaCard
        kind={kind}
        label={job.prompt}
        {...(aspect === undefined ? {} : { aspect })}
        {...(width === undefined ? {} : { width })}
        {...(hasSteps ? { progress: frac } : {})}
        {...(job.note === undefined ? {} : { note: job.note })}
        {...(job.items !== undefined && job.items.length > 0 ? { item: job.items[0] } : {})}
        {...(onRevealed === undefined ? {} : { onRevealed })}
      />
    </section>
  );
}

/**
 * The line above a finished run: what you asked for, what made it, and the way
 * back into iterating on it.
 *
 * The seed and model come back from the engine on every output and used to be
 * dropped at the boundary — which made "that one was great, give me more like
 * it" unanswerable. Putting the prompt back in the composer is the actual loop
 * this room exists for, and it previously required retyping the sentence.
 */
export function RunHeader({ run, onAgain }: { run: StudioRun; onAgain: () => void }): JSX.Element {
  const facts = [run.model, run.seed !== undefined ? `seed ${run.seed}` : undefined]
    .filter((v): v is string => v !== undefined && v !== '')
    .join(' · ');
  return (
    <header className="pd-studio-run-head">
      <p className="pd-studio-run-prompt">{run.prompt}</p>
      <div className="pd-studio-run-meta">
        {facts !== '' ? <span className="pd-studio-run-facts">{facts}</span> : null}
        <button
          type="button"
          className="pd-studio-run-again pd-focusable"
          data-testid="studio-again"
          onClick={onAgain}
        >
          Edit prompt
        </button>
      </div>
    </header>
  );
}
