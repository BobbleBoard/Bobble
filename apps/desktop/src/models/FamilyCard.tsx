/**
 * A MODEL FAMILY AS ONE CARD THAT OPENS.
 *
 * the user: "group by family in dropdown cards that are like regular cards but just
 * expand down smoothly into showing the other cards".
 *
 * So the closed state is a normal row — org mark, name, what it is for, size —
 * and clicking it grows the same card downward to reveal its members. Not a
 * popover and not a navigation: the list keeps its place, and the thing you
 * opened stays where you opened it.
 *
 * WHY THE HEIGHT IS MEASURED RATHER THAN GUESSED. `height: auto` cannot be
 * transitioned, and a fixed max-height either clips a big family or makes a
 * small one animate against empty space (which reads as lag before anything
 * moves). So the open height comes from the content's own box, and the card
 * releases to `auto` once it arrives — otherwise a variant list that reflows
 * later, on a resize, would be stuck at the height it had when it opened.
 */
import { IconCheck, IconChevronDown } from '@pi-desktop/ui';
import { type JSX, useEffect, useRef, useState } from 'react';
import { cx } from '../onboarding/cx';
import { OrgAvatar } from '../settings/brand-icons';
import {
  installKindOf,
  type RecommendedFamily,
  type RecommendedVariant,
} from './recommended-catalog';

export interface FamilyCardProps {
  readonly family: RecommendedFamily;
  /** Repo ids already on disk — a variant that is downloaded says so. */
  readonly downloaded: ReadonlySet<string>;
  /** The repo the detail pane is showing, so the card can mark it. */
  readonly selectedRepo: string | null;
  readonly onSelect: (repo: string) => void;
  readonly onDownload: (repo: string) => void;
}

/** "2.6B" / "820M" — the size column, from a parameter count in billions. */
function paramsLabel(paramsB: number | undefined): string {
  if (paramsB === undefined) return '';
  return paramsB < 1 ? `${Math.round(paramsB * 1000)}M` : `${Number(paramsB.toFixed(1))}B`;
}

export function FamilyCard({
  family,
  downloaded,
  selectedRepo,
  onSelect,
  onDownload,
}: FamilyCardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState<number | 'auto'>(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    if (!open) {
      // Measure before collapsing: a transition from `auto` has no start value,
      // so the card would snap shut instead of closing.
      setHeight(el.scrollHeight);
      requestAnimationFrame(() => setHeight(0));
      return;
    }
    setHeight(el.scrollHeight);
    const t = window.setTimeout(() => setHeight('auto'), 260);
    return () => window.clearTimeout(t);
  }, [open]);

  // A family whose members are all drafts would be an empty card; drafts ride
  // with their parent and are never a choice of their own.
  const shown = family.variants.filter((v) => v.draftFor === undefined);
  const onDisk = shown.filter((v) => downloaded.has(v.repo)).length;

  const variantRow = (v: RecommendedVariant) => {
    const here = selectedRepo === v.repo;
    const have = downloaded.has(v.repo);
    return (
      <div
        key={v.repo}
        data-testid={`family-variant-${v.repo}`}
        data-selected={here}
        className={cx(
          'flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
          here ? 'bg-bg-active' : 'hover:bg-bg-hover',
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(v.repo)}
          className="pd-focusable flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-footnote text-text-primary">{v.label}</span>
            {v.note !== undefined ? (
              <span className="block truncate text-caption text-text-muted">{v.note}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-caption text-text-muted tabular-nums">
            {paramsLabel(v.paramsB)}
          </span>
        </button>
        {have ? (
          <span className="flex shrink-0 items-center gap-1 text-caption text-text-muted">
            <IconCheck size={12} /> On disk
          </span>
        ) : installKindOf(family) === 'gen' ? (
          /* A generation model has no single file to fetch — its backend pulls
             the weights on first use. A blue Download here would be the same
             promise the detail pane already refuses to make. */
          <button
            type="button"
            data-testid={`family-open-${v.repo}`}
            onClick={() => onSelect(v.repo)}
            className="pd-focusable shrink-0 rounded-lg border border-border-default px-2.5 py-1 text-caption text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            Details
          </button>
        ) : (
          <button
            type="button"
            data-testid={`family-download-${v.repo}`}
            onClick={() => onDownload(v.repo)}
            className="pd-focusable shrink-0 rounded-lg bg-accent-primary px-2.5 py-1 text-caption font-medium text-text-on-accent transition-opacity hover:opacity-90"
          >
            Download
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      data-testid={`family-card-${family.id}`}
      data-open={open}
      className="overflow-hidden rounded-xl border border-border-subtle bg-bg-raised shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-border-default"
    >
      <button
        type="button"
        data-testid={`family-toggle-${family.id}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="pd-focusable flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <OrgAvatar org={family.org} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-body text-text-primary">{family.name}</span>
            {family.fast === true ? (
              <span
                title="Unusually fast for its class — the reason it works on a modest machine"
                className="shrink-0 rounded-full border border-border-default px-1.5 text-caption text-text-secondary"
              >
                Fast
              </span>
            ) : null}
            {onDisk > 0 ? (
              <span className="shrink-0 rounded-full bg-bg-active px-1.5 text-caption text-text-muted">
                {onDisk} on disk
              </span>
            ) : null}
          </span>
          <span className="block truncate text-footnote text-text-muted">{family.blurb}</span>
        </span>
        <span className="shrink-0 text-footnote text-text-muted tabular-nums">
          {shown.length} {shown.length === 1 ? 'version' : 'versions'}
        </span>
        <IconChevronDown
          size={16}
          className={cx(
            'shrink-0 text-text-muted transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      <div
        style={{ height: height === 'auto' ? undefined : height }}
        className={cx(
          'overflow-hidden',
          // No transition once released to `auto` — transitioning to a height
          // the browser has not computed yet is what makes these things jump.
          height === 'auto' ? '' : 'transition-[height] duration-200 ease-out',
        )}
        aria-hidden={!open}
      >
        <div ref={bodyRef} className="flex flex-col gap-1 border-t border-border-subtle p-2">
          {shown.map(variantRow)}
        </div>
      </div>
    </div>
  );
}
