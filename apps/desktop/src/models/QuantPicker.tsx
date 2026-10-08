/**
 * THE QUANT ROW — pick which file of a model actually gets downloaded.
 *
 * THE FIT VERDICT AND THE RECOMMENDATION ARE NOT RE-DECIDED HERE.
 * `recommendedQuant` / `quantFit` in settings/model-manager-logic.ts own the RAM
 * maths that accounts for the projector and the launch context. This component
 * asks them and draws the answer; a second opinion about what fits is the one
 * thing it must not introduce.
 *
 * WHAT THE LIST LOOKS LIKE, per the user, and why each part is that way:
 *
 *   - "make it so that the quants are all in order of size, largest to smallest
 *     top to bottom". So the body is a plain size sort. It deliberately does NOT
 *     use `orderQuantsForDisplay`, whose three-key sort (downloaded → fit class →
 *     quality) exists to put the best choice first — a job now done by the pinned
 *     row above, which frees the list to be predictable instead of clever.
 *
 *   - "at the top there is a line ____ and then above a single out of order quant
 *     that says 'reccomended' next to it. there is a duplicate of this one in
 *     order in the lower part of the dropdown… though that downloads the same
 *     item it acts as a seperate highlight if clicked in the dropdown, nothing
 *     about its display changes however." So a selection is (quant, WHERE it was
 *     clicked): two rows can name the same file and highlight independently, and
 *     the in-list copy carries no badge.
 *
 *   - "do not show 'tight will swap' or 'wont fit' unless a user hovers over the
 *     colored dot". The verdict is the dot's tooltip; the right-hand column is
 *     the file SIZE, which is what you are actually choosing between.
 *
 *   - "hover effect needs to be around same height as the download button" — the
 *     rows take their height from the button beside them rather than the shared
 *     menu row height. That is the one measurement here that is genuinely local,
 *     so it lives in a `.pd-quant-menu` rule rather than in the shared recipe.
 */
import { IconCheck, IconChevronDown, Tooltip } from '@pi-desktop/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../onboarding/cx';
import { type QuantOption, quantFit, recommendedQuant } from '../settings/model-manager-logic';
import { compactBytes } from './models-layout';
import { useOutsideClose } from './use-outside-close';

/** Tone → the dot's colour. `default` means "we could not tell". */
const TONE_CLASS: Record<string, string> = {
  success: 'bg-status-success-fg',
  warning: 'bg-status-warning-fg',
  danger: 'bg-status-danger-fg',
  default: 'bg-border-strong',
};

/** Where a chosen row lives. The same quant in both places is two selections. */
interface Pick {
  readonly quant: string;
  readonly from: 'pinned' | 'list';
}

export interface QuantPickerProps {
  readonly options: readonly QuantOption[];
  readonly totalRamGB: number;
  readonly modelMaxContext?: number;
  readonly mmprojBytes?: number;
  readonly isDownloaded?: (quant: string) => boolean;
  readonly loading?: boolean;
  readonly format?: string;
  /** Called with the quant to fetch; undefined while none is resolvable. */
  readonly onDownload: (quant: string | undefined) => void;
  readonly downloading?: boolean;
}

export function QuantPicker({
  options,
  totalRamGB,
  modelMaxContext,
  mmprojBytes,
  isDownloaded = () => false,
  loading = false,
  format,
  onDownload,
  downloading = false,
}: QuantPickerProps) {
  const fitInput = useMemo(
    () => ({ totalRamGB, modelMaxContext, mmprojBytes }),
    [totalRamGB, modelMaxContext, mmprojBytes],
  );
  /* Largest → smallest, as asked. Ties break on name so the list cannot reorder
     itself between renders. */
  const ordered = useMemo(
    () => [...options].sort((a, b) => b.bytes - a.bytes || a.quant.localeCompare(b.quant)),
    [options],
  );
  const best = useMemo(
    () => recommendedQuant(options, fitInput, isDownloaded),
    [options, fitInput, isDownloaded],
  );

  const [picked, setPicked] = useState<Pick | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(open, rootRef, close);

  /* The recommendation moves when the model changes, so an explicit choice is
     cleared rather than carried onto a different model's ladder. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on ladder change
  useEffect(() => {
    setPicked(undefined);
  }, [options]);

  /* Nothing picked means the recommendation — so pressing Download without ever
     opening this gets the right file. */
  const active = ordered.find((o) => o.quant === (picked?.quant ?? best?.quant)) ?? best;
  const activeFit =
    active === undefined ? undefined : quantFit({ ...fitInput, modelBytes: active.bytes });
  const activeOnDisk = active !== undefined && isDownloaded(active.quant);

  if (loading) {
    return (
      <div
        className="mt-3 flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-inset px-3 py-2.5 text-footnote text-text-muted"
        data-testid="quant-picker-loading"
      >
        Loading files…
      </div>
    );
  }

  if (active === undefined) {
    /*
     * NOTHING TO PICK FROM MEANS NOTHING TO DRAW.
     *
     * An MLX or safetensors repo publishes no quant ladder, and this used to
     * answer that with a full-width bordered slab reading "No downloadable
     * files listed." — directly under a Download button that works fine. The
     * picker is an optional refinement of a choice already made above it, so
     * its absence is not news; the slab only managed to make a working card
     * look broken.
     */
    return null;
  }

  /** One row. `pinned` carries the badge; its twin in the list below does not. */
  const row = (o: QuantOption, from: 'pinned' | 'list') => {
    const fit = quantFit({ ...fitInput, modelBytes: o.bytes });
    // With nothing picked yet, the pinned row is the one that is live — it is
    // what Download would fetch.
    const here =
      picked === undefined
        ? from === 'pinned' && o.quant === best?.quant
        : picked.from === from && picked.quant === o.quant;
    return (
      <button
        key={`${from}:${o.quant}`}
        type="button"
        data-testid={`quant-opt-${from}-${o.quant}`}
        data-selected={here}
        onClick={() => {
          setPicked({ quant: o.quant, from });
          setOpen(false);
        }}
        className={cx(
          'pd-menu-item',
          // Selected reads as hover PLUS a little more weight, so the current
          // choice is legible without introducing a second colour to the menu.
          here && 'bg-bg-hover font-medium',
        )}
      >
        <Tooltip label={fit.detail ?? fit.label} side="left">
          <span className={cx('h-2 w-2 shrink-0 rounded-full', TONE_CLASS[fit.tone])} />
        </Tooltip>
        <span className="min-w-0 flex-1 truncate">{o.quant}</span>
        {from === 'pinned' ? (
          <span className="shrink-0 rounded-full border border-border-default px-1.5 text-caption text-text-secondary">
            Recommended
          </span>
        ) : null}
        {isDownloaded(o.quant) ? (
          <span className="shrink-0 text-caption text-text-muted">on disk</span>
        ) : null}
        {/* The SIZE, not the verdict — the verdict is on the dot's tooltip. */}
        <span
          data-testid="quant-size"
          data-bytes={o.bytes}
          className="shrink-0 text-footnote text-text-muted tabular-nums"
        >
          {compactBytes(o.bytes)}
        </span>
        {here ? <IconCheck size={13} className="shrink-0 text-text-muted" /> : null}
      </button>
    );
  };

  return (
    <div className="relative mt-3" ref={rootRef} data-testid="quant-picker">
      <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-inset px-3 py-2.5">
        <Tooltip
          label={activeFit?.detail ?? activeFit?.label ?? 'Fit unknown for this file.'}
          side="top"
        >
          <span
            data-testid="quant-fit-dot"
            data-tone={activeFit?.tone ?? 'default'}
            className={cx(
              'h-2 w-2 shrink-0 rounded-full',
              TONE_CLASS[activeFit?.tone ?? 'default'],
            )}
          />
        </Tooltip>

        <button
          type="button"
          data-testid="quant-current"
          onClick={() => setOpen((v) => !v)}
          disabled={ordered.length < 2}
          className={cx(
            'pd-focusable flex min-w-0 flex-1 items-center gap-2 rounded-md text-left',
            ordered.length < 2 ? 'cursor-default' : 'hover:bg-bg-hover',
          )}
        >
          <span className="truncate font-medium text-footnote text-text-primary">
            {active.quant}
          </span>
          {format !== undefined ? (
            <span className="shrink-0 rounded-md bg-bg-raised px-1.5 py-0.5 text-caption text-text-secondary">
              {format}
            </span>
          ) : null}
          {/* The closed row states the SIZE. It used to say "Fits" / "Tight, will
              swap" here, which the user asked to keep to the dot's tooltip. */}
          <span className="shrink-0 text-footnote text-text-muted tabular-nums">
            {compactBytes(active.bytes)}
          </span>
          {ordered.length > 1 ? (
            <IconChevronDown size={14} className="shrink-0 text-text-muted" />
          ) : null}
        </button>

        {/*
         * THE STATE OF THE FILE THIS ROW NAMES, not of the repo it came from.
         *
         * `installed` was a per-REPO boolean, so owning a model at Q3_K_M put
         * "Installed" on the BF16 row — 47 GB nobody had fetched, reported as
         * already here. The picker is the one control on the page whose whole
         * job is telling quants apart, so it is the last place that can afford
         * to answer at repo granularity.
         */}
        <button
          type="button"
          data-testid="quant-download"
          disabled={downloading || activeOnDisk}
          onClick={() => onDownload(active.quant)}
          className={cx(
            'pd-focusable shrink-0 rounded-full px-3 py-1.5 text-footnote transition-opacity',
            activeOnDisk
              ? 'bg-bg-active text-text-muted'
              : 'bg-accent-primary text-text-on-accent hover:opacity-90',
          )}
        >
          {/* "Starting…" forever was the old story here, and it now sits under a
              bar that is reporting real bytes — two controls disagreeing about
              the same transfer. The headline action owns the progress; this one
              just steps back while it runs. */}
          {activeOnDisk ? 'On disk' : downloading ? 'Downloading…' : 'Download'}
        </button>
      </div>

      {open ? (
        /*
         * No full-screen close overlay — see use-outside-close.ts. That overlay
         * sat under the pointer across the whole window, which is what stopped
         * the model card behind this from scrolling while the menu was open.
         */
        <div
          data-testid="quant-menu"
          className="pd-menu pd-quant-menu absolute top-full right-0 left-0 z-20 mt-1 max-h-[360px]"
        >
          {best !== undefined ? (
            <>
              {row(best, 'pinned')}
              <div className="pd-menu-separator" />
            </>
          ) : null}
          {ordered.map((o) => row(o, 'list'))}
        </div>
      ) : null}
    </div>
  );
}
