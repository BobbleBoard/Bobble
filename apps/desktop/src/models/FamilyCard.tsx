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
 *
 * WHAT A ROW SAYS, and why each part is there:
 *   - the JOB, in words ("first + last frame → video"), because the user's point
 *     about MiniMax-H3 is that you download one per in→out you want, and a row
 *     that only says "Q4" cannot tell you which one you are getting;
 *   - the real DOWNLOAD SIZE of that recipe, not the repo's total, since one
 *     configuration of LTX-2.5 is 35 GB out of a ~200 GB tree;
 *   - the FIT VERDICT for this machine, up front — "of course all of these are
 *     vram dependent, show a not recommended for this machine if it can't run".
 */
import { IconCheck, IconChevronDown } from '@pi-desktop/ui';
import { type JSX, useEffect, useRef, useState } from 'react';
import { cx } from '../onboarding/cx';
import { OrgAvatar } from '../settings/brand-icons';
import { DownloadBar } from './DownloadBar';
import { quickPickFor } from './model-recommender';
import { compactBytes } from './models-layout';
import { Pill } from './Pill';
import {
  type FitVerdict,
  fitFor,
  installKindOf,
  type RecommendedFamily,
  type RecommendedVariant,
  TASK_LABEL,
} from './recommended-catalog';

export interface FamilyCardProps {
  readonly family: RecommendedFamily;
  /** Repo ids already on disk — a variant that is downloaded says so. */
  readonly downloaded: ReadonlySet<string>;
  /** The repo the detail pane is showing, so the card can mark it. */
  readonly selectedRepo: string | null;
  /** This machine's unified memory, for the fit verdict. 0 = not yet known. */
  readonly memoryGB: number;
  /** 0..1 while a variant is downloading, keyed by its repo. */
  readonly progress?: Readonly<Record<string, number>>;
  readonly onSelect: (repo: string) => void;
  readonly onDownload: (variant: RecommendedVariant) => void;
  readonly onCancel: (variant: RecommendedVariant) => void;
  /** Bytes per repo for the in-row bar, so Quick Download can become one. */
  readonly bytes?: Readonly<
    Record<string, { readonly received: number; readonly total: number; readonly fraction: number }>
  >;
}

/** "2.6B" / "820M" — the size column, from a parameter count in billions. */
function paramsLabel(paramsB: number | undefined): string {
  if (paramsB === undefined) return '';
  return paramsB < 1 ? `${Math.round(paramsB * 1000)}M` : `${Number(paramsB.toFixed(1))}B`;
}

const FIT_PILL: Record<
  Exclude<FitVerdict, 'unknown'>,
  { tone: 'success' | 'warning' | 'danger'; label: string; why: string }
> = {
  fits: { tone: 'success', label: 'Fits', why: 'Comfortably within this machine’s memory.' },
  tight: {
    tone: 'warning',
    label: 'Tight',
    why: 'It will load, but with little room left — expect swapping.',
  },
  'too-big': {
    tone: 'danger',
    label: 'Too big for this Mac',
    why: 'Needs more memory than this machine has.',
  },
};

export function FamilyCard({
  family,
  downloaded,
  selectedRepo,
  memoryGB,
  progress = {},
  bytes,
  onSelect,
  onDownload,
  onCancel,
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
  // The best any member manages here — a family whose smallest recipe is out of
  // reach should say so on the closed card, not only once you open it.
  const bestFit = shown.reduce<FitVerdict>((best, v) => {
    const f = fitFor(v, memoryGB);
    if (best === 'fits' || f === 'fits') return f === 'fits' ? 'fits' : best;
    if (best === 'tight' || f === 'tight') return 'tight';
    return f === 'unknown' ? best : f;
  }, 'unknown');

  const variantRow = (v: RecommendedVariant) => {
    const here = selectedRepo === v.repo;
    const have = downloaded.has(v.repo);
    const fit = fitFor(v, memoryGB);
    const pct = progress[v.repo];
    const size = v.approxBytes !== undefined ? compactBytes(v.approxBytes) : paramsLabel(v.paramsB);
    return (
      <div
        key={`${v.repo}:${v.label}`}
        data-testid={`family-variant-${v.repo}:${v.label}`}
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
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-footnote text-text-primary">{v.label}</span>
              {(v.tasks ?? []).map((t) => (
                <Pill key={t} tone="info" testid={`task-${t}`}>
                  {TASK_LABEL[t]}
                </Pill>
              ))}
              {fit !== 'unknown' && fit !== 'fits' ? (
                <Pill tone={FIT_PILL[fit].tone} title={FIT_PILL[fit].why} testid={`fit-${fit}`}>
                  {FIT_PILL[fit].label}
                </Pill>
              ) : null}
            </span>
            {v.note !== undefined ? (
              <span className="mt-0.5 block truncate text-caption text-text-muted">{v.note}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-caption text-text-muted tabular-nums">{size}</span>
        </button>
        {have ? (
          <Pill tone="success" icon={<IconCheck size={11} />} testid={`on-disk-${v.repo}`}>
            On disk
          </Pill>
        ) : pct !== undefined ? (
          /* The Download button becomes the bar in place — the user: "the download
             button (quick one in the card) needs to be replaced with a simple
             ---------- X progressbar and X button". No number: a bar says the
             same thing at a glance and lets you look away. */
          <DownloadBar
            fraction={pct > 0 ? pct : null}
            label={`Cancel ${v.repo}`}
            testid={`family-progress-${v.repo}`}
            onCancel={() => onCancel(v)}
          />
        ) : (
          <button
            type="button"
            data-testid={`family-download-${v.repo}:${v.label}`}
            onClick={() => onDownload(v)}
            className="pd-focusable shrink-0 rounded-full bg-accent-primary px-3 py-1 text-caption font-medium text-text-on-accent transition-opacity hover:opacity-90"
          >
            Download
          </button>
        )}
      </div>
    );
  };

  /*
   * QUICK DOWNLOAD — the user: "need a button that says Quick Download same bar same
   * pill guidelines next to each collection under the 'more' group."
   *
   * The word quick is the specification: it must not open the family, must not
   * ask which quant, and must not fetch the biggest thing in there. It takes the
   * same judgement the top-of-page picks make, scoped to this family — the best
   * variant this machine can hold — so the fast path and the considered path
   * agree rather than being two different opinions with one button each.
   */
  const quick =
    memoryGB > 0
      ? quickPickFor(family, { usableMemoryGB: memoryGB, totalRamGB: memoryGB })
      : undefined;
  const quickHave = quick !== undefined && downloaded.has(quick.variant.repo);
  const quickProgress = quick === undefined ? undefined : bytes?.[quick.variant.repo];

  return (
    <div
      data-testid={`family-card-${family.id}`}
      data-open={open}
      className="pd-model-card overflow-hidden"
    >
      {/* The header is a row, not a single button: it now holds a second control
          and a button inside a button is invalid markup. */}
      <div className="flex w-full items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          data-testid={`family-toggle-${family.id}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="pd-focusable flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <OrgAvatar org={family.org} size={32} />
          {/* Name and tags only — the user: "no descriptions on the model cards
              please". The blurb still exists in the catalogue, where it is the
              one-sentence justification for a family being in a curated list at
              all; it is simply not what a row is for. */}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-body text-text-primary">{family.name}</span>
              {family.fast === true ? (
                <Pill
                  tone="warning"
                  testid={`fast-${family.id}`}
                  title="Unusually fast for its class — the reason it works on a modest machine"
                >
                  Fast
                </Pill>
              ) : null}
              {installKindOf(family) === 'gen' ? (
                <Pill tone="neutral" outline title="Runs on the generation stack, not llama.cpp">
                  {family.output}
                </Pill>
              ) : null}
              {onDisk > 0 ? (
                <Pill tone="success" testid={`family-on-disk-${family.id}`}>
                  {onDisk} on disk
                </Pill>
              ) : null}
              {bestFit === 'too-big' ? (
                <Pill
                  tone="danger"
                  title={FIT_PILL['too-big'].why}
                  testid={`family-fit-${family.id}`}
                >
                  Not for this Mac
                </Pill>
              ) : null}
            </span>
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

        {quick === undefined ? null : quickProgress !== undefined ? (
          <span className="flex w-[150px] shrink-0 items-center">
            <DownloadBar
              grow
              fraction={quickProgress.total > 0 ? quickProgress.fraction : null}
              received={quickProgress.received}
              total={quickProgress.total}
              label={`Cancel ${family.name}`}
              testid={`family-quick-progress-${family.id}`}
              onCancel={() => onCancel(quick.variant)}
            />
          </span>
        ) : (
          <button
            type="button"
            data-testid={quickHave ? `family-quick-use-${family.id}` : `family-quick-${family.id}`}
            onClick={() => (quickHave ? onSelect(quick.variant.repo) : onDownload(quick.variant))}
            title={`${quick.variant.label}${quick.quant === undefined ? '' : ` · ${quick.quant.rung.quant}`}`}
            className="pd-focusable shrink-0 rounded-full bg-accent-primary px-4 py-1.5 text-body font-medium text-text-on-accent transition-opacity hover:opacity-90"
          >
            {quickHave ? 'Use' : 'Quick Download'}
          </button>
        )}
      </div>

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
