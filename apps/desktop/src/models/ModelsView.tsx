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
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconExternal,
  IconGauge,
  IconInfo,
  IconMore,
  IconRefresh,
  Markdown,
  ScrollArea,
  Spinner,
  Tooltip,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type {
  DatasetHitDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCatalogEntry,
} from '../../electron/ipc-contract';
import { cx } from '../onboarding/cx';
import { OrgAvatar } from '../settings/brand-icons';
import { type QuantOption, ramVerdict } from '../settings/model-manager-logic';
import { useLlmStore } from '../state/llm-store';
import { CapabilityPills } from './model-pills';
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
import { QuantPicker } from './QuantPicker';

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
    createdAt: h.createdAt === undefined ? undefined : Date.parse(h.createdAt),
    formats,
    capabilities: caps,
  };
}

/**
 * A readable name for one downloadable file.
 *
 * HF only sometimes reports a `quant`; the rest of the time the picker fell back
 * to the whole filename, so the row read
 * "zimageuncensoredtextencoderV10_v10.gguf" instead of "Q4_K_M". Pull the quant
 * out of the filename where it is there — it almost always is, that being the
 * convention — and only then fall back to the stem.
 */
function quantLabel(quant: string | undefined, filePath: string): string {
  // Do NOT trust `quant` blindly: the supervisor falls back to the filename
  // when it cannot parse one, so a naive check shows the whole ".gguf" path.
  const looksParsed =
    quant !== undefined &&
    quant.length > 0 &&
    quant.length < 24 &&
    !quant.toLowerCase().endsWith('.gguf');
  if (looksParsed) return quant;
  const file = (quant ?? filePath).split('/').pop() ?? filePath;
  const stem = file.replace(/\.gguf$/i, '');
  // UD-Q4_K_XL / IQ3_M / Q8_0 / BF16 / F16 — the shapes that actually appear.
  const m = /((?:UD-)?(?:IQ|Q)\d[A-Z0-9_]*|BF16|F16|F32)/i.exec(stem);
  return m?.[1] ?? stem;
}

/**
 * A metadata chip. The reference's chips lead with a small monochrome ICON —
 * that is what stops a wrap of eight of them reading as a word soup, because
 * the glyph is recognisable before the value is read.
 */
/**
 * The per-row `⋮` menu the reference has at the end of every row. Everything in
 * it is reachable elsewhere, which is the point: a row menu is for the actions
 * you want WITHOUT first making the row the selection.
 */
function RowMenu({
  model,
  onDownload,
  onOpenHf,
  onCopyId,
}: {
  model: HubModel;
  onDownload: () => void;
  onOpenHf: () => void;
  onCopyId: () => void;
}) {
  const [open, setOpen] = useState(false);
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

  const item = (label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      data-testid={`row-menu-item-${label.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        run();
      }}
      className={cx(
        'w-full rounded-lg px-2.5 py-1.5 text-left text-footnote',
        disabled ? 'text-text-muted' : 'text-text-primary hover:bg-bg-hover',
      )}
    >
      {label}
    </button>
  );

  return (
    <span className="relative flex justify-end">
      <span
        role="button"
        tabIndex={0}
        aria-label={`More actions for ${model.name}`}
        data-testid={`row-menu-${model.id}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-active hover:text-text-primary"
      >
        <IconMore size={15} />
      </span>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-20 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            data-testid="row-menu-panel"
            className="absolute top-full right-0 z-30 mt-1 min-w-[180px] rounded-xl border border-border-subtle bg-bg-raised p-1 shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
          >
            {item('Download', onDownload, model.downloaded === true)}
            {item('Copy model id', onCopyId)}
            {item('Open on Hugging Face', onOpenHf, !model.id.includes('/'))}
          </div>
        </>
      ) : null}
    </span>
  );
}

function Chip({ label, value, icon }: { label?: string; value: string; icon?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-raised px-2.5 py-1 text-footnote">
      {icon !== undefined ? <span className="text-text-muted">{icon}</span> : null}
      <span className="text-text-primary">{value}</span>
      {label !== undefined && label !== '' ? (
        <span className="text-text-muted">{label}</span>
      ) : null}
    </span>
  );
}

/** Downloads have no dedicated icon in the set; a rotated arrow is the mark. */
function IconDownload({ size = 13 }: { size?: number }) {
  return <IconArrowUp size={size} className="rotate-180" />;
}

/** Nor a heart, and likes need one. Inline rather than a text glyph, which
 *  renders in whatever emoji font the OS picks and never matches the row. */
function IconHeart({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 2.7C19 15.6 12 20 12 20Z" />
    </svg>
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
        className="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-raised px-3.5 py-1.5 text-footnote text-text-secondary shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
      >
        {current}
        <IconChevronDown size={14} className="text-text-muted" />
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
            className="absolute top-full left-0 z-20 mt-1 min-w-[260px] rounded-xl border border-border-subtle bg-bg-raised p-1 shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
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
                {o.id === value ? <IconCheck size={14} className="text-text-muted" /> : null}
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
  /* Datasets are the reference's sibling page. Same chrome, different corpus —
     so they live here behind a kind switch rather than in a second view that
     would duplicate the header, search and filter row. */
  const [kind, setKind] = useState<'models' | 'datasets'>('models');
  const [datasets, setDatasets] = useState<DatasetHitDTO[]>([]);
  const [dsLoading, setDsLoading] = useState(false);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [card, setCard] = useState<{ repo: string; markdown?: string; error?: string } | null>(
    null,
  );
  /* The quant ladder for the selected model. HF entries need a file listing;
     local catalog entries already carry theirs. */
  const [quants, setQuants] = useState<{
    repo: string;
    options: QuantOption[];
    mmprojBytes?: number;
    loading: boolean;
  } | null>(null);

  /*
   * DISCOVER SEARCHES HUGGING FACE. It used to filter the same 19 bundled
   * entries as On Device, which is why the reference's Downloads/Likes columns
   * never had data and "Trending" collapsed to alphabetical. Debounced, because
   * a request per keystroke is both rude to HF and rate-limited.
   */
  useEffect(() => {
    if (tab !== 'discover') return;
    const sortMap: Record<string, HfSortOption> = {
      // HF's `recent` is lastModified; there is no created sort in the DTO's
      // option set, so newest asks for recent and we re-sort locally on
      // createdAt, which the hit now carries.
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
    if (kind !== 'datasets') return;
    let cancelled = false;
    setDsLoading(true);
    const t = setTimeout(() => {
      void window.piDesktop
        .invoke('datasets:search', {
          query: filters.query.trim(),
          sort:
            filters.sort === 'downloads'
              ? 'downloads'
              : filters.sort === 'likes'
                ? 'likes'
                : filters.sort === 'trending'
                  ? 'trending'
                  : 'recent',
          limit: 40,
        })
        .then((res) => {
          if (cancelled) return;
          setDatasets(res.hits);
          setHfError(
            res.rateLimited === true
              ? 'Hugging Face is rate-limiting us — showing what we have.'
              : (res.error ?? null),
          );
        })
        .catch(() => {
          if (!cancelled) setHfError('Could not reach Hugging Face.');
        })
        .finally(() => {
          if (!cancelled) setDsLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [kind, filters.query, filters.sort]);

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
  const datasetRows = useMemo<HubModel[]>(
    () =>
      datasets.map((d) => ({
        id: d.id,
        name: d.name,
        org: d.author,
        downloads: d.downloads,
        likes: d.likes,
        updatedAt: d.updatedAt === undefined ? undefined : Date.parse(d.updatedAt),
        createdAt: d.createdAt === undefined ? undefined : Date.parse(d.createdAt),
        formats: [],
        capabilities: [],
      })),
    [datasets],
  );

  const scoped = useMemo(
    () =>
      kind === 'datasets'
        ? datasetRows
        : tab === 'device'
          ? all.filter((m) => m.downloaded === true)
          : discovered,
    [all, discovered, datasetRows, kind, tab],
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

  /*
   * THE QUANT LADDER. `hf:list-files` returns every .gguf in the repo with its
   * size, which is what the picker ranks; a local catalog entry already has its
   * own list, so that path costs no request. Vision projectors are pulled out
   * rather than offered as a choice — you never download an mmproj INSTEAD of
   * the weights, it loads alongside them, and its bytes belong in the fit maths.
   */
  useEffect(() => {
    if (detailRepo === undefined) {
      setQuants(null);
      return;
    }
    const local = catalog.find((e) => e.id === detailRepo);
    if (local !== undefined) {
      setQuants({
        repo: detailRepo,
        options: local.quants.filter((q) => q.bytes > 0),
        loading: false,
      });
      return;
    }
    if (!detailRepo.includes('/')) {
      setQuants({ repo: detailRepo, options: [], loading: false });
      return;
    }
    let cancelled = false;
    setQuants({ repo: detailRepo, options: [], loading: true });
    void window.piDesktop
      .invoke('hf:list-files', { repoId: detailRepo })
      .then((res) => {
        if (cancelled) return;
        const files = res.files ?? [];
        const mmproj = files.find((f) => f.mmproj === true)?.sizeBytes;
        setQuants({
          repo: detailRepo,
          options: files
            .filter((f) => f.mmproj !== true && (f.sizeBytes ?? 0) > 0)
            .map((f) => ({
              quant: quantLabel(f.quant, f.path),
              bytes: f.sizeBytes ?? 0,
            })),
          mmprojBytes: mmproj,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setQuants({ repo: detailRepo, options: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [detailRepo, catalog]);
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
  const openOnHf = (id: string) => {
    void window.piDesktop
      .invoke('canvas:open-external', { url: `https://huggingface.co/${id}` })
      .catch(() => undefined);
  };
  const copyId = (id: string) => void navigator.clipboard?.writeText(id);

  const download = async (id: string, quant?: string) => {
    setBusyId(id);
    setError(null);
    const res = await window.piDesktop
      .invoke('llm:download-model', quant === undefined ? { modelId: id } : { modelId: id, quant })
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
      {/* No traffic-light strip: the hub renders INSIDE the chat shell now, which
          already owns the drag region and the top bar. A second one here left a
          dead 44px band and a back button under the real title. */}
      {/* Header + hardware strip */}
      <div className="flex shrink-0 items-start justify-between gap-6 px-6 pt-3 pb-3">
        <div>
          <button
            type="button"
            data-testid="models-back"
            onClick={onClose}
            className="-ml-2 mb-1 flex items-center gap-1 rounded-lg px-2 py-1 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
          >
            <IconChevronDown size={13} className="rotate-90" />
            Back to chat
          </button>
          <h1 className="text-title text-text-primary">
            {kind === 'datasets' ? 'Datasets' : 'Model hub'}
          </h1>
          <p className="mt-0.5 text-footnote text-text-muted">
            {kind === 'datasets'
              ? 'Discover, download, and train on datasets locally.'
              : 'Discover, download, and run inference models locally.'}
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
      <div className="flex shrink-0 items-center gap-3 px-6 pb-3">
        <div className="flex rounded-full bg-bg-inset p-0.5" data-testid="hub-kind">
          {(['models', 'datasets'] as const).map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`hub-kind-${k}`}
              onClick={() => setKind(k)}
              className={cx(
                'rounded-full px-4 py-1.5 text-footnote transition-colors',
                kind === k ? 'bg-bg-raised text-text-primary shadow-sm' : 'text-text-secondary',
              )}
            >
              {k === 'models' ? 'Models' : 'Datasets'}
            </button>
          ))}
        </div>
        <div className={cx('flex rounded-full bg-bg-inset p-0.5', kind === 'datasets' && 'hidden')}>
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
          className="min-w-0 flex-1 rounded-full border border-border-subtle bg-bg-raised px-4 py-2 text-body text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-text-muted pd-focusable"
        />
      </div>

      {/* Filter row */}
      <div className="flex shrink-0 items-center gap-2 px-6 pb-4">
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
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  filters.onlyFits
                    ? 'border-transparent bg-accent-primary text-text-on-accent'
                    : 'border-border-strong',
                )}
              >
                {filters.onlyFits ? <IconCheck size={11} /> : null}
              </span>
              <span className="whitespace-nowrap">Only show models that fit</span>
            </button>
          }
        />
        <div className="ml-auto flex rounded-lg border border-border-subtle bg-bg-raised p-0.5">
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
              <span className="flex h-4 w-4 items-center justify-center">
                {v === 'compact' ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                    <title>Compact</title>
                    <rect x="1" y="3" width="14" height="1.6" rx=".8" fill="currentColor" />
                    <rect x="1" y="7.2" width="14" height="1.6" rx=".8" fill="currentColor" />
                    <rect x="1" y="11.4" width="14" height="1.6" rx=".8" fill="currentColor" />
                  </svg>
                ) : v === 'split' ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                    <title>Split</title>
                    <rect x="1" y="2" width="8.4" height="12" rx="1.4" fill="currentColor" />
                    <rect
                      x="10.8"
                      y="2"
                      width="4.2"
                      height="12"
                      rx="1.4"
                      fill="currentColor"
                      opacity=".45"
                    />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                    <title>Detail</title>
                    <rect
                      x="1"
                      y="2"
                      width="5"
                      height="12"
                      rx="1.4"
                      fill="currentColor"
                      opacity=".45"
                    />
                    <rect x="7.4" y="2" width="7.6" height="12" rx="1.4" fill="currentColor" />
                  </svg>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      {hfError !== null ? (
        <p
          className="mx-6 mb-3 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-secondary"
          data-testid="models-hf-error"
        >
          {hfError}
        </p>
      ) : null}

      {error !== null ? (
        <p
          className="mx-6 mb-3 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-primary"
          data-testid="models-error"
        >
          {error}
        </p>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pb-10">
          {(
            kind === 'datasets'
              ? dsLoading && datasets.length === 0
              : tab === 'discover'
                ? hfLoading && hits.length === 0
                : catalog.length === 0
          ) ? (
            <div className="flex items-center gap-2 py-10 text-body text-text-muted">
              <Spinner size={16} />{' '}
              {kind === 'datasets'
                ? 'Searching datasets…'
                : tab === 'discover'
                  ? 'Searching Hugging Face…'
                  : 'Loading models…'}
            </div>
          ) : (
            <>
              {kind === 'models' &&
              tab === 'discover' &&
              view !== 'detail' &&
              trending.length > 0 ? (
                <section className="mb-7">
                  <h2 className="mb-3 text-body font-medium text-text-primary">Trending Now</h2>
                  <div className="grid grid-cols-4 gap-3" data-testid="trending-row">
                    {trending.map((mdl) => (
                      <button
                        key={mdl.id}
                        type="button"
                        onClick={() => setSelected(mdl.id)}
                        className="rounded-2xl border border-border-subtle bg-bg-raised p-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all hover:border-border-default hover:shadow-[0_2px_8px_rgba(0,0,0,0.07)] pd-focusable"
                      >
                        <div className="flex items-start gap-2.5">
                          <OrgAvatar org={mdl.org} size={36} />
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
                          {hasCounts ? (
                            <span className="inline-flex items-center gap-1">
                              <IconDownload /> {compactCount(mdl.downloads)}
                            </span>
                          ) : null}
                          {hasCounts ? (
                            <span className="inline-flex items-center gap-1">
                              <IconHeart /> {compactCount(mdl.likes)}
                            </span>
                          ) : null}
                          {(mdl.params ?? mdl.bytes !== undefined) ? (
                            <span className="ml-auto rounded-md bg-bg-inset px-2 py-0.5 font-medium text-text-secondary">
                              {mdl.params ?? compactBytes(mdl.bytes)}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {/*
               * THREE LAYOUTS, NOT TWO. `split` and `detail` rendered
               * identically — three buttons, two behaviours, which is worse
               * than offering two. They now differ in which side gets the room,
               * matching the reference's own toggle icons: split favours the
               * list, detail favours the card.
               */}
              <section
                data-testid="models-layout"
                data-view={view}
                className={cx(
                  'grid gap-5',
                  view === 'compact'
                    ? ''
                    : view === 'split'
                      ? 'grid-cols-[minmax(0,1fr)_420px]'
                      : 'grid-cols-[300px_minmax(0,1fr)]',
                )}
              >
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <h2 className="text-body font-medium text-text-primary">
                      {kind === 'datasets'
                        ? 'All datasets'
                        : tab === 'device'
                          ? 'On this machine'
                          : 'All models'}
                    </h2>
                    <button
                      type="button"
                      aria-label="Refresh"
                      data-testid="models-refresh"
                      onClick={() => void refreshCatalog()}
                      className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
                    >
                      <IconRefresh size={14} />
                    </button>
                    <span className="ml-auto text-footnote text-text-muted">
                      {rows.length} model{rows.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {view === 'compact' ? (
                    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-raised shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                      {/* Downloads/Likes only exist for HF-sourced entries. A
                          column of em-dashes is worse than no column: it looks
                          like the data failed to load rather than never
                          applying to a bundled catalog. */}
                      <div
                        className={cx(
                          'grid items-center gap-2 border-b border-border-subtle bg-bg-sunken px-4 py-2.5 text-footnote text-text-muted',
                          hasCounts
                            ? 'grid-cols-[1fr_120px_90px_110px_90px_44px_40px]'
                            : 'grid-cols-[1fr_120px_90px_44px_40px]',
                        )}
                      >
                        <span>Model</span>
                        <span>Capabilities</span>
                        <span>Size</span>
                        {hasCounts ? <span>Downloads</span> : null}
                        {hasCounts ? <span>Likes</span> : null}
                        <span className="sr-only">Download</span>
                        <span className="sr-only">Actions</span>
                      </div>
                      {rows.map((mdl) => (
                        <button
                          key={mdl.id}
                          type="button"
                          data-testid={`model-row-${mdl.id}`}
                          onClick={() => setSelected(mdl.id)}
                          className={cx(
                            'grid w-full items-center gap-2 border-b border-border-subtle px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-bg-hover',
                            hasCounts
                              ? 'grid-cols-[1fr_120px_90px_110px_90px_44px_40px]'
                              : 'grid-cols-[1fr_120px_90px_44px_40px]',
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
                          <CapabilityPills caps={mdl.capabilities} dense max={4} />
                          {/* The reference's Size column is a PARAMETER COUNT
                              (27B, 95B); bytes belong to a specific quant and
                              only exist once a file is chosen. */}
                          <span className="text-footnote text-text-secondary">
                            {mdl.params ?? compactBytes(mdl.bytes)}
                          </span>
                          {hasCounts ? (
                            <span className="inline-flex items-center gap-1 text-footnote text-text-secondary">
                              <IconDownload /> {compactCount(mdl.downloads)}
                            </span>
                          ) : null}
                          {hasCounts ? (
                            <span className="inline-flex items-center gap-1 text-footnote text-text-secondary">
                              <IconHeart /> {compactCount(mdl.likes)}
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
                            {mdl.downloaded === true ? (
                              <IconCheck size={14} />
                            ) : (
                              <IconDownload size={14} />
                            )}
                          </span>
                          <RowMenu
                            model={mdl}
                            onDownload={() => void download(mdl.id)}
                            onOpenHf={() => openOnHf(mdl.id)}
                            onCopyId={() => copyId(mdl.id)}
                          />
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
                      {rows.map((mdl) => {
                        const active = detail?.id === mdl.id;
                        return (
                          <button
                            key={mdl.id}
                            type="button"
                            data-testid={`model-row-${mdl.id}`}
                            onClick={() => setSelected(mdl.id)}
                            className={cx(
                              'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                              active
                                ? 'border-accent-primary bg-bg-active'
                                : 'border-border-subtle bg-bg-raised shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-border-default',
                            )}
                          >
                            <OrgAvatar org={mdl.org} size={view === 'detail' ? 28 : 34} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body text-text-primary">
                                {mdl.name}
                              </span>
                              <span className="block truncate text-footnote text-text-muted">
                                {mdl.org}
                              </span>
                            </span>
                            {/* The rail is 300px; a size column there would
                                squeeze the name to nothing. */}
                            {view === 'split' ? (
                              <span className="shrink-0 text-footnote text-text-muted">
                                {mdl.params ?? compactBytes(mdl.bytes)}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {view !== 'compact' && detail !== undefined ? (
                  <aside
                    className={cx(
                      'overflow-y-auto rounded-2xl border border-border-subtle bg-bg-raised p-5 shadow-[0_1px_3px_rgba(0,0,0,0.05)]',
                      view === 'detail' ? 'max-h-[calc(100vh-190px)]' : 'max-h-[calc(100vh-260px)]',
                    )}
                    data-testid="model-detail"
                    data-view={view}
                  >
                    <div className="flex items-start gap-3">
                      <OrgAvatar org={detail.org} size={48} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-1.5">
                          <h3 className="min-w-0 flex-1 break-words text-body font-medium text-text-primary">
                            {detail.name}
                          </h3>
                          {/* Copy the repo id and open it on the Hub — both are
                              in the reference beside the title, and both are
                              what someone actually wants from a card. */}
                          <button
                            type="button"
                            aria-label="Copy model id"
                            data-testid="detail-copy"
                            onClick={() => copyId(detail.id)}
                            className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
                          >
                            <IconCopy size={14} />
                          </button>
                          {detail.id.includes('/') ? (
                            <button
                              type="button"
                              aria-label="Open on Hugging Face"
                              data-testid="detail-open"
                              onClick={() => openOnHf(detail.id)}
                              className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
                            >
                              <IconExternal size={14} />
                            </button>
                          ) : null}
                        </div>
                        <p className="flex items-center gap-1 text-footnote text-text-muted">
                          {detail.org}
                          {detail.verified === true ? (
                            <span className="text-accent-primary">✓</span>
                          ) : null}
                        </p>
                      </div>
                    </div>

                    {detail.capabilities.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <CapabilityPills caps={detail.capabilities} />
                      </div>
                    ) : null}

                    <QuantPicker
                      options={quants?.repo === detail.id ? quants.options : []}
                      loading={quants?.repo === detail.id ? quants.loading : true}
                      totalRamGB={hw?.ramGiB ?? 0}
                      mmprojBytes={quants?.mmprojBytes}
                      format={detail.formats[0]?.toUpperCase()}
                      installed={detail.downloaded === true}
                      downloading={busyId === detail.id}
                      onDownload={(q) => void download(detail.id, q)}
                    />

                    {/* Only chips we actually have a value for — a row of
                        em-dashes is the thing this file already argues against
                        for the table columns. */}
                    <div className="mt-3 flex flex-wrap gap-1.5 text-footnote text-text-muted">
                      {detail.updatedAt !== undefined ? (
                        <Chip
                          icon={<IconClock size={12} />}
                          value={relativeAge(detail.updatedAt, Date.now())}
                        />
                      ) : null}
                      {detail.downloads !== undefined ? (
                        <Chip
                          icon={<IconDownload size={12} />}
                          value={compactCount(detail.downloads)}
                        />
                      ) : null}
                      {detail.likes !== undefined ? (
                        <Chip icon={<IconHeart size={12} />} value={compactCount(detail.likes)} />
                      ) : null}
                      {detail.params !== undefined ? (
                        <Chip icon={<IconGauge size={12} />} value={detail.params} />
                      ) : null}
                      {detail.formats.map((f) => (
                        <Chip key={f} value={f.toUpperCase()} />
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
                        <div className="pd-model-card">
                          <Markdown>{card.markdown ?? ''}</Markdown>
                        </div>
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
