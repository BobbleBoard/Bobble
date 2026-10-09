import { EditableMessage, MessageActions, MessageRow } from '@pi-desktop/ui';
import { type JSX, useState } from 'react';
import type { LoaderVariant } from '../chat/bobble-anim';
import { type PendingKind, PendingMediaCard } from '../media/PendingMediaCard';
import type { StudioJobState, StudioRun } from './use-studio';

/** The prompt to the clipboard — the same gesture as a chat message's Copy. */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

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
 * once the result lands. The user allowed "a quick smooth resize … in case of
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
  /** The model they chose, when they chose one (kept for the job record; the
   * header no longer prints it — the user, 2026-09-17). */
  model?: string;
  /** Which closing act the loader plays — this studio's modality. */
  variant?: LoaderVariant;
  /** The card has finished uncovering the result. */
  onRevealed?: () => void;
}): JSX.Element {
  /*
   * THE CARD THE RESULT WILL OCCUPY, MOUNTED EARLY AND EMPTY.
   *
   * The user, on the row that used to be here — a thumbnail, a sentence about the
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
  void model;
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
        <MessageRow kind="user" actions={<MessageActions onCopy={() => copyText(job.prompt)} />}>
          <span className="pd-studio-run-prompt" data-testid="studio-run-prompt">
            {job.prompt}
          </span>
        </MessageRow>
      </header>
      <PendingMediaCard
        kind={kind}
        label={job.prompt}
        /* One number per job across leaving and coming back: the card that
           mounts on return continues the pill rather than counting up from 0. */
        progressKey={`studio:${kind}:${job.startedAt}`}
        edit={job.edit === true}
        {...(aspect === undefined ? {} : { aspect })}
        {...(width === undefined ? {} : { width })}
        {...(hasSteps ? { progress: frac, steps: job.total } : {})}
        {...(job.note === undefined ? {} : { note: job.note })}
        {...(job.items !== undefined && job.items.length > 0 ? { item: job.items[0] } : {})}
        {...(onRevealed === undefined ? {} : { onRevealed })}
      />
    </section>
  );
}

/**
 * The line above a finished run: what you asked for, as the chat shows what
 * you asked for.
 *
 * It used to print the model and the seed under the bubble with a blue "Edit
 * prompt" link that put the sentence back in the composer. The user (2026-09-17):
 * "editing prompt isn't reusing the already good and same ui from the chat
 * interface" and "no showing model seed and blue edit prompt text below the
 * message". So the bubble is the chat's own MessageRow — hover for Copy and
 * Edit — and Edit turns the bubble into the chat's in-place editor; Save
 * generates again with the edited prompt, the way saving an edited chat
 * message re-sends it. The model and seed still ride with the run (the card's
 * "Use as input" carries them); they are no longer a caption.
 */
export function RunHeader({
  run,
  onAgain,
}: {
  run: StudioRun;
  /** Generate again with this prompt (the edited one when it was edited). */
  onAgain: (prompt: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <header className="pd-studio-run-head" data-editing={editing ? 'true' : undefined}>
      {editing ? (
        <EditableMessage
          data-testid="studio-editing-prompt"
          value={run.prompt}
          editing
          saveLabel="Generate"
          onSave={(text) => {
            setEditing(false);
            const next = text.trim();
            if (next.length > 0) onAgain(next);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <MessageRow
          kind="user"
          actions={
            <MessageActions onCopy={() => copyText(run.prompt)} onEdit={() => setEditing(true)} />
          }
        >
          <span className="pd-studio-run-prompt" data-testid="studio-run-prompt">
            {run.prompt}
          </span>
        </MessageRow>
      )}
    </header>
  );
}
