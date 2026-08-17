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
import { Markdown, ScrollArea, Spinner, Tooltip } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type { HfModelHitDTO, HfSortOption, LlmCatalogEntry } from '../../electron/ipc-contract';
import { cx } from '../onboarding/cx';
import { OrgAvatar } from '../settings/brand-icons';
import { ramVerdict } from '../settings/model-manager-logic';
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
  type ModelFormat,
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
function toHubModel(e: LlmCatalogEntry, totalRamGB: number): HubModel {
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
    /*
     * The fit verdict, from model-manager-logic's ramVerdict — the same
     * function the old panel used, so there is still one answer to "does this
     * fit". Without it "Only show models that fit" filtered EVERY model out
     * (it drops anything not known to fit), which made the hub's marquee
     * control empty the page.
     */
    ...(totalRamGB > 0 && e.minRamGB > 0
      ? (() => {
          const v = ramVerdict(e.minRamGB, totalRamGB);
          return { fits: v.fits, fitReason: v.detail ?? v.label };
        })()
      : {}),
  };
}

/**
 * An HF search hit → a hub row.
 *
 * This is what makes Discover actually discover. Everything the reference shows
 * and the bundled catalog cannot supply — downloads, likes, the update stamp,
 * the real author org, the parameter count — comes from here, which is why the
 * Downloads/Likes columns and a meaningful "Trending" only exist on this tab.
 */
function hfToHubModel(h: HfModelHitDTO): HubModel {
  const tags = h.tags.map((t) => t.toLowerCase());
  const caps: Array<Exclude<ModelCapability, 'all'>> = [];
  const has = (...needles: string[]) =>
    needles.some((n) => tags.some((t) => t.includes(n)) || h.pipelineTag?.includes(n) === true);
  if (has('vision', 'image-text', 'multimodal', 'vlm')) caps.push('vision');
  if (has('reason', 'thinking')) caps.push('reasoning');
  if (has('audio', 'speech', 'asr', 'tts')) caps.push('audio');
  if (has('embedding', 'sentence-similarity', 'feature-extraction')) caps.push('embeddings');
  if (has('text-to-image', 'diffusion', 'image-generation')) caps.push('image-generation');

  const formats: Array<Exclude<ModelFormat, 'all' | 'finetune'>> = [];
  if (tags.some((t) => t.includes('gguf'))) formats.push('gguf');
  if (tags.some((t) => t.includes('mlx'))) formats.push('mlx');
  if (tags.some((t) => t.includes('safetensors'))) formats.push('safetensors');
  if (formats.length === 0) formats.push('gguf');

  // The reference's Size column is a PARAMETER COUNT (27B, 95B, 1573B), read
  // off the repo name — HF search does not return a param field.
  const params = /(\d+(?:\.\d+)?)\s*[bB](?![a-z])/.exec(h.name)?.[1];

  return {
    id: h.id,
    name: h.name,
    org: h.author,
    /* NO verified badge. HF's search does not return one, and most of these
       authors are individuals rather than verified orgs — stamping a blue check
       on every row invents a credential HF actually grants selectively. */
    params: params === undefined ? undefined : `${params}B`,
    downloads: h.downloads,
    likes: h.likes,
    updatedAt: h.updatedAt === undefined ? undefined : Date.parse(h.updatedAt),
    formats,
    capabilities: caps,
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

  /* Escape closes it, as it does every other overlay here. Without this the
     full-screen click-away shield below swallowed every other control until
     the menu was dismissed by clicking. */
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<HfModelHitDTO[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [card, setCard] = useState<{ repo: string; markdown?: string; error?: string } | null>(
    null,
  );

  /*
   * DISCOVER SEARCHES HUGGING FACE. It used to filter the same 19 bundled
   * entries as On Device, which is why the reference's Downloads/Likes columns
   * never had data and "Trending" collapsed to alphabetical. Debounced, because
   * a request per keystroke is both rude to HF and rate-limited.
   */
  useEffect(() => {
    if (tab !== 'discover') return;
    const sortMap: Record<string, HfSortOption> = {
      newest: 'recent',
      updated: 'recent',
      trending: 'trending',
      downloads: 'downloads',
      likes: 'likes',
    };
    let cancelled = false;
    setHfError(null);
    setHfLoading(true);
    const t = setTimeout(() => {
      void window.piDesktop
        .invoke('hf:search', {
          query: filters.query.trim(),
          sort: sortMap[filters.sort] ?? 'trending',
          limit: 40,
        })
        .then((res) => {
          if (cancelled) return;
          setHits(res.hits);
          setHfError(
            res.rateLimited === true
              ? 'Hugging Face is rate-limiting us — showing what we have.'
              : (res.error ?? null),
          );
        })
        .catch(() => {
          if (!cancelled) setHfError('Could not reach Hugging Face. On Device still works.');
        })
        .finally(() => {
          if (!cancelled) setHfLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tab, filters.query, filters.sort]);

  useEffect(() => {
    void refreshCatalog();
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((i) => setHw({ ramGiB: Math.round(i.totalMemoryBytes / 1024 ** 3), cpus: i.cpuCount }))
      .catch(() => undefined);
  }, [refreshCatalog]);

  const all = useMemo(() => catalog.map((e) => toHubModel(e, hw?.ramGiB ?? 0)), [catalog, hw]);
  /* Discover = Hugging Face; On Device = what is actually on this disk. They
     are different SOURCES, not two filters over one list. */
  const discovered = useMemo(() => {
    const local = new Set(all.filter((m) => m.downloaded === true).map((m) => m.id));
    return hits.map((h) => ({ ...hfToHubModel(h), downloaded: local.has(h.id) }));
  }, [hits, all]);
  const scoped = useMemo(
    () => (tab === 'device' ? all.filter((m) => m.downloaded === true) : discovered),
    [all, discovered, tab],
  );
  const rows = useMemo(
    () => sortModels(filterModels(scoped, filters), filters.sort),
    [scoped, filters],
  );
  /* From the FILTERED rows, not the whole source: showing four trending cards
     above an "Nothing matches these filters" table made the page argue with
     itself. */
  const trending = useMemo(() => sortModels(rows, 'trending').slice(0, 4), [rows]);
  const detail = rows.find((m) => m.id === selected) ?? rows[0];

  /*
   * THE MODEL CARD. The reference gives most of its detail pane to the rendered
   * README; ours was mostly empty space. Keyed on the repo so switching rows
   * swaps the card, and main caches so going back and forth is instant.
   */
  const detailRepo = detail?.id;
  useEffect(() => {
    if (detailRepo === undefined || !detailRepo.includes('/')) {
      setCard(null);
      return;
    }
    let cancelled = false;
    setCard({ repo: detailRepo });
    void window.piDesktop
      .invoke('modelcard:fetch', { repoId: detailRepo })
      .then((res) => {
        if (!cancelled) setCard({ repo: detailRepo, ...res });
      })
      .catch(() => {
        if (!cancelled) setCard({ repo: detailRepo, error: 'could not load the model card' });
      });
    return () => {
      cancelled = true;
    };
  }, [detailRepo]);
  const localCount = all.filter((m) => m.downloaded === true).length;

  /* The hub's whole purpose. This was a <span> with no handler, in a pane the
     default view never rendered — so the page could not download a model. */
  const download = async (id: string) => {
    setBusyId(id);
    setError(null);
    const res = await window.piDesktop
      .invoke('llm:download-model', { modelId: id })
      .catch(() => ({ success: false, error: 'the download could not start' }));
    if (res.success !== true) setError(res.error ?? 'the download could not start');
    await refreshCatalog();
    setBusyId(null);
  };
  /* Does THIS source carry popularity data? The bundled catalog does not; the
     HF browse path does. Drives whether those columns exist at all. */
  /* Describes the SOURCE ON SCREEN. Reading `all` (the local catalog) meant the
     columns stayed hidden even on Discover, where every row has real counts. */
  const hasCounts = scoped.some((m) => m.downloads !== undefined || m.likes !== undefined);

  /*
   * Only offer filters this source can satisfy. The menus advertised
   * Safetensors / MLX / Fine-tune-ready and Audio / Embeddings / Image
   * generation against a catalog that is entirely GGUF text-and-vision, so six
   * of the options could only ever produce "Nothing matches these filters" —
   * a menu of dead ends is worse than a shorter menu.
   */
  const formatOptions = useMemo(() => {
    const present = new Set(all.flatMap((m) => m.formats));
    return FORMAT_OPTIONS.filter(
      (o) =>
        o.id === 'all' || (o.id === 'finetune' ? present.has('safetensors') : present.has(o.id)),
    );
  }, [all]);
  const capabilityOptions = useMemo(() => {
    const present = new Set(all.flatMap((m) => m.capabilities));
    return CAPABILITY_OPTIONS.filter((o) => o.id === 'all' || present.has(o.id));
  }, [all]);

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
          options={formatOptions}
          onChange={(format) => setFilters((f) => ({ ...f, format }))}
        />
        <Dropdown
          testid="filter-capability"
          value={filters.capability}
          options={capabilityOptions}
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
                    ? 'border-transparent bg-accent-primary text-text-on-accent'
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

      {hfError !== null ? (
        <p
          className="mx-8 mb-3 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-secondary"
          data-testid="models-hf-error"
        >
          {hfError}
        </p>
      ) : null}

      {error !== null ? (
        <p
          className="mx-8 mb-3 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-primary"
          data-testid="models-error"
        >
          {error}
        </p>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-8 pb-10">
          {(tab === 'discover' ? hfLoading && hits.length === 0 : catalog.length === 0) ? (
            <div className="flex items-center gap-2 py-10 text-body text-text-muted">
              <Spinner size={16} />{' '}
              {tab === 'discover' ? 'Searching Hugging Face…' : 'Loading models…'}
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
                            ? 'grid-cols-[1fr_120px_90px_110px_90px_44px]'
                            : 'grid-cols-[1fr_120px_90px_44px]',
                        )}
                      >
                        <span>Model</span>
                        <span>Capabilities</span>
                        <span>Size</span>
                        {hasCounts ? <span>Downloads</span> : null}
                        {hasCounts ? <span>Likes</span> : null}
                        <span className="sr-only">Download</span>
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
                              ? 'grid-cols-[1fr_120px_90px_110px_90px_44px]'
                              : 'grid-cols-[1fr_120px_90px_44px]',
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
                          {/* The reference's Size column is a PARAMETER COUNT
                              (27B, 95B); bytes belong to a specific quant and
                              only exist once a file is chosen. */}
                          <span className="text-footnote text-text-secondary">
                            {mdl.params ?? compactBytes(mdl.bytes)}
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
                          {/* The compact table is the DEFAULT view and never
                              renders the detail pane, so without this the hub
                              had no download affordance at all on first open. */}
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Download ${mdl.name}`}
                            data-testid={`row-download-${mdl.id}`}
                            aria-disabled={mdl.downloaded === true}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              if (mdl.downloaded !== true) void download(mdl.id);
                            }}
                            onKeyDown={(ev) => {
                              if (ev.key !== 'Enter' && ev.key !== ' ') return;
                              ev.preventDefault();
                              ev.stopPropagation();
                              if (mdl.downloaded !== true) void download(mdl.id);
                            }}
                            className={cx(
                              'flex h-7 w-7 items-center justify-center rounded-lg text-footnote transition-colors',
                              mdl.downloaded === true
                                ? 'text-text-muted'
                                : 'text-text-secondary hover:bg-bg-active hover:text-text-primary',
                            )}
                          >
                            {mdl.downloaded === true ? '✓' : '↓'}
                          </span>
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
                        label={
                          detail.fitReason ??
                          (detail.fits === true
                            ? 'Fits in this machine’s memory budget.'
                            : 'Not enough information to tell whether this fits.')
                        }
                        side="top"
                      >
                        <span
                          className={cx(
                            'h-2 w-2 shrink-0 rounded-full',
                            detail.fits === false
                              ? 'bg-status-danger-fg'
                              : detail.fits === true
                                ? 'bg-accent-primary'
                                : // Unknown is NOT a fit. Painting it like one
                                  // asserted a claim about the user's hardware
                                  // that the filter simultaneously treated as
                                  // false — one value, two opposite readings.
                                  'bg-border-strong',
                          )}
                          data-testid="detail-fit-dot"
                        />
                      </Tooltip>
                      <span className="flex-1 text-footnote text-text-primary">
                        {compactBytes(detail.bytes)}
                      </span>
                      <button
                        type="button"
                        data-testid={`download-${detail.id}`}
                        disabled={detail.downloaded === true || busyId === detail.id}
                        onClick={() => void download(detail.id)}
                        className={cx(
                          'rounded-lg px-2.5 py-1 text-footnote transition-opacity pd-focusable',
                          detail.downloaded === true
                            ? 'bg-bg-active text-text-muted'
                            : 'bg-accent-primary text-text-on-accent hover:opacity-90',
                        )}
                      >
                        {detail.downloaded === true
                          ? 'Installed'
                          : busyId === detail.id
                            ? 'Starting…'
                            : 'Download'}
                      </button>
                    </div>

                    {/* Only chips we actually have a value for — a row of
                        em-dashes is the thing this file already argues against
                        for the table columns. */}
                    <div className="mt-3 flex flex-wrap gap-1.5 text-footnote text-text-muted">
                      {detail.updatedAt !== undefined ? (
                        <Chip label="" value={relativeAge(detail.updatedAt, Date.now())} />
                      ) : null}
                      {detail.downloads !== undefined ? (
                        <Chip label="" value={`↓ ${compactCount(detail.downloads)}`} />
                      ) : null}
                      {detail.likes !== undefined ? (
                        <Chip label="" value={`♡ ${compactCount(detail.likes)}`} />
                      ) : null}
                      {detail.params !== undefined ? <Chip label="" value={detail.params} /> : null}
                      {detail.formats.map((f) => (
                        <Chip key={f} label="" value={f.toUpperCase()} />
                      ))}
                    </div>

                    <div
                      className="mt-4 border-t border-border-default pt-3"
                      data-testid="model-card"
                    >
                      {card?.repo !== detail.id ||
                      (card.markdown === undefined && card.error === undefined) ? (
                        <p className="flex items-center gap-2 text-footnote text-text-muted">
                          <Spinner size={12} /> Loading model card…
                        </p>
                      ) : card.error !== undefined ? (
                        <p className="text-footnote text-text-muted">{card.error}</p>
                      ) : (
                        // Markdown renders its own .pd-prose container; do not
                        // double-wrap it.
                        <Markdown>{card.markdown ?? ''}</Markdown>
                      )}
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
