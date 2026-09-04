import type { ReactElement, ReactNode } from 'react';
import { ContextGauge } from './indicators.tsx';
import { Tooltip } from './tooltip.tsx';

/** 73000 -> "73k", 940 -> "940". Compact, no decimals (Aside copy style). */
function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

export interface ContextGaugeTooltipProps {
  /** Context fullness as a percentage (0..100). */
  percent: number;
  usedTokens: number;
  totalTokens: number;
  /** Compaction note line, e.g. "Pi automatically compacts its context". */
  note?: ReactNode;
  /**
   * Trigger element. Defaults to a ContextGauge donut driven by `percent`
   * (the composer-footer indicator this attaches to).
   */
  children?: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  /** Force-open for galleries/screenshots. */
  open?: boolean;
  defaultOpen?: boolean;
}

/**
 * Context-fullness hover card on the composer's context ring.
 *
 * the user: "the bar at the top and surrounding text don't look great." It led with
 * a full-width ProgressBar, which reads as a task finishing rather than a level,
 * and then repeated the number in a sentence. It is a status card now: the label
 * and the percentage on one row, a hairline track under it, the token count as a
 * footnote. The surface itself was the other half of that report — see
 * `.pd-context-tooltip` in tooltip.css.
 */
export function ContextGaugeTooltip({
  percent,
  usedTokens,
  totalTokens,
  note,
  children,
  side = 'top',
  align = 'end',
  delayDuration = 100,
  open,
  defaultOpen,
}: ContextGaugeTooltipProps) {
  const rounded = Math.round(percent);
  // Past 85% the card tints with the ring beside it, so "nearly full" reads
  // without having to parse the number.
  const warn = rounded > 85;
  return (
    <Tooltip
      className="pd-context-tooltip"
      side={side}
      align={align}
      delayDuration={delayDuration}
      open={open}
      defaultOpen={defaultOpen}
      label={
        <span className={`pd-context-card${warn ? ' pd-context-card--warn' : ''}`}>
          <span className="pd-context-card-head">
            <span className="pd-context-card-label">Context used</span>
            <span className="pd-context-card-value">{rounded}%</span>
          </span>
          <span className="pd-context-card-track">
            <span
              className="pd-context-card-fill"
              style={{ width: `${Math.min(100, Math.max(0, rounded))}%` }}
            />
          </span>
          {/* Token counts only when the window is known — a percent-only source
           * (pi's own accounting on a remote/AFM model) has no token totals, so
           * the "0 / 0 tokens" line is suppressed rather than shown as a lie. */}
          {totalTokens > 0 ? (
            <span className="pd-context-card-line">
              {formatTokens(usedTokens)} of {formatTokens(totalTokens)} tokens
            </span>
          ) : null}
          {note !== undefined ? <span className="pd-context-card-note">{note}</span> : null}
        </span>
      }
    >
      {children ?? <ContextGauge value={rounded / 100} tabIndex={0} />}
    </Tooltip>
  );
}
