import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef, useState } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px (defaults to --pd-icon-size). */
  size?: number;
}

/**
 * One full turn of the ring (ms). A negative delay drawn from this window lands
 * the spin on the phase it would have had if it had been running since the
 * page's time origin. Keep in step with the duration in indicators.css.
 */
const LOADER_PERIOD_MS = 1100;

/**
 * The Bobble loader — the app's standard spinner. A ring that FADES OUT along
 * its tail, with a rounded tip leading the way round.
 *
 * the user: "made a fading-out spinner with a rounded tip instead of the current
 * one." The previous loader was a fixed-length arc on a faint track whose sweep
 * breathed; at the small sizes it is actually used (13-16px in a sidebar row)
 * the breathing read as flicker and the track read as a smudge. A tail that
 * fades has direction and speed built into its shape, so it stays legible when
 * it is barely bigger than a full stop.
 *
 * Drawn with a conic gradient masked to a ring rather than SVG strokes: SVG has
 * no angular gradient, so a fade along an arc would mean stacking segments. The
 * tip is a small round cap sitting on the ring's centre-line at 12 o'clock,
 * which is also where the gradient's seam falls — so the cap both rounds the
 * head and hides the seam.
 *
 * currentColor throughout, so it inherits the surrounding text color.
 * API-compatible with every prior spinner (same props / span ref / role), so
 * all call sites (App boot, ModelManager, ChatThread, connectors…) get it for
 * free. Every loader runs on the same clock phase, so they turn together.
 * Reduced-motion freezes it to a still ring (indicators.css).
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size, className, style, ...rest },
  ref,
) {
  // Phase-lock to the document clock, computed ONCE. A CSS animation's position
  // is (now − start) − delay, so re-deriving the delay on every render (this
  // read Date.now() inline) re-aimed the arc every time the status text, tool
  // name or token count beside it changed — the loader snapped to a random
  // angle many times a second instead of turning. Pinning it at mount to
  // −(now mod period) makes the phase a pure function of wall time, which also
  // makes a REMOUNT invisible: the replacement element picks up exactly where
  // its predecessor was, so a spinner that gets re-keyed by a changing status
  // row no longer jumps back to 0°. performance.now() is used because it shares
  // the time origin the browser's animation timeline counts from.
  const [delay] = useState<Record<string, string>>(() => ({
    '--pd-loader-delay': `-${Math.round(performance.now() % LOADER_PERIOD_MS)}ms`,
  }));
  const sizeStyle = size === undefined ? {} : { width: size, height: size };
  return (
    <span
      ref={ref}
      role="status"
      aria-label="Loading"
      className={clsx('pd-loader', className)}
      style={{ ...sizeStyle, ...delay, ...style }}
      {...rest}
    >
      <span className="pd-loader-ring" aria-hidden="true">
        <span className="pd-loader-tip" />
      </span>
    </span>
  );
});
