/**
 * A DOWNLOAD IN FLIGHT: a bar and a way to stop it. Nothing else.
 *
 * the user: "the download button (quick one in the card) needs to be replaced with a
 * simple ---------- X progressbar and X button al centered circle red hover on x
 * blue and light blue for progress on the bar. no % needed pin this to the top
 * bar easily cancellable from anywhere and monitorable."
 *
 * NO PERCENTAGE, deliberately, and it is the instruction that shapes the rest.
 * A number invites you to watch it; a bar tells you the same thing at a glance
 * and lets you look away. That is also why this had to become one small piece
 * rather than three: the same control belongs in the family row, in the model
 * card, and pinned to the top bar, and three lookalikes would drift.
 *
 * THE INDETERMINATE CASE IS REAL. A repo's file tree has to be listed before a
 * byte moves, and on a large one that is a second or two with no total to divide
 * by. A bar parked at zero reads as stalled, so it sweeps instead — "started,
 * size not known yet" rather than "no progress".
 *
 * THE X IS RED ON HOVER, not at rest: cancelling discards what has arrived, so
 * the control should look destructive under the pointer that is about to press
 * it without shouting at everyone who is merely watching a download finish.
 */
import { IconClose } from '@pi-desktop/ui';
import type { JSX } from 'react';
import { cx } from '../onboarding/cx';

export interface DownloadBarProps {
  /** 0..1, or null while the size is still unknown (draws as a sweep). */
  readonly fraction: number | null;
  readonly onCancel: () => void;
  /** Tooltip on the X — which download this is, when several could be running. */
  readonly label?: string;
  /** Fill the row it sits in rather than taking a fixed width. */
  readonly grow?: boolean;
  readonly testid?: string;
}

export function DownloadBar({
  fraction,
  onCancel,
  label = 'Cancel download',
  grow = false,
  testid = 'download-bar',
}: DownloadBarProps): JSX.Element {
  const pct = fraction === null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <span
      className={cx('flex items-center gap-2', grow ? 'min-w-0 flex-1' : 'w-40 shrink-0')}
      data-testid={`${testid}-wrap`}
    >
      <span
        className="pd-dl-track"
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct === null ? {} : { 'aria-valuenow': pct })}
        data-testid={testid}
        data-fraction={pct ?? 'indeterminate'}
      >
        <span
          className={cx('pd-dl-fill', pct === null && 'pd-dl-fill--sweep')}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </span>
      <button
        type="button"
        aria-label={label}
        title={label}
        data-testid={`${testid}-cancel`}
        onClick={onCancel}
        className="pd-dl-x pd-focusable"
      >
        <IconClose size={12} />
      </button>
    </span>
  );
}
