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
import { quickPickFor, type RecommenderHost } from './model-recommender';
import { compactBytes } from './models-layout';
import { hueForOutput, Pill } from './Pill';
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
  /**
   * The machine Top Recommended recommends for (`hostFor`), which Quick
   * Download decides against too — the same budget, handed down from the hub.
   * null = not yet known.
   */
  readonly host: RecommenderHost | null;
  /** 0..1 while a variant is downloading, keyed by its repo. */
  readonly progress?: Readonly<Record<string, number>>;
  readonly onSelect: (repo: string) => void;
  readonly onDownload: (variant: RecommendedVariant) => void;
  readonly onCancel: (variant: RecommendedVariant) => void;
  /** Bytes per repo for the in-row bar, so Quick Download can become one. */
  readonly bytes?: Readonly<
    Record<string, { readonly received: number; readonly total: number; readonly fraction: number }>
  >;
  /** The file a GGUF repo's Download fetches, where its listing has been read. */
  readonly picks?: Readonly<Record<string, { readonly quant: string; readonly bytes: number }>>;
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
    why: 'It will load with little room left. Expect swapping.',
  },
  'too-big': {
    tone: 'danger',
    label: 'Too large',
    why: 'Needs more memory than this machine has.',
  },
};

export function FamilyCard({
  family,
  downloaded,
  selectedRepo,
  memoryGB,
  host,
  progress = {},
  bytes,
  picks = {},
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

  /**
   * Does this variant's own label already state a size?
   *
   * A substring check was not enough: the label "0.8B" and the fallback "800M"
   * are the same number in different units, so the row read "0.8B 800M". If the
   * label names a parameter count at all, it has already answered the question.
   */
  const SAYS_ITS_SIZE = /\d+(?:\.\d+)?\s*[BM]\b/i;

  const variantRow = (v: RecommendedVariant) => {
    const here = selectedRepo === v.repo;
    const have = downloaded.has(v.repo);
    const fit = fitFor(v, memoryGB);
    const pct = progress[v.repo];
    /*
     * NOT THE SAME FACT TWICE. With the size moved next to the label, rows in
     * families whose labels ARE their parameter count came out as "0.8B 800M",
     * "2B 2B", "4B 4B" — the fallback re-stating what the reader had just read,
     * once in B and once in M. Real bytes are always worth showing; the
     * parameter fallback only earns its place when the label does not already
     * say it.
     */
    const fallback = paramsLabel(v.paramsB);
    const size =
      v.approxBytes !== undefined
        ? compactBytes(v.approxBytes)
        : fallback !== '' && !SAYS_ITS_SIZE.test(v.label)
          ? fallback
          : undefined;
    return (
      <div
        key={`${v.repo}:${v.label}`}
        data-testid={`family-variant-${v.repo}:${v.label}`}
        data-selected={here}
        /*
         * SELECTED IS NOT HOVER, AND IT IS NOT BLUE EITHER.
         *
         * Both states used to paint the same pale wash, so the open variant
         * looked permanently moused-over — and since that wash is LIGHTER than
         * the card, the child read as raised out of its own parent. The first
         * fix separated them with an accent rail and a 12% accent tint; the user
         * did not like the blue, and he is right that it was doing too much:
         * accent in this app means "act on this", and a row you are merely
         * LOOKING at is not an action.
         *
         * So the two states differ by DIRECTION rather than by colour. Hover
         * lifts (the light wash, above the card); selection recesses (the inset
         * surface, below it). That reads on both themes, needs no hue, and
         * leaves accent to mean what it means everywhere else.
         */
        className={cx(
          'flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
          here ? 'bg-bg-inset' : 'hover:bg-bg-hover',
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(v.repo)}
          className="pd-focusable flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span
                className={cx(
                  'truncate text-footnote text-text-primary',
                  here ? 'font-medium' : '',
                )}
              >
                {v.label}
              </span>
              {/* MEASURED: pushed to the far right of a 1100px card, the size
                  sat alone across a screen-wide gap from the name it belongs
                  to — "base" at one end and "500M" at the other. It is part of
                  the model's name in every other surface here, so it reads as
                  one phrase. */}
              {size === undefined ? null : (
                <span className="shrink-0 text-caption text-text-muted tabular-nums">{size}</span>
              )}
              {(v.tasks ?? []).map((t) => (
                <Pill key={t} tone={hueForOutput(family.output)} testid={`task-${t}`}>
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
            /* ONE DOWNLOAD BUTTON IN THIS APP. the user: "those download buttons
               need to be the same as the others, blue background white text,
               exact same as the others." The tinted second rank made the
               variant rows read as a different, weaker kind of control — and a
               user does not care which of two blues is more important, only
               which thing is the button. */
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
   *
   * AGAINST THE SAME BUDGET, or they do not agree. This used to pass total RAM
   * as the budget while Top Recommended took `hostFor(hardware)` — 24 GB against
   * 18 on a 24 GB Mac — so the same judgement ran on two machines. MEASURED over
   * the catalog on 8–32 GB Macs: 18 family × machine pairs where it fetched a
   * bigger variant than that judgement picks, or one where it picks none. On
   * the 24 GB Mac, Quick Download fetched Mage Flow Turbo · bf16, marked Tight
   * on its own row, beside Top Recommended's Turbo · int8, and the 22B LTX-2.5
   * beside its 2B; Krea 2 offered a 24 GB model the top of the page would never
   * pick. The hub computes the host once and hands it to both.
   */
  const quick = host === null ? undefined : quickPickFor(family, host);
  const quickHave = quick !== undefined && downloaded.has(quick.variant.repo);
  const quickProgress = quick === undefined ? undefined : bytes?.[quick.variant.repo];
  /* The quant it names is the file the click fetches — the repo listing's pick,
     as on Top Recommended — never the estimate's rung, which the 27B's repo
     does not even publish. Unread yet: just the version. */
  const quickQuant =
    quick === undefined
      ? undefined
      : installKindOf(family) === 'gguf'
        ? picks[quick.variant.repo]?.quant
        : quick.quant?.rung.quant;

  return (
    <div
      data-testid={`family-card-${family.id}`}
      data-open={open}
      className="pd-hub-card overflow-hidden"
    >
      {/* The header is a row, not a single button: it now holds a second control
          and a button inside a button is invalid markup. */}
      <div className="flex w-full items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          data-testid={`family-toggle-${family.id}`}
          aria-expanded={open}
          /*
           * A ONE-VERSION FAMILY HAS NOTHING TO EXPAND. With the count and the
           * chevron hidden (see below), clicking such a row opened a list of one
           * — an unannounced disclosure whose whole content was the row you had
           * just clicked. It opens the card instead, which is what you wanted
           * from a row with exactly one thing in it.
           */
          onClick={() => {
            const only = shown.length === 1 ? shown[0] : undefined;
            if (only !== undefined) onSelect(only.repo);
            else setOpen((v) => !v);
          }}
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
                  title="Unusually fast for its class"
                >
                  Fast
                </Pill>
              ) : null}
              {/* Filled, like every other tag in the hub. As an outline neutral
                  it was the one grey hairline in a row of tinted pills, which
                  reads as disabled rather than informative. */}
              {installKindOf(family) === 'gen' ? (
                <Pill tone={hueForOutput(family.output)} title="What this family generates">
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
                  Too large
                </Pill>
              ) : null}
              {/*
               * NOTHING TO SAY ABOUT ONE VERSION. A family with a single member
               * was offering "1 version ⌄" and an expansion that shows the same
               * model again at the same size — a control whose only outcome is
               * to repeat itself. Count and chevron appear from two upwards.
               *
               * AND IT SITS WITH THE NAME. Right-aligned it floated in the
               * middle of a 1100px row, 700px from the name it counts and
               * 150px from a button it has nothing to do with, which made a
               * disclosure control read as a stray statistic.
               */}
              {shown.length > 1 ? (
                <span className="flex shrink-0 items-center gap-0.5 text-footnote text-text-muted tabular-nums">
                  {shown.length} versions
                  <IconChevronDown
                    size={15}
                    className={cx('transition-transform duration-200', open && 'rotate-180')}
                  />
                </span>
              ) : null}
            </span>
          </span>
        </button>

        {/*
         * A FIXED-WIDTH SLOT for the action, because the button inside it is
         * not fixed width: "Use" is a third of "Quick Download", and with the
         * cluster right-aligned every row's version count landed at a different
         * x. Reserving the widest case makes the column straight.
         */}
        <span className="flex w-[150px] shrink-0 items-center justify-end">
          {quick === undefined ? null : quickProgress !== undefined ? (
            <span className="flex w-full items-center">
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
              data-testid={
                quickHave ? `family-quick-use-${family.id}` : `family-quick-${family.id}`
              }
              data-repo={quick.variant.repo}
              /* The repo is not the variant: Mage Flow's three recipes are one
                 repo, int8 at 13 GB and bf16 at 17. */
              data-variant={quick.variant.label}
              onClick={() => (quickHave ? onSelect(quick.variant.repo) : onDownload(quick.variant))}
              title={`${quick.variant.label}${quickQuant === undefined ? '' : ` · ${quickQuant}`}`}
              className="pd-focusable shrink-0 rounded-full bg-accent-primary px-4 py-1.5 text-body font-medium text-text-on-accent transition-opacity hover:opacity-90"
            >
              {quickHave ? 'Use' : 'Quick Download'}
            </button>
          )}
        </span>
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
