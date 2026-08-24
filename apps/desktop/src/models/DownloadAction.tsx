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
import { IconCheck } from '@pi-desktop/ui';
import type { JSX } from 'react';
import { DownloadBar } from './DownloadBar';

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
      /*
       * NOT FULL WIDTH, and no glyph. MEASURED at 368px it was a blue slab
       * across the whole pane while every other Download in the hub is a pill
       * that ends where its word ends — two answers to the same question on one
       * screen. The arrow that used to sit in it was `IconArrowUp` rotated,
       * hairline against bold text, and it said nothing the word did not.
       */
      <button
        type="button"
        data-testid={testid}
        onClick={onDownload}
        className="pd-focusable mt-3 rounded-full bg-accent-primary px-5 py-2 text-body font-medium text-text-on-accent transition-opacity hover:opacity-90"
      >
        Download
      </button>
    );
  }

  /*
   * THE SAME BAR AS EVERYWHERE ELSE. the user asked for "a simple ---------- X
   * progressbar and X button… no % needed", and the number that used to sit
   * here is exactly what he was removing: it invited you to watch a transfer
   * you had already decided to leave running. The size is on the row you
   * clicked, and the top bar carries the same control once you navigate away.
   */
  return (
    <div className="mt-3 flex items-center gap-2" data-testid={`${testid}-progress`}>
      <DownloadBar
        grow
        fraction={fraction !== null && fraction > 0 ? fraction : null}
        /* The bytes and the estimate are what the hover card is FOR — this pane
           was accepting them and dropping them on the floor, so the one bar a
           user can sit and watch was the one with an empty caption. */
        received={received}
        total={total}
        eta={eta}
        testid={`${testid}-bar`}
        onCancel={onCancel}
      />
    </div>
  );
}
