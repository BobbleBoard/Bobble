/**
 * A GENERATION IN FLIGHT, AND THE HEADER OVER A FINISHED ONE.
 *
 * These rooms make you wait — tens of seconds for a picture, minutes for a clip
 * — and the entire apparatus for saying so used to be the run button turning
 * into the word "Working…" at half opacity in the corner of the composer. Three
 * independent design reviews of the shipped build put this at the top of their
 * list, and all three noticed the same thing: the backend already streams
 * step-accurate progress and decoded preview frames on this exact code path.
 * Nothing in the room was listening.
 *
 * So the job appears where the result will appear, the moment you press: same
 * place, same size, turning into the thing it becomes. A determinate bar when
 * the backend counts steps, elapsed time always, and a Stop that reaches the
 * `gen:cancel` that has existed all along and that no studio ever called.
 */
import { Button } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
import { BobbleTileLoader } from '../chat/BobbleMark';
import type { StudioJobState, StudioRun } from './use-studio';

/** mm:ss, because "127s" is not how anyone reads a wait. */
function clock(ms: number): string {
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

export function StudioJob({
  job,
  onCancel,
}: {
  job: StudioJobState;
  onCancel: () => void;
}): JSX.Element {
  // Elapsed ticks once a second — the one number we can always honestly show.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = now - job.startedAt;
  const hasSteps = job.total !== undefined && job.total > 0 && job.step !== undefined;
  const frac = hasSteps ? Math.min(1, (job.step ?? 0) / (job.total ?? 1)) : 0;
  /*
   * REMAINING, NOT PERCENT. Diffusion steps are uniform, so elapsed-per-step is
   * a sound estimate — and "about a minute left" is the question being asked.
   * Only shown once a couple of steps have landed, because an estimate from one
   * sample is a guess with a number on it.
   */
  /*
   * THE STEPS ARE NOT THE WHOLE JOB. After the last one the engine still decodes
   * the latents through the VAE and writes the file, and at 1024² that is not
   * quick. MEASURED on a real edit run: 45 seconds of "Step 8 of 8 · about 0s
   * left". See jobStage / remainingMs above.
   */
  const stepsDone = jobStage(job) === 'finishing';
  const remaining = remainingMs(job, elapsed);

  return (
    <section className="pd-studio-job" data-testid="studio-job">
      <div className="pd-studio-job-media">
        {job.previewSrc !== undefined ? (
          // The picture as it resolves. Nothing else says "this is working" as
          // convincingly as watching it happen.
          //
          // It works now, too: these srcs were `file://` URLs and the renderer's
          // CSP has never allowed that scheme, so every decoded step this room
          // waited for was refused before it painted. See gen-manager's toSrc.
          <img className="pd-studio-job-preview" src={job.previewSrc} alt="" />
        ) : (
          /*
           * THE SAME WAIT AS THE THREAD'S. A generic shimmer here and the app's
           * own sliding-tile mark in the chat would be two different answers to
           * one question, from one engine, three inches apart in the same app —
           * which is how a studio and a conversation stop looking like the same
           * product. The shimmer stays as the ground underneath it.
           */
          <div className="pd-studio-job-shimmer" aria-hidden="true">
            <BobbleTileLoader size={40} label="Working" />
          </div>
        )}
      </div>
      <div className="pd-studio-job-side">
        <p className="pd-studio-job-prompt">{job.prompt}</p>
        <div
          className="pd-studio-job-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={hasSteps ? (job.total ?? 1) : undefined}
          aria-valuenow={hasSteps ? job.step : undefined}
        >
          <div
            className="pd-studio-job-fill"
            data-indeterminate={hasSteps ? undefined : 'true'}
            style={hasSteps ? { width: `${Math.round(frac * 100)}%` } : undefined}
          />
        </div>
        <p className="pd-studio-job-meta" data-testid="studio-job-meta">
          {/*
            "Starting…" for four minutes is what "it doesn't work" looks like.
            Before there are steps to count, say what the engine itself says it
            is doing — installing its runtime, fetching weights, loading a model
            (the user). Once steps arrive they are the better answer and win.
          */}
          {stepsDone
            ? /* Whatever the worker last said it was doing, if it said
                 anything; otherwise name the work that is left, because it is
                 always the same work. */
              (job.note ?? 'Finishing — decoding the picture and saving it')
            : hasSteps
              ? `Step ${job.step} of ${job.total}`
              : /* MEASURED on an M5 Pro with the weights already cached: 94
                 seconds from pressing Generate to the first step. "Starting…"
                 for a minute and a half is why the user read this room as broken;
                 saying how long it takes is the honest version. */
                (job.note ?? 'Preparing the engine — the first run can take a minute or two')}
          <span className="pd-studio-job-dot">·</span>
          {clock(elapsed)} elapsed
          {remaining !== undefined ? (
            <>
              <span className="pd-studio-job-dot">·</span>
              about {clock(remaining)} left
            </>
          ) : null}
        </p>
        {/* Only when there is something to stop — i.e. once a job event has
            named the job this room is watching. Audio used to stream none (the
            gen manager built its events and threw them away, because the only
            consumer was a canvas tab that could not draw a sound), so a Stop
            here was dead by construction. It streams now, so it is not. */}
        {job.cancellable ? (
          <Button size="sm" variant="secondary" data-testid="studio-cancel" onClick={onCancel}>
            Stop
          </Button>
        ) : null}
      </div>
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
