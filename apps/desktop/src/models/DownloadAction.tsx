/**
 * THE ONE-CLICK DOWNLOAD, AND HOW IT IS TAKEN BACK.
 *
 * the user: "there needs to be on every model card on the right a just 'Download'
 * button that immediately downloads recommended. download button turns into a
 * little progress bar and a red X, clicking x cancels (immediate feedback even
 * if download doesn't cancel immediately it shows up that way — progress bar
 * removes and download button restored, partial download auto cleaned and
 * deleted)."
 *
 * WHY ONE CONTROL RATHER THAN THREE. Download, progress and cancel are the same
 * affordance at three moments, so they occupy the same box and it changes shape.
 * A separate cancel button appearing elsewhere would make the user look for it,
 * and a progress bar somewhere other than where the button was would leave a
 * hole where they just clicked.
 *
 * THE QUANT IS NOT ASKED FOR. The recommendation already knows which file fits
 * this machine (`recommendedQuant`), and the ladder is still one click away
 * below. A picker in front of the download turns "get me this model" into a
 * question most people cannot answer, about a distinction they did not ask for.
 *
 * THE X IS DESTRUCTIVE AND LOOKS IT. Pausing keeps the `.part` file and cancel
 * throws it away, so cancel is red — the same reading as any other discard.
 */
import { IconArrowUp, IconCheck, IconClose } from '@pi-desktop/ui';
import type { JSX } from 'react';
import { cx } from '../onboarding/cx';
import { compactBytes } from './models-layout';

/** The set has no download glyph; a rotated arrow is the mark this hub uses. */
function IconDownload({ size = 14 }: { size?: number }) {
  return <IconArrowUp size={size} className="rotate-180" />;
}

export interface DownloadActionProps {
  /** Already on disk — the button becomes a statement rather than an action. */
  readonly installed: boolean;
  /** A download for THIS model is running (or has been asked for). */
  readonly busy: boolean;
  /**
   * 0..1, or null when the size is not known yet.
   *
   * Null is a real state, not a missing number: HF reports a total only once the
   * file listing resolves, and the seconds before that are exactly when someone
   * is watching hardest. It draws as an indeterminate sweep rather than 0%,
   * which would read as stalled.
   */
  readonly fraction: number | null;
  /** Bytes so far / bytes expected, for the caption. */
  readonly received?: number;
  readonly total?: number | null;
  /** "45s left" — already formatted by the store; omitted when unknowable. */
  readonly eta?: string;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
  readonly testid?: string;
}

export function DownloadAction({
  installed,
  busy,
  fraction,
  received,
  total,
  eta,
  onDownload,
  onCancel,
  testid = 'download-action',
}: DownloadActionProps): JSX.Element {
  if (installed) {
    return (
      <div
        className="mt-3 flex items-center justify-center gap-1.5 rounded-xl bg-bg-active px-3 py-2.5 text-footnote text-text-muted"
        data-testid={`${testid}-installed`}
      >
        <IconCheck size={14} /> On disk
      </div>
    );
  }

  if (!busy) {
    return (
      <button
        type="button"
        data-testid={testid}
        onClick={onDownload}
        className="pd-focusable mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent-primary px-3 py-2.5 text-footnote font-medium text-text-on-accent transition-opacity hover:opacity-90"
      >
        <IconDownload size={14} /> Download
      </button>
    );
  }

  const pct = fraction === null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const caption =
    received !== undefined && total !== undefined && total !== null && total > 0
      ? `${compactBytes(received)} of ${compactBytes(total)}`
      : 'Starting…';

  return (
    <div className="mt-3 flex items-center gap-2" data-testid={`${testid}-progress`}>
      <div className="min-w-0 flex-1">
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-bg-inset"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(pct === null ? {} : { 'aria-valuenow': pct })}
          data-testid={`${testid}-bar`}
          data-fraction={pct ?? 'indeterminate'}
        >
          <div
            className={cx(
              'h-full rounded-full bg-accent-primary',
              // No width transition while indeterminate — the sweep IS the
              // animation, and a transition on top of it reads as stutter.
              pct === null ? 'pd-download-sweep w-1/3' : 'transition-[width] duration-200',
            )}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-caption text-text-muted tabular-nums">
          <span>{pct === null ? caption : `${pct}% · ${caption}`}</span>
          {eta !== undefined && eta !== '' ? <span>· {eta}</span> : null}
        </p>
      </div>
      <button
        type="button"
        aria-label="Cancel download"
        title="Cancel and discard what has downloaded so far"
        data-testid={`${testid}-cancel`}
        onClick={onCancel}
        className="pd-focusable flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-status-danger-fg transition-colors hover:bg-status-danger-bg"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
