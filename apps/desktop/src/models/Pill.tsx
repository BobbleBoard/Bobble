/**
 * THE HUB'S TAG.
 *
 * the user: "each of the little like 'tags' i'm going to call them for like 'vision'
 * 'downloaded' etc that you have make these look really nice for example
 * bordered pill colored highlight and such."
 *
 * There were three different tags in the hub — a bare bordered span for "Fast",
 * a grey rounded rectangle for "on disk", and the capability chips, which had
 * colour but no border and a squarer radius. Three near-misses of the same idea.
 * This is the one shape they all use now: a fully-rounded pill, a tinted fill, a
 * border in the SAME hue, and the label in the hue's full strength.
 *
 * WHY THE COLOURS ARE MIXED RATHER THAN LISTED. Each tone names one existing
 * theme token and derives its fill and border from it with `color-mix`. A table
 * of pastels would need a second table for dark mode and would drift from the
 * rest of the app the first time a theme changed; a mix follows the token. The
 * ratios (14% fill, 34% border) are the point where a 12px label still passes
 * contrast against both surfaces.
 *
 * The tone is not decoration: colour is what lets someone scan a long list and
 * find the vision models without reading. That only works if a meaning keeps its
 * hue everywhere it appears, which is why callers pass a MEANING and not a
 * colour.
 */
import type { JSX, ReactNode } from 'react';
import { cx } from '../onboarding/cx';

export type PillTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

const TOKEN: Record<PillTone, string> = {
  neutral: '--pd-text-muted',
  accent: '--pd-accent-primary',
  info: '--pd-status-info-fg',
  success: '--pd-status-success-fg',
  warning: '--pd-status-warning-fg',
  danger: '--pd-status-danger-fg',
};

export interface PillProps {
  readonly tone?: PillTone;
  readonly icon?: ReactNode;
  readonly title?: string;
  readonly testid?: string;
  /** Quieter still: no fill, just the hairline and the label. For dense rows. */
  readonly outline?: boolean;
  readonly children: ReactNode;
}

export function Pill({
  tone = 'neutral',
  icon,
  title,
  testid,
  outline = false,
  children,
}: PillProps): JSX.Element {
  const token = TOKEN[tone];
  return (
    <span
      title={title}
      data-testid={testid}
      data-tone={tone}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5',
        'text-caption font-medium leading-tight whitespace-nowrap',
      )}
      style={{
        background: outline ? 'transparent' : `color-mix(in oklab, var(${token}) 14%, transparent)`,
        borderColor: `color-mix(in oklab, var(${token}) 34%, transparent)`,
        color: `var(${token})`,
      }}
    >
      {icon}
      {children}
    </span>
  );
}
