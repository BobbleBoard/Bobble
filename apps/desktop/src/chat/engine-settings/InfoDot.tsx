/**
 * The ⓘ beside a setting's name: hover (or focus) shows what the setting does
 * — the blurb that used to sit under every row — plus the literal flag the
 * engine is passed, for anyone checking. the user (2026-09-13): "show a circle
 * with i in it that shows the current blurb what this does."
 */
import { Tooltip } from '@pi-desktop/ui';
import type { ReactNode } from 'react';

export function InfoDot({
  label,
  children,
  testId,
}: {
  /** What the tooltip is about (the accessible name). */
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Tooltip
      label={<div className="pd-info-tip">{children}</div>}
      side="top"
      delayDuration={0}
      className="pd-tooltip--wide"
    >
      <button
        type="button"
        className="pd-info-dot pd-focusable"
        aria-label={`About ${label}`}
        data-testid={testId}
      >
        i
      </button>
    </Tooltip>
  );
}
