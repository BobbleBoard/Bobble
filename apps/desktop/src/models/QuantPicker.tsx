/**
 * THE QUANT ROW — pick which file of a model actually gets downloaded.
 *
 * The reference's detail pane leads with this: an info dot, the quant name
 * (`UD-Q4_K_XL`), a format dot, the size (`850 GB`), a `⌄` to change it, and a
 * Download button. Ours stated "Recommended" and offered no choice, which meant
 * a user on 24GB had no way to pick a quant that fits a model whose default
 * does not.
 *
 * THE ORDERING AND THE FIT VERDICT ARE NOT RE-DECIDED HERE.
 * `orderQuantsForDisplay` / `recommendedQuant` / `quantFit` in
 * settings/model-manager-logic.ts already own the Unsloth-style three-key sort
 * (downloaded → fit class → size descending) and the RAM maths that accounts
 * for the projector and the launch context. This component asks them and draws
 * the answer; a second opinion about what fits is the one thing this must not
 * introduce.
 *
 * The tooltip on the dot is the point of the dot. "Exceeds combined VRAM and
 * system RAM budget." is what makes a greyed row actionable rather than
 * mysterious — a coloured dot with no explanation is just decoration.
 */
import { IconCheck, IconChevronDown, Tooltip } from '@pi-desktop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../onboarding/cx';
import {
  orderQuantsForDisplay,
  type QuantOption,
  quantFit,
  recommendedQuant,
} from '../settings/model-manager-logic';

/** Tone → the dot's colour. `default` means "we could not tell". */
const TONE_CLASS: Record<string, string> = {
  success: 'bg-status-success-fg',
  warning: 'bg-status-warning-fg',
  danger: 'bg-status-danger-fg',
  default: 'bg-border-strong',
};

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
  readonly installed?: boolean;
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
  installed = false,
}: QuantPickerProps) {
  const fitInput = useMemo(
    () => ({ totalRamGB, modelMaxContext, mmprojBytes }),
    [totalRamGB, modelMaxContext, mmprojBytes],
  );
  const ordered = useMemo(
    () => orderQuantsForDisplay(options, fitInput, isDownloaded),
    [options, fitInput, isDownloaded],
  );
  const best = useMemo(
    () => recommendedQuant(options, fitInput, isDownloaded),
    [options, fitInput, isDownloaded],
  );

  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /* The recommendation moves when the model changes, so an explicit choice is
     cleared rather than carried onto a different model's ladder. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on ladder change
  useEffect(() => {
    setChosen(undefined);
  }, [options]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const active = ordered.find((o) => o.quant === chosen) ?? best;
  const activeFit =
    active === undefined ? undefined : quantFit({ ...fitInput, modelBytes: active.bytes });

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
    // No ladder: the repo lists no sized files we can choose between. Say so —
    // an empty picker that looks interactive is worse than a plain statement.
    return (
      <div
        className="mt-3 flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-inset px-3 py-2.5"
        data-testid="quant-picker-empty"
      >
        <span className="flex-1 text-footnote text-text-muted">No downloadable files listed.</span>
      </div>
    );
  }

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
            'flex min-w-0 flex-1 items-center gap-2 rounded-md text-left pd-focusable',
            ordered.length < 2 ? 'cursor-default' : 'hover:bg-bg-hover',
          )}
        >
          <span className="truncate text-footnote font-medium text-text-primary">
            {active.quant}
          </span>
          {format !== undefined ? (
            <span className="shrink-0 rounded-md bg-bg-raised px-1.5 py-0.5 text-caption text-text-secondary">
              {format}
            </span>
          ) : null}
          <span className="shrink-0 text-footnote text-text-muted">{activeFit?.label}</span>
          {ordered.length > 1 ? (
            <IconChevronDown size={14} className="shrink-0 text-text-muted" />
          ) : null}
        </button>

        <button
          type="button"
          data-testid="quant-download"
          disabled={downloading || installed}
          onClick={() => onDownload(active.quant)}
          className={cx(
            'shrink-0 rounded-lg px-3 py-1.5 text-footnote transition-opacity pd-focusable',
            installed
              ? 'bg-bg-active text-text-muted'
              : 'bg-accent-primary text-text-on-accent hover:opacity-90',
          )}
        >
          {installed ? 'Installed' : downloading ? 'Starting…' : 'Download'}
        </button>
      </div>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close quant list"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            data-testid="quant-menu"
            /* Shared `.pd-menu` surface — see the note in ModelsView's RowMenu.
               Position and the height cap are the only local parts. */
            className="pd-menu absolute top-full right-0 left-0 z-20 mt-1 max-h-[280px]"
          >
            {ordered.map((o) => {
              const fit = quantFit({ ...fitInput, modelBytes: o.bytes });
              const here = o.quant === active.quant;
              return (
                <button
                  key={o.quant}
                  type="button"
                  data-testid={`quant-opt-${o.quant}`}
                  onClick={() => {
                    setChosen(o.quant);
                    setOpen(false);
                  }}
                  className="pd-menu-item"
                >
                  <Tooltip label={fit.detail ?? fit.label} side="left">
                    <span className={cx('h-2 w-2 shrink-0 rounded-full', TONE_CLASS[fit.tone])} />
                  </Tooltip>
                  <span className="min-w-0 flex-1 truncate text-footnote text-text-primary">
                    {o.quant}
                  </span>
                  {isDownloaded(o.quant) ? (
                    <span className="shrink-0 text-caption text-text-muted">on disk</span>
                  ) : null}
                  {o.quant === best?.quant ? (
                    <span className="shrink-0 rounded-full border border-border-default px-1.5 text-caption text-text-secondary">
                      Best
                    </span>
                  ) : null}
                  <span className="shrink-0 text-footnote text-text-muted">{fit.label}</span>
                  {here ? <IconCheck size={13} className="shrink-0 text-text-muted" /> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
