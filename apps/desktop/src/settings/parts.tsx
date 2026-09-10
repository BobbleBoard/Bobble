/**
 * The vocabulary every settings surface is drawn with — the nine Settings
 * panels AND the advanced-parameters dialog, which used to hand-roll its own
 * near-copy of each of these and had drifted a little further with every one.
 *
 * There were three ways to draw a slider row in here: IconStrokeControl's
 * (label left, tabular value right, track under), Element size's (track first,
 * value after it) and the advanced panel's own. {@link SettingSlider} is
 * IconStrokeControl's, because that one is the component in `@pi-desktop/ui`
 * and therefore the one the rest of the app already looks like.
 *
 * Geometry rides the token scale rather than Tailwind's own: `rounded-lg` is
 * `--pd-radius-lg`, which the theme sets — `rounded-xl` is 12px of Tailwind
 * default that no theme can move, and a card sitting on an 18px-radius panel
 * shell wants to be on the same scale as it.
 */
import { Slider } from '@pi-desktop/ui';
import type { ReactNode } from 'react';

export function SettingSection({
  title,
  description,
  action,
  children,
}: {
  /** Omitted when the panel's own title already says this — the Settings shell
   * prints the section name above the body, and "Agent / Agent" twice in two
   * sizes reads as a mistake rather than a hierarchy. */
  title?: string;
  description?: string;
  /** A section-level affordance (a Reset, say), baselined with the heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const head = title !== undefined || description !== undefined;
  return (
    <section className="flex flex-col gap-4">
      {head ? (
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            {title !== undefined ? (
              <h2 className="text-heading font-medium text-text-primary">{title}</h2>
            ) : null}
            {description !== undefined ? (
              <p className="mt-1 text-footnote text-text-muted">{description}</p>
            ) : null}
          </div>
          {action !== undefined ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {/* The card stack sits closer together than it does to the heading: 12px
          between siblings, 16px under the thing that introduces them. */}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="pd-setting-row flex flex-col rounded-lg border border-border-default bg-bg-raised p-4">
      <span className="text-body font-medium text-text-primary">{label}</span>
      {hint !== undefined ? (
        <span className="mt-0.5 text-footnote text-text-muted">{hint}</span>
      ) : null}
      <div className="mt-3 flex flex-col gap-2">{children}</div>
    </div>
  );
}

/**
 * Several controls under one hairline surface instead of one card each.
 *
 * Eight sampling knobs as eight cards is eight borders and eight shadows for
 * eight numbers; as one card with hairlines between the rows it reads as a
 * group, which is what it is.
 */
export function SettingGroup({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-default bg-bg-raised px-4 py-1 [&>*]:py-3"
    >
      {children}
    </div>
  );
}

/**
 * A labeled slider — label left, live value right in tabular mono, track under.
 * The header idiom is IconStrokeControl's, deliberately (see the file header).
 */
export function SettingSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
  testId,
  action,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  testId?: string;
  /** Shown beside the readout — a Reset that only appears off-default, say. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body font-medium text-text-primary">{label}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="font-mono text-caption text-text-secondary tabular-nums">
            {format ? format(value) : String(value)}
          </span>
          {action}
        </span>
      </div>
      {hint !== undefined ? (
        <span className="-mt-1 text-footnote text-text-muted">{hint}</span>
      ) : null}
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        data-testid={testId}
        onValueChange={onChange}
      />
    </div>
  );
}
