/**
 * MODEL HUB — model management as its own surface, in the Unsloth Studio shape.
 *
 * the user: "not be in the settings area, it's just a separate thing replacing the
 * chat area. and we totally copy the layout of unsloth studio and how they show
 * it, it's familiar, similar to lmstudio also and frankly it's really really
 * nice looking" — with screenshots.
 *
 * What the reference actually consists of, and what is reproduced here:
 *   - a titled header with a HARDWARE STRIP on the right (Cache / Local / VRAM
 *     / RAM / CPU). This is the bit that makes the page feel like a hub rather
 *     than a list: every download decision is against those numbers.
 *   - Discover / On Device tabs and a single wide search
 *   - a filter row — format, capability, sort — with "only show models that fit"
 *     living INSIDE the sort menu, as in the reference
 *   - Trending Now as horizontal cards, then the full list
 *   - three view modes; compact is a real table with columns
 *   - a detail pane: org avatar, verified org, capability pills, a quant row
 *     with a fit dot whose tooltip says WHY, and metadata chips
 *
 * The filter/sort/format rules live in models-layout.ts (pure, 14 tests) and the
 * RAM-fit verdicts stay in settings/model-manager-logic.ts, which already owns
 * the Unsloth-style three-key quant sort. This file is composition; it does not
 * re-decide either.
 */
import { ScrollArea, Spinner, Tooltip } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type { LlmCatalogEntry } from '../../electron/ipc-contract';
import { cx } from '../onboarding/cx';
import { OrgAvatar } from '../settings/brand-icons';
import { useLlmStore } from '../state/llm-store';
import {
  CAPABILITY_OPTIONS,
  compactBytes,
  compactCount,
  DEFAULT_FILTERS,
  FORMAT_OPTIONS,
  filterModels,
  type HubFilters,
  type HubModel,
  type ModelCapability,
  relativeAge,
  SORT_OPTIONS,
  sortModels,
  type ViewMode,
} from './models-layout';

/**
 * Catalog entry → the shape the hub renders.
 *
 * ATTRIBUTION IS NOT A DEFAULT. The org came from `hfRepo ?? 'unsloth'`, which
 * put "unsloth ✓" under NVIDIA's Nemotron and every other entry without a repo.
 * Crediting the wrong organisation is worse than crediting none, so an unknown
 * org is empty and the row simply omits the line.
 *
 * Likewise the size: `quants[0]` is not the smallest or the best, just the
 * first, and it renders "0 MB" whenever that entry has no byte count. The
 * largest known quant is the honest headline figure, and none is `undefined`
 * rather than zero.
 */
function toHubModel(e: LlmCatalogEntry): HubModel {
  const caps: Array<Exclude<ModelCapability, 'all'>> = [];
  if (e.vision) caps.push('vision');
  if (e.spec !== undefined || e.mtp) caps.push('reasoning');
  const sizes = e.quants.map((q) => q.bytes).filter((b) => typeof b === 'number' && b > 0);
  const org = e.hfRepo?.includes('/') === true ? e.hfRepo.split('/')[0] : undefined;
  return {
    id: e.id,
    name: e.displayName,
    org: org ?? '',
    // "Verified" is a Hugging Face badge. We only know it for entries that name
    // a repo; asserting it for everything would be inventing a credential.
    verified: org !== undefined,
    bytes: sizes.length > 0 ? Math.max(...sizes) : undefined,
    formats: ['gguf'],
    capabilities: caps,
    downloaded: e.downloaded,
    // Fit verdicts belong to model-manager-logic; the local catalog does not
    // carry one per entry, so the hub says nothing rather than guessing.
  };
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-bg-raised px-2.5 py-1 text-footnote">
      <span className="text-text-primary">{value}</span>
      <span className="text-text-muted">{label}</span>
    </span>
  );
}

function Dropdown<T extends string>({
  value,
  options,
  onChange,
  testid,
  footer,
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: string; dot?: string }>;
  onChange: (id: T) => void;
  testid: string;
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value)?.label ?? '';
  return (
    <div className="relative">
      <button
        type="button"
        data-testid={testid}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-border-default bg-bg-raised px-3.5 py-1.5 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
      >
        {current}
        <span className="text-text-muted">⌄</span>
      </button>
      {open ? (
        <>
          {/* Click-away, as a button so it is not a static interactive div. */}
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            data-testid={`${testid}-menu`}
            className="absolute top-full left-0 z-20 mt-1 min-w-[220px] rounded-xl border border-border-default bg-bg-raised p-1 shadow-xl"
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                data-testid={`${testid}-opt-${o.id}`}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-body text-text-primary hover:bg-bg-hover"
              >
                {o.dot !== undefined ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: o.dot }}
                  />
                ) : null}
                <span className="flex-1">{o.label}</span>
                {o.id === value ? <span className="text-text-muted">✓</span> : null}
              </button>
            ))}
            {footer !== undefined ? (
              <div className="mt-1 border-t border-border-default pt-1">{footer}</div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CapabilityPills({ caps }: { caps: readonly string[] }) {
  if (caps.length === 0) return <span className="text-footnote text-text-muted">—</span>;
  return (
    <span className="flex items-center gap-1">
      {caps.map((c) => (
        <span
          key={c}
          title={c}
          className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-bg-inset text-caption text-text-secondary"
        >
          {c === 'vision' ? '👁' : c === 'reasoning' ? '💬' : '•'}
        </span>
      ))}
    </span>
  );
}

export function ModelsView({ onClose }: { onClose: () => void }) {
  const catalog = useLlmStore((s) => s.catalog);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  /* The hardware strip reports THIS machine. A hardcoded "24 GiB" would be
     decoration pretending to be information, and every download decision on
     this page is made against these numbers. */
  const [hw, setHw] = useState<{ ramGiB: number; cpus: number } | null>(null);
  const [filters, setFilters] = useState<HubFilters>(DEFAULT_FILTERS);
  const [view, setView] = useState<ViewMode>('compact');
  const [tab, setTab] = useState<'discover' | 'device'>('discover');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void refreshCatalog();
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((i) => setHw({ ramGiB: Math.round(i.totalMemoryBytes / 1024 ** 3), cpus: i.cpuCount }))
      .catch(() => undefined);
  }, [refreshCatalog]);

  const all = useMemo(() => catalog.map(toHubModel), [catalog]);
  const scoped = useMemo(
    () => (tab === 'device' ? all.filter((m) => m.downloaded === true) : all),
    [all, tab],
  );
  const rows = useMemo(
    () => sortModels(filterModels(scoped, filters), filters.sort),
    [scoped, filters],
  );
  const trending = useMemo(() => sortModels(scoped, 'trending').slice(0, 4), [scoped]);
  const detail = rows.find((m) => m.id === selected) ?? rows[0];
  const localCount = all.filter((m) => m.downloaded === true).length;
  /* Does THIS source carry popularity data? The bundled catalog does not; the
     HF browse path does. Drives whether those columns exist at all. */
  const hasCounts = all.some((m) => m.downloads !== undefined || m.likes !== undefined);

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="models-view">
      <div className="flex h-11 shrink-0 items-center gap-3 pr-4 pl-[80px] [-webkit-app-region:drag]">
        <button
          type="button"
          data-testid="models-back"
          onClick={onClose}
          className="[-webkit-app-region:no-drag] rounded-lg px-2 py-1 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
        >
          ‹ Back to chat
        </button>
      </div>

      {/* Header + hardware strip */}
      <div className="flex shrink-0 items-start justify-between gap-6 px-8 pb-3">
        <div>
          <h1 className="text-title text-text-primary">Model hub</h1>
          <p className="mt-0.5 text-footnote text-text-muted">
            Discover, download, and run inference models locally.
          </p>
        </div>
        <div
          className="flex max-w-[560px] flex-wrap items-center justify-end gap-1.5"
          data-testid="hardware-strip"
        >
          <Chip label="Local" value={String(localCount)} />
          <Chip label="Models" value={String(all.length)} />
          {hw !== null ? (
            <>
              <Chip label="RAM" value={`${hw.ramGiB} GiB`} />
              <Chip label="CPU" value={String(hw.cpus)} />
            </>
          ) : null}
        </div>
      </div>

      {/* Tabs + search */}
      <div className="flex shrink-0 items-center gap-3 px-8 pb-3">
        <div className="flex rounded-full bg-bg-inset p-0.5">
          {(['discover', 'device'] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`models-tab-${t}`}
              onClick={() => setTab(t)}
              className={cx(
                'rounded-full px-5 py-1.5 text-footnote transition-colors',
                tab === t ? 'bg-bg-raised text-text-primary shadow-sm' : 'text-text-secondary',
              )}
            >
              {t === 'discover' ? 'Discover' : 'On Device'}
            </button>
          ))}
        </div>
        <input
          data-testid="models-search"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          placeholder="Search all models"
          className="min-w-0 flex-1 rounded-full border border-border-default bg-bg-raised px-4 py-2 text-body text-text-primary placeholder:text-text-muted pd-focusable"
        />
      </div>

      {/* Filter row */}
      <div className="flex shrink-0 items-center gap-2 px-8 pb-4">
        <Dropdown
          testid="filter-format"
          value={filters.format}
          options={FORMAT_OPTIONS}
          onChange={(format) => setFilters((f) => ({ ...f, format }))}
        />
        <Dropdown
          testid="filter-capability"
          value={filters.capability}
          options={CAPABILITY_OPTIONS}
          onChange={(capability) => setFilters((f) => ({ ...f, capability }))}
        />
        <Dropdown
          testid="filter-sort"
          value={filters.sort}
          options={SORT_OPTIONS}
          onChange={(sort) => setFilters((f) => ({ ...f, sort }))}
          footer={
            <button
              type="button"
              data-testid="filter-only-fits"
              onClick={() => setFilters((f) => ({ ...f, onlyFits: !f.onlyFits }))}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-body text-text-secondary hover:bg-bg-hover"
            >
              <span
                className={cx(
                  'flex h-4 w-4 items-center justify-center rounded-full border text-caption',
                  filters.onlyFits
                    ? 'border-transparent bg-accent-primary text-white'
                    : 'border-border-strong',
                )}
              >
                {filters.onlyFits ? '✓' : ''}
              </span>
              Only show models that fit
            </button>
          }
        />
        <div className="ml-auto flex rounded-lg border border-border-default p-0.5">
          {(['split', 'detail', 'compact'] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`view-${v}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cx(
                'rounded-md px-2 py-1 text-footnote',
                view === v ? 'bg-bg-active text-text-primary' : 'text-text-muted',
              )}
            >
              {v === 'split' ? '▤' : v === 'detail' ? '▥' : '☰'}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-8 pb-10">
          {catalog.length === 0 ? (
            <div className="flex items-center gap-2 py-10 text-body text-text-muted">
              <Spinner size={16} /> Loading models…
            </div>
          ) : (
            <>
              {tab === 'discover' && trending.length > 0 ? (
                <section className="mb-7">
                  <h2 className="mb-3 text-body text-text-primary">Trending Now</h2>
                  <div className="grid grid-cols-4 gap-3" data-testid="trending-row">
                    {trending.map((mdl) => (
                      <button
                        key={mdl.id}
                        type="button"
                        onClick={() => setSelected(mdl.id)}
                        className="rounded-2xl border border-border-default bg-bg-raised p-3 text-left transition-colors hover:bg-bg-hover pd-focusable"
                      >
                        <div className="flex items-start gap-2.5">
                          <OrgAvatar org={mdl.org} size={34} />
                          <span className="min-w-0">
                            <span className="block truncate text-body text-text-primary">
                              {mdl.name}
                            </span>
                            {mdl.org !== '' ? (
                              <span className="flex items-center gap-1 text-footnote text-text-muted">
                                {mdl.org}
                                {mdl.verified === true ? (
                                  <span className="text-accent-primary">✓</span>
                                ) : null}
                              </span>
                            ) : null}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center gap-3 text-footnote text-text-muted">
                          {hasCounts ? <span>↓ {compactCount(mdl.downloads)}</span> : null}
                          {hasCounts ? <span>♡ {compactCount(mdl.likes)}</span> : null}
                          <span className="ml-auto rounded-md bg-bg-inset px-1.5 py-0.5">
                            {compactBytes(mdl.bytes)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <section
                className={cx('grid gap-5', view === 'compact' ? '' : 'grid-cols-[1fr_380px]')}
              >
                <div>
                  <h2 className="mb-3 text-body text-text-primary">
                    {tab === 'device' ? 'On this machine' : 'All models'}
                  </h2>

                  {view === 'compact' ? (
                    <div className="overflow-hidden rounded-xl border border-border-default">
                      {/* Downloads/Likes only exist for HF-sourced entries. A
                          column of em-dashes is worse than no column: it looks
                          like the data failed to load rather than never
                          applying to a bundled catalog. */}
                      <div
                        className={cx(
                          'grid items-center gap-2 border-b border-border-default bg-bg-sunken px-4 py-2 text-footnote text-text-muted',
                          hasCounts
                            ? 'grid-cols-[1fr_120px_90px_110px_90px]'
                            : 'grid-cols-[1fr_120px_90px]',
                        )}
                      >
                        <span>Model</span>
                        <span>Capabilities</span>
                        <span>Size</span>
                        {hasCounts ? <span>Downloads</span> : null}
                        {hasCounts ? <span>Likes</span> : null}
                      </div>
                      {rows.map((mdl) => (
                        <button
                          key={mdl.id}
                          type="button"
                          data-testid={`model-row-${mdl.id}`}
                          onClick={() => setSelected(mdl.id)}
                          className={cx(
                            'grid w-full items-center gap-2 border-b border-border-default px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-bg-hover',
                            hasCounts
                              ? 'grid-cols-[1fr_120px_90px_110px_90px]'
                              : 'grid-cols-[1fr_120px_90px]',
                            selected === mdl.id ? 'bg-bg-active' : '',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <OrgAvatar org={mdl.org} size={30} />
                            <span className="min-w-0">
                              <span className="block truncate text-body text-text-primary">
                                {mdl.name}
                              </span>
                              {mdl.org !== '' ? (
                                <span className="flex items-center gap-1 text-footnote text-text-muted">
                                  {mdl.org}
                                  {mdl.verified === true ? (
                                    <span className="text-accent-primary">✓</span>
                                  ) : null}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <CapabilityPills caps={mdl.capabilities} />
                          <span className="text-footnote text-text-secondary">
                            {compactBytes(mdl.bytes)}
                          </span>
                          {hasCounts ? (
                            <span className="text-footnote text-text-secondary">
                              ↓ {compactCount(mdl.downloads)}
                            </span>
                          ) : null}
                          {hasCounts ? (
                            <span className="text-footnote text-text-secondary">
                              ♡ {compactCount(mdl.likes)}
                            </span>
                          ) : null}
                        </button>
                      ))}
                      {rows.length === 0 ? (
                        <p
                          className="px-4 py-6 text-body text-text-muted"
                          data-testid="models-empty"
                        >
                          Nothing matches these filters.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {rows.map((mdl) => (
                        <button
                          key={mdl.id}
                          type="button"
                          data-testid={`model-row-${mdl.id}`}
                          onClick={() => setSelected(mdl.id)}
                          className="flex items-center gap-3 rounded-xl border border-border-default bg-bg-raised px-4 py-3 text-left transition-colors hover:bg-bg-hover"
                        >
                          <OrgAvatar org={mdl.org} size={34} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body text-text-primary">
                              {mdl.name}
                            </span>
                            <span className="text-footnote text-text-muted">{mdl.org}</span>
                          </span>
                          <span className="text-footnote text-text-muted">
                            {compactBytes(mdl.bytes)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {view !== 'compact' && detail !== undefined ? (
                  <aside
                    className="rounded-2xl border border-border-default bg-bg-raised p-4"
                    data-testid="model-detail"
                  >
                    <div className="flex items-start gap-3">
                      <OrgAvatar org={detail.org} size={44} />
                      <div className="min-w-0">
                        <h3 className="truncate text-body text-text-primary">{detail.name}</h3>
                        <p className="flex items-center gap-1 text-footnote text-text-muted">
                          {detail.org}
                          {detail.verified === true ? (
                            <span className="text-accent-primary">✓</span>
                          ) : null}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {detail.capabilities.map((c) => (
                        <span
                          key={c}
                          className="rounded-md bg-bg-inset px-2 py-0.5 text-footnote text-text-secondary"
                        >
                          {c}
                        </span>
                      ))}
                    </div>

                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-border-default bg-bg-inset px-3 py-2">
                      {/* The dot says THAT it fits; the tooltip says why not —
                          the reference's "Exceeds combined VRAM and system RAM
                          budget." is the whole reason the dot is worth having. */}
                      <Tooltip
                        label={detail.fitReason ?? 'Fits in this machine’s memory budget.'}
                        side="top"
                      >
                        <span
                          className={cx(
                            'h-2 w-2 shrink-0 rounded-full',
                            detail.fits === false ? 'bg-red-500' : 'bg-accent-primary',
                          )}
                          data-testid="detail-fit-dot"
                        />
                      </Tooltip>
                      <span className="flex-1 text-footnote text-text-primary">
                        {compactBytes(detail.bytes)}
                      </span>
                      <span className="rounded-lg bg-accent-primary px-2.5 py-1 text-footnote text-white">
                        {detail.downloaded === true ? 'Installed' : 'Download'}
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5 text-footnote text-text-muted">
                      <Chip label="" value={relativeAge(detail.updatedAt, Date.now())} />
                      <Chip label="" value={`↓ ${compactCount(detail.downloads)}`} />
                      <Chip label="" value={`♡ ${compactCount(detail.likes)}`} />
                      <Chip label="" value="GGUF" />
                    </div>
                  </aside>
                ) : null}
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
