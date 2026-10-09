/**
 * A DOWNLOAD IN FLIGHT: a bar, and a way to stop it. Nothing else.
 *
 * The user: "when something is downloading: download button, blue download button
 * changes to a blue bar that is most of the width of the button, however with
 * some space left on the right for a red X button, the blue bar highlights and
 * hovers showing downloaded/total size n%. the X hovers specifically with a red
 * circle highlight and is nothing but a vertical+horizontal symmetrical red X.
 * clicking immediately stops download and cleans up."
 *
 * THE NUMBERS ARE ON HOVER, NOT ON THE FACE, and that is the whole shape of the
 * thing. A percentage sitting there permanently invites you to watch it; a bar
 * says the same at a glance and lets you look away. But the number is still what
 * you want the moment you actually wonder, so it is one hover away rather than
 * gone — which is a different trade from either always showing it or never
 * having it.
 *
 * AND THE BAR STAYS A BAR. The user, correcting a first attempt that put the caption
 * inside the track and grew it to fit: "the blue bar is a progressbar that just
 * is a solid blue color for progress. the hover shows a little extension card
 * popup thing above the bar nothing goes inside the bar it does not change
 * thickness." The user is right — a progress indicator that changes SHAPE under the
 * pointer is reporting on the pointer, not on the download. So the popup floats
 * above and the bar never moves.
 *
 * THE X IS DRAWN HERE rather than taken from the icon set. The user asked for
 * "nothing but a vertical+horizontal symmetrical red X", and a shared close
 * glyph is drawn to sit in a chrome row — optically balanced, not geometrically
 * symmetric. Two equal strokes through one centre is a different mark, and it is
 * the one specified.
 *
 * IMMEDIATE means immediate: the caller clears its own state on the click and
 * lets the abort catch up, because the supervisor discards partial files on its
 * cancel path and the outcome is not in doubt. See store-models.ts.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { cx } from '../onboarding/cx';
import { compactBytes } from './models-layout';

/** Two equal strokes through one centre — geometrically symmetric, by construction. */
function SymmetricX({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden focusable="false">
      <title>Cancel</title>
      <path
        d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface DownloadBarProps {
  /** 0..1, or null while the size is still unknown (draws as a sweep). */
  readonly fraction: number | null;
  readonly onCancel: () => void;
  /** Bytes so far and expected — revealed on hover, per the spec above. */
  readonly received?: number;
  readonly total?: number | null;
  /** "45s left", already formatted — omitted when the rate is too noisy. */
  readonly eta?: string;
  /** Tooltip on the X — which download this is, when several could run. */
  readonly label?: string;
  /** Fill the row it sits in rather than taking a fixed width. */
  readonly grow?: boolean;
  readonly testid?: string;
  /** No hover caption — for a row that already writes the numbers beside the bar. */
  readonly quiet?: boolean;
}

export function DownloadBar({
  fraction,
  onCancel,
  received,
  total,
  eta,
  label = 'Cancel download',
  grow = false,
  testid = 'download-bar',
  quiet = false,
}: DownloadBarProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const pct = fraction === null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const known = received !== undefined && total !== undefined && total !== null && total > 0;
  const left = eta === undefined || eta === '' ? '' : ` · ${eta}`;
  const caption = known
    ? `${compactBytes(received)} / ${compactBytes(total)}${pct === null ? '' : ` · ${pct}%`}${left}`
    : pct === null
      ? 'Starting…'
      : `${pct}%${left}`;

  return (
    <span
      className={cx('flex items-center gap-1.5', grow ? 'min-w-0 flex-1' : '')}
      data-testid={`${testid}-wrap`}
    >
      {/* The bar is a bar: one thickness, one solid fill, nothing written on it.
          The numbers live in a popup ABOVE it, which is why this wrapper is the
          positioning context. */}
      {/* Hover reveals the numbers; it adds nothing a keyboard user needs, and
          the bar's own controls carry every action. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only garnish. */}
      <span
        className="pd-dl-slot"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span
          className="pd-dl-track"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(pct === null ? {} : { 'aria-valuenow': pct })}
          title={caption}
          data-testid={testid}
          data-fraction={pct ?? 'indeterminate'}
          data-hovered={hovered}
        >
          <span
            className={cx('pd-dl-fill', pct === null && 'pd-dl-fill--sweep')}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </span>
        {quiet ? null : (
          <span className="pd-dl-caption" data-testid={`${testid}-caption`} aria-hidden={!hovered}>
            {caption}
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label={label}
        title={label}
        data-testid={`${testid}-cancel`}
        onClick={onCancel}
        className="pd-dl-x pd-focusable"
      >
        <SymmetricX size={12} />
      </button>
    </span>
  );
}
