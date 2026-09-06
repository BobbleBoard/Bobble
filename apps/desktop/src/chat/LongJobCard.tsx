/**
 * The card in front of a job you will be waiting on: what it is, how long it
 * usually takes on this Mac, how long it has actually taken so far, and a way
 * out. See {@link jobView} for the copy rules and why each part is there.
 *
 * The "evidence of life" the tester asked for is passed IN as `children` — for
 * an image that is the live denoise preview, which is a far better answer than
 * any spinner this card could draw. The card is the frame around it: the words,
 * the clock and the Cancel.
 */
import { useEffect, useState } from 'react';
import { jobSamples } from './job-history';
import { estimateFor, type JobKind, jobView, shouldShowCard } from './long-job';

export function LongJobCard({
  kind,
  startedAt,
  onCancel,
  children,
}: {
  kind: JobKind;
  /** performance-clock-independent epoch ms the job started. */
  startedAt: number;
  onCancel: () => void;
  children?: React.ReactNode;
}): React.ReactElement | null {
  // One tick a second: the timer is the proof of life for a job with nothing
  // else to show, so it must move even when nothing else does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsedMs = Math.max(0, now - startedAt);
  if (!shouldShowCard(kind, elapsedMs)) return null;

  const view = jobView(kind, elapsedMs, estimateFor(kind, jobSamples(kind)));
  return (
    <div
      className="pd-longjob"
      data-testid="long-job-card"
      data-kind={kind}
      data-overrun={view.overrun}
    >
      {children !== undefined ? <div className="pd-longjob-life">{children}</div> : null}
      <div className="pd-longjob-row">
        <div className="min-w-0">
          <div className="truncate text-footnote text-text-secondary" data-testid="long-job-title">
            {view.title}
          </div>
          <div className="truncate text-caption text-text-muted" data-testid="long-job-estimate">
            {view.estimate}
          </div>
        </div>
        <span className="pd-longjob-timer" data-testid="long-job-timer">
          {view.timer}
        </span>
        <button
          type="button"
          className="pd-btn-ghost pd-focusable pd-longjob-cancel"
          data-testid="long-job-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {view.overrunText !== null ? (
        <div className="pd-longjob-overrun" data-testid="long-job-overrun">
          {view.overrunText}
        </div>
      ) : null}
    </div>
  );
}
