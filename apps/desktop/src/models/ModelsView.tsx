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
  DEFAULT_RECOMMENDED_AUTHORS,
  type PublisherDomain,
  reliableAuthorsForDomains,
} from '@pi-desktop/inference/catalog';
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconExternal,
  IconGauge,
  IconMore,
  IconRefresh,
  ScrollArea,
  Spinner,
} from '@pi-desktop/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DatasetHitDTO,
  HfGgufFileDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCatalogEntry,
} from '../../electron/ipc-contract';
import { cx } from '../onboarding/cx';
import { OrgAvatar } from '../settings/brand-icons';
import { type QuantOption, ramVerdict } from '../settings/model-manager-logic';
import { useHfStore } from '../state/hf-store';
import { downloadEtaSeconds, downloadFraction, formatEta, useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { useModalityStore } from '../state/modality-store';
import { setHfToken, useHfToken } from '../state/settings-store';
import { hasRepo, useStoreModels } from '../state/store-models';
import { BestForYourMachine } from './BestForYourMachine';
import { DownloadAction } from './DownloadAction';
import { FamilyCard } from './FamilyCard';
import { ModelCard } from './ModelCard';
import { CapabilityPills } from './model-pills';
import type { ModelRecommendation } from './model-recommender';
import {
  CAPABILITY_OPTIONS,
  compactBytes,
  compactCount,
  DEFAULT_DATASET_FILTERS,
  DEFAULT_FILTERS,
  FORMAT_OPTIONS,
  filterModels,
  formatPipelineTag,
  type HubFilters,
  type HubModel,
  type ModelCapability,
  type ModelFormat,
  relativeAge,
  SORT_OPTIONS,
  sortModels,
  type ViewMode,
  wantsNonGguf,
} from './models-layout';
import { QuantPicker } from './QuantPicker';
import {
  fitFor,
  installKindOf,
  OUTPUT_LABEL,
  type OutputModality,
  RECOMMENDED_FAMILIES,
  type RecommendedFamily,
  type RecommendedVariant,
  recommendedFamilies,
} from './recommended-catalog';
import { useOutsideClose } from './use-outside-close';

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
  // Every catalog entry is a text model; that is what makes it launchable here.
  caps.push('text-generation');
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
/**
 * The HF pipeline tag as an in→out chip — the user: "see at a glance the hf label
 * that is in-out". Renders nothing for a tag we cannot read, so a row never
 * shows a cryptic or wrong badge.
 */
function PipelineBadge({ tag, className }: { tag?: string; className?: string }) {
  const label = formatPipelineTag(tag);
  if (label === undefined) return null;
  return (
    <span
      data-testid="pipeline-badge"
      title={tag}
      className={cx(
        'shrink-0 rounded bg-bg-inset px-1.5 py-px text-caption text-text-secondary',
        className,
      )}
    >
      {label}
    </span>
  );
}

function hfToHubModel(h: HfModelHitDTO): HubModel {
  const tags = h.tags.map((t) => t.toLowerCase());
  const caps: Array<Exclude<ModelCapability, 'all'>> = [];
  const has = (...needles: string[]) =>
    needles.some((n) => tags.some((t) => t.includes(n)) || h.pipelineTag?.includes(n) === true);
  if (has('vision', 'image-text', 'multimodal', 'vlm')) caps.push('vision');
  if (has('reason', 'thinking')) caps.push('reasoning');
  if (has('audio', 'speech', 'asr', 'tts')) caps.push('audio');
  if (has('embedding', 'sentence-similarity', 'feature-extraction')) caps.push('embeddings');
  // NOT bare "diffusion": audio-diffusion (stable-audio) carries that tag too and
  // was landing under the Image filter. The pipeline tag text-to-image and the
  // named image families are the reliable signal.
  if (has('text-to-image', 'image-to-image', 'stable-diffusion', 'image-generation', 'flux'))
    caps.push('image-generation');
  // Generation types, now part of the same axis as capabilities.
  if (has('text-to-video', 'video-generation', 'image-to-video')) caps.push('video-generation');
  if (has('text-to-3d', 'image-to-3d', '3d')) caps.push('3d-generation');
  if (has('text-generation', 'conversational')) caps.push('text-generation');

  const formats: Array<Exclude<ModelFormat, 'all' | 'finetune'>> = [];
  if (tags.some((t) => t.includes('gguf'))) formats.push('gguf');
  if (tags.some((t) => t.includes('mlx'))) formats.push('mlx');
  if (tags.some((t) => t.includes('safetensors'))) formats.push('safetensors');
  if (formats.length === 0) formats.push('gguf');

  /*
   * The Size column is a PARAMETER COUNT (27B, 95B, 1573B), and it comes from
   * TWO sources in this order, which took a screenshot to get right:
   *
   *   1. the repo NAME — the author's own statement about the model;
   *   2. HF's `gguf.total`, only when the name says nothing.
   *
   * The tempting order is the other way round: `gguf.total` is an exact number
   * read from a GGUF header, so it looks strictly better than a regex. It is
   * not. That block describes ONE file HF happened to index, which for a repo
   * whose featured file is an MTP head or a projector is 0.5B or ~0. Trusting
   * it first rendered "Qwen3.8-27B-ARA-vision-MTP" as 0.5B and
   * "Qwen3.8-27B-Uncensored-JoyFox" as 0.0B — both say 27B on the tin.
   *
   * So HF's number earns its place on the repos that never spell a size out,
   * where this column used to show "—", and stays out of the way otherwise.
   */
  const fromName = Number.parseFloat(/(\d+(?:\.\d+)?)\s*[bB](?![a-z])/.exec(h.name)?.[1] ?? '');
  const fromHeader =
    h.paramsTotal !== undefined && h.paramsTotal > 0 ? h.paramsTotal / 1e9 : Number.NaN;
  const paramsB = Number.isFinite(fromName) ? fromName : fromHeader;
  const params = Number.isFinite(paramsB)
    ? // A whole number reads better than "27.3B"; keep one decimal under 10B.
      `${paramsB >= 10 ? Math.round(paramsB) : Number(paramsB.toFixed(1))}B`
    : undefined;

  return {
    id: h.id,
    name: h.name,
    org: h.author,
    /* NO verified badge. HF's search does not return one, and most of these
       authors are individuals rather than verified orgs — stamping a blue check
       on every row invents a credential HF actually grants selectively. */
    params,
    paramsB: Number.isFinite(paramsB) ? paramsB : undefined,
    pipelineTag: h.pipelineTag,
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
  kind,
}: {
  model: HubModel;
  onDownload: () => void;
  onOpenHf: () => void;
  onCopyId: () => void;
  /** Datasets have no weights file to fetch and no "model id" to copy. */
  kind: 'models' | 'datasets';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  /* Closes on an outside press and on Escape, WITHOUT a full-screen overlay —
     the overlay swallowed the wheel across the whole window, so nothing behind
     an open menu could be scrolled. See use-outside-close.ts. */
  useOutsideClose(open, rootRef, close);

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
      className={cx('pd-menu-item text-footnote', disabled ? 'text-text-muted' : undefined)}
    >
      {label}
    </button>
  );

  return (
    <span className="relative flex justify-end" ref={rootRef}>
      {/* biome-ignore lint/a11y/useSemanticElements: nested inside the row <button>; a real <button> here is invalid button-in-button HTML */}
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
          {/*
           * SHARED SURFACE, not a local one. Every dropdown in the app draws
           * from `.pd-menu` in packages/ui/styles/menu.css — the user wants "the
           * same master switch so that you change the style and they all
           * change". Only POSITION is local here; the ring, radius, surface and
           * the (now instant) open behaviour all come from there.
           */}
          <div
            data-testid="row-menu-panel"
            className="pd-menu absolute top-full right-0 z-30 mt-1 min-w-[180px]"
          >
            {kind === 'models' ? item('Download', onDownload, model.downloaded === true) : null}
            {item(kind === 'datasets' ? 'Copy dataset id' : 'Copy model id', onCopyId)}
            {item('Open on Hugging Face', onOpenHf, !model.id.includes('/'))}
          </div>
        </>
      ) : null}
    </span>
  );
}

/**
 * MULTI-SELECT CAPABILITIES.
 *
 * the user: "have that capabilities dropdown be a checkbox that doesn't immediately
 * close dropdown so you can select multiple." So a tick does NOT dismiss the
 * menu — the whole point is picking several — and the trigger summarises the
 * selection rather than showing one value.
 *
 * Grouped into "understands" and "generates", which is where the generation
 * types (text/image/video/3D) live now that they are folded in here.
 */
function CapabilityFilter({
  selected,
  options,
  onChange,
}: {
  selected: readonly ModelCapability[];
  options: ReadonlyArray<{ id: ModelCapability; label: string; group: string }>;
  onChange: (next: ModelCapability[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  /* Closes on an outside press and on Escape, WITHOUT a full-screen overlay —
     the overlay swallowed the wheel across the whole window, so nothing behind
     an open menu could be scrolled. See use-outside-close.ts. */
  useOutsideClose(open, rootRef, close);

  const label =
    selected.length === 0
      ? 'All capabilities'
      : selected.length === 1
        ? (options.find((o) => o.id === selected[0])?.label ?? '1 selected')
        : `${selected.length} selected`;

  const toggle = (id: ModelCapability) =>
    onChange(selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]);

  const groups: Array<{ key: string; title: string }> = [
    { key: 'understands', title: 'Understands' },
    { key: 'generates', title: 'Generates' },
  ];

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid="filter-capability"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-raised px-3.5 py-1.5 text-footnote text-text-secondary shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
      >
        {label}
        <IconChevronDown size={14} className="text-text-muted" />
      </button>
      {open ? (
        <div
          data-testid="filter-capability-menu"
          className="pd-menu absolute top-full left-0 z-20 mt-1 min-w-[240px]"
        >
          {groups.map((g) => {
            const inGroup = options.filter((o) => o.group === g.key);
            if (inGroup.length === 0) return null;
            return (
              <div key={g.key}>
                <p className="pd-menu-label">{g.title}</p>
                {inGroup.map((o) => {
                  const on = selected.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      data-testid={`filter-capability-opt-${o.id}`}
                      aria-pressed={on}
                      // Deliberately does NOT close: multi-select.
                      onClick={() => toggle(o.id)}
                      className="pd-menu-item"
                    >
                      <span
                        className={cx(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          on
                            ? 'border-transparent bg-accent-primary text-text-on-accent'
                            : 'border-border-strong',
                        )}
                      >
                        {on ? <IconCheck size={11} /> : null}
                      </span>
                      <span className="flex-1">{o.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {selected.length > 0 ? (
            <div className="mt-1 border-t border-border-subtle pt-1">
              <button
                type="button"
                data-testid="filter-capability-clear"
                onClick={() => onChange([])}
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-footnote text-text-secondary hover:bg-bg-hover"
              >
                Clear all
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
      role="img"
      aria-label="likes"
    >
      <title>likes</title>
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
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(open, rootRef, close);
  return (
    <div className="relative" ref={rootRef}>
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
        <div
          data-testid={`${testid}-menu`}
          className="pd-menu absolute top-full left-0 z-20 mt-1 min-w-[260px]"
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
              className="pd-menu-item"
            >
              {o.dot !== undefined ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: o.dot }} />
              ) : null}
              <span className="flex-1">{o.label}</span>
              {o.id === value ? <IconCheck size={14} className="text-text-muted" /> : null}
            </button>
          ))}
          {footer !== undefined ? (
            <>
              <div className="pd-menu-separator" />
              {footer}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Slider ceiling, which doubles as "no cap". Wide enough for a 120GB dataset
 *  and a 200B model; past that the control is dead travel either way. */
const SIZE_CAP_MAX = 200;

/**
 * Map the hub's capability filter to publisher domains, so "Recommended" fans
 * out to the RIGHT reputable orgs: filter to Image and it queries
 * black-forest-labs and stabilityai, not the LLM labs. No filter → the default
 * cross-domain top set.
 */
const CAP_TO_DOMAIN: Record<string, PublisherDomain> = {
  reasoning: 'text',
  vision: 'text',
  'text-generation': 'text',
  embeddings: 'embeddings',
  audio: 'audio',
  'image-generation': 'image',
  'video-generation': 'video',
  '3d-generation': '3d',
};

function recommendedAuthors(capabilities: readonly string[]): string[] {
  if (capabilities.length === 0) return [...DEFAULT_RECOMMENDED_AUTHORS];
  const domains = [...new Set(capabilities.map((c) => CAP_TO_DOMAIN[c]).filter(Boolean))];
  return reliableAuthorsForDomains(domains as PublisherDomain[], 16);
}

/**
 * The compact table's column template, keyed by which optional columns are
 * present. Written out rather than composed, because Tailwind only ships the
 * classes it can SEE — a template built by string concatenation compiles to
 * nothing and the table collapses into one column.
 */
const COMPACT_GRID: Record<string, string> = {
  'caps-counts': 'grid-cols-[1fr_110px_80px_100px_80px_92px_36px]',
  'caps-nocounts': 'grid-cols-[1fr_110px_80px_92px_36px]',
  'nocaps-counts': 'grid-cols-[1fr_80px_100px_80px_92px_36px]',
  'nocaps-nocounts': 'grid-cols-[1fr_80px_92px_36px]',
};

export function ModelsView() {
  const catalog = useLlmStore((s) => s.catalog);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  /* The hardware strip reports THIS machine. A hardcoded "24 GiB" would be
     decoration pretending to be information, and every download decision on
     this page is made against these numbers. */
  const [hw, setHw] = useState<{ ramGiB: number; cpus: number } | null>(null);
  /*
   * ONE FILTER SET PER KIND, both remembered.
   *
   * the user: "searching for datasets seeming to not work because filters for gguf
   * vision etc persist and obviously those files don't exist in datasets, save
   * those for when the user swaps back to the models tab, don't reset their
   * filters". So the two live side by side and the switch swaps which one is
   * active — nothing is reset behind the user's back, and nothing leaks across.
   */
  const [modelFilters, setModelFilters] = useState<HubFilters>(DEFAULT_FILTERS);
  const [datasetFilters, setDatasetFilters] = useState<HubFilters>(DEFAULT_DATASET_FILTERS);
  const [view, setView] = useState<ViewMode>('compact');
  const [tab, setTab] = useState<'discover' | 'device'>('discover');
  const [selected, setSelected] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * THE LIVE DOWNLOAD, from the store rather than from here.
   *
   * The supervisor runs ONE download at a time — `llm:pause-download` and
   * `llm:cancel-download` take no id precisely because there is nothing to
   * disambiguate — so the single global progress record belongs to whichever
   * row started it, and that row is `busyId`. Reading it per-row instead would
   * be inventing a distinction the engine does not make.
   */
  const progress = useLlmStore((s) => s.download);
  const cancelDownload = useLlmStore((s) => s.cancelDownload);
  /*
   * THE STORE — everything that is not one GGUF out of a ladder.
   *
   * the user: "we need to be able to download anything and store it properly in an
   * organized format… (eg say we add a video/image studio.)" So an image, video,
   * audio or 3D pick is a real download now, into `<cache>/store/<kind>/<slug>/`
   * with a manifest beside the weights, rather than a card explaining that the
   * app cannot fetch it.
   */
  const hardware = useLlmStore((s) => s.hardware);
  const storeModels = useStoreModels((s) => s.models);
  const storeProgress = useStoreModels((s) => s.progress);
  const storeDownload = useStoreModels((s) => s.download);
  const storeCancel = useStoreModels((s) => s.cancel);
  const refreshStore = useStoreModels((s) => s.refresh);
  useEffect(() => {
    void refreshStore();
  }, [refreshStore]);
  const [hits, setHits] = useState<HfModelHitDTO[]>([]);
  /* Datasets are the reference's sibling page. Same chrome, different corpus —
     so they live here behind a kind switch rather than in a second view that
     would duplicate the header, search and filter row. */
  const [kind, setKind] = useState<'models' | 'datasets'>('models');
  const [datasets, setDatasets] = useState<DatasetHitDTO[]>([]);
  const [dsLoading, setDsLoading] = useState(false);
  const filters = kind === 'datasets' ? datasetFilters : modelFilters;
  const setFilters = (next: HubFilters | ((f: HubFilters) => HubFilters)) => {
    const apply = (f: HubFilters) => (typeof next === 'function' ? next(f) : next);
    if (kind === 'datasets') setDatasetFilters(apply);
    else setModelFilters(apply);
  };
  /*
   * Which quantity the size cap is measuring. Datasets and on-disk files have
   * real bytes; a Discover repo has only a parameter count (see the note at the
   * control). The label and the aria-label both follow this so the slider never
   * shows a number without its unit.
   */
  const sizeUnit: 'gb' | 'params' = kind === 'datasets' || tab === 'device' ? 'gb' : 'params';

  const resetFilters = () =>
    kind === 'datasets'
      ? setDatasetFilters(DEFAULT_DATASET_FILTERS)
      : setModelFilters(DEFAULT_FILTERS);
  const isFiltered =
    (filters.outputs ?? []).length > 0 ||
    filters.capabilities.length > 0 ||
    filters.onlyFits ||
    filters.maxSize !== undefined ||
    (filters.scope ?? 'recommended') !== 'recommended' ||
    filters.format !== (kind === 'datasets' ? DEFAULT_DATASET_FILTERS : DEFAULT_FILTERS).format;

  const hfToken = useHfToken();
  const [tokenDraft, setTokenDraft] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [card, setCard] = useState<{
    repo: string;
    markdown?: string;
    error?: string;
    /** Explicit, so the pane never spins by default — see the fetch effect. */
    loading?: boolean;
  } | null>(null);
  /* The quant ladder for the selected model. HF entries need a file listing;
     local catalog entries already carry theirs. */
  const [quants, setQuants] = useState<{
    repo: string;
    options: QuantOption[];
    /* The RAW file objects, kept because registering an HF model needs the file
       itself (path/sha/size), not the display label we ranked it by. Dropping
       them is what made every Discover download fail with "unknown model". */
    files: HfGgufFileDTO[];
    mmproj?: HfGgufFileDTO;
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
          /* Only force the server-side gguf filter when we actually want text
             models. A generation modality (image/video/audio/3D) is not gguf, so
             asking for gguf there returns nothing — see NON_GGUF_CAPABILITIES. */
          ggufOnly: filters.format === 'gguf' && !wantsNonGguf(filters.capabilities),
          /*
           * RECOMMENDED IS A QUERY, NOT A FILTER.
           *
           * Asking for reputable orgs by filtering the reply in the renderer
           * left ONE row out of forty on "Newest", because HF's newest page is
           * almost entirely individual re-uploads — a client-side filter can
           * only ever subtract from a page the API already chose. Sending the
           * allowlist makes the API return those repos in the first place (one
           * request per author; see hf-search.ts).
           */
          ...((filters.scope ?? 'recommended') === 'recommended'
            ? { authors: recommendedAuthors(filters.capabilities) }
            : {}),
          // Gated repos and higher rate limits both need the token.
          ...(hfToken.length > 0 ? { hfToken } : {}),
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
  }, [tab, filters.query, filters.sort, filters.scope, filters.capabilities, hfToken]);

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
        // A dataset's storage IS what you download, so bytes is its real size.
        bytes: d.bytes,
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

  /*
   * RECOMMENDED IS A CURATED LIST, not a filtered search.
   *
   * the user: "the newest is just clogged immediately with 10 bartowski ornith 1.5
   * quants from the different model sizes… we need to have reccomended section
   * and then have that by default that has good organization and such… but we
   * let people do from hf and deal with the messy default search if they want."
   *
   * So Discover has two genuinely different sources under one toggle: a
   * hand-picked, family-grouped list (recommended-catalog.ts) and the raw Hub.
   * Filtering the Hub harder could never have produced the first one — every one
   * of those ten quant repos passes a reputable-publisher test.
   */
  const curated =
    kind === 'models' && tab === 'discover' && (filters.scope ?? 'recommended') === 'recommended';
  const families = useMemo(
    () => (curated ? recommendedFamilies(filters.outputs ?? []) : []),
    [curated, filters.outputs],
  );
  /** repo → its family and variant, for turning a click into a detail pane. */
  const curatedIndex = useMemo(() => {
    const map = new Map<string, { family: RecommendedFamily; variant: RecommendedVariant }>();
    for (const family of RECOMMENDED_FAMILIES) {
      for (const variant of family.variants) map.set(variant.repo, { family, variant });
    }
    return map;
  }, []);
  /* What is on disk, by REPO — the curated list names repos, while the local
     catalog is keyed by its own ids and carries the repo alongside. */
  const downloadedRepos = useMemo(() => {
    const set = new Set<string>();
    for (const e of catalog) {
      if (e.downloaded !== true) continue;
      if (e.hfRepo !== undefined) set.add(e.hfRepo);
      set.add(e.id);
    }
    // …and everything the store holds, which is where every non-GGUF model now
    // lands. Without this half the curated list would report "not downloaded"
    // about weights sitting on the disk.
    for (const m of storeModels) {
      if (m.incomplete === true) continue;
      set.add(m.repo);
    }
    return set;
  }, [catalog, storeModels]);
  /* From the FILTERED rows, not the whole source: showing four trending cards
     above an "Nothing matches these filters" table made the page argue with
     itself. */
  const trending = useMemo(() => sortModels(rows, 'trending').slice(0, 4), [rows]);
  /*
   * The detail pane works off a `HubModel`, and a curated pick is not in `rows`
   * — the curated list is a different source. Rather than special-casing every
   * consumer (quant ladder, model card, download), the catalogue entry is turned
   * INTO a HubModel here, keyed on the repo. Everything downstream then behaves
   * exactly as it does for a Hub search result, because for those purposes it is
   * one: same repo id, same file listing, same README.
   */
  const curatedPick = selected === null ? undefined : curatedIndex.get(selected);
  const detail: HubModel | undefined =
    curated && curatedPick !== undefined
      ? {
          id: curatedPick.variant.repo,
          name: `${curatedPick.family.name} ${curatedPick.variant.label}`,
          org: curatedPick.variant.repo.split('/')[0] ?? curatedPick.family.org,
          params:
            curatedPick.variant.paramsB === undefined
              ? undefined
              : `${Number(curatedPick.variant.paramsB.toFixed(1))}B`,
          paramsB: curatedPick.variant.paramsB,
          formats: [],
          capabilities: [],
          downloaded: downloadedRepos.has(curatedPick.variant.repo),
        }
      : (rows.find((m) => m.id === selected) ?? (curated ? undefined : rows[0]));

  /*
   * THE MODEL CARD. The reference gives most of its detail pane to the rendered
   * README; ours was mostly empty space. Keyed on the repo so switching rows
   * swaps the card, and main caches so going back and forth is instant.
   */
  /*
   * ERRORS MUST EXPIRE. the user: "there's also this hanging unknown model text that
   * I don't know what prompted it but it isn't going away no matter what
   * either." A download failure set `error` and nothing ever unset it, so a
   * stale message about one model followed you across tabs, kinds and searches.
   * It clears whenever the thing it referred to stops being what you are
   * looking at.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally clears on these changes
  useEffect(() => {
    setError(null);
    setNeedsToken(false);
  }, [kind, tab, filters.query]);

  const detailRepo = detail?.id;

  /*
   * THE QUANT LADDER. `hf:list-files` returns every .gguf in the repo with its
   * size, which is what the picker ranks; a local catalog entry already has its
   * own list, so that path costs no request. Vision projectors are pulled out
   * rather than offered as a choice — you never download an mmproj INSTEAD of
   * the weights, it loads alongside them, and its bytes belong in the fit maths.
   */
  useEffect(() => {
    /*
     * DATASETS HAVE NO QUANT LADDER, and asking anyway is not harmless.
     *
     * `detail` falls back to `rows[0]`, so the first row is an implicit detail
     * even with nothing selected. On the Datasets tab that sent a dataset id to
     * `hf:list-files`, which asks `/api/models/<id>/tree/main` — a path that
     * does not exist for a dataset, so HF answers 401 (measured), the 401
     * branch below reads that as gated, and the hub told the user "This repo is
     * gated or private. Paste a Hugging Face token" about a public dataset it
     * had just listed. A wrong question producing a confident wrong answer.
     */
    if (kind !== 'models') {
      setQuants(null);
      return;
    }
    if (detailRepo === undefined) {
      setQuants(null);
      return;
    }
    const local = catalog.find((e) => e.id === detailRepo);
    if (local !== undefined) {
      setQuants({
        repo: detailRepo,
        options: local.quants.filter((q) => q.bytes > 0),
        files: [],
        loading: false,
      });
      return;
    }
    if (!detailRepo.includes('/')) {
      setQuants({ repo: detailRepo, options: [], files: [], loading: false });
      return;
    }
    let cancelled = false;
    setQuants({ repo: detailRepo, options: [], files: [], loading: true });
    void window.piDesktop
      .invoke('hf:list-files', {
        repoId: detailRepo,
        ...(hfToken.length > 0 ? { hfToken } : {}),
      })
      .then((res) => {
        if (cancelled) return;
        /*
         * A 401 here is not a failure to explain away — it means the repo is
         * gated or private and we have no token. Say that, and offer the fix
         * inline, rather than printing "HTTP 401" and leaving the user to guess.
         */
        if (res.error !== undefined && /401|403|gated/i.test(res.error)) {
          setNeedsToken(true);
        }
        const files = res.files ?? [];
        const mmproj = files.find((f) => f.mmproj === true);
        setQuants({
          repo: detailRepo,
          files,
          mmproj,
          options: files
            .filter((f) => f.mmproj !== true && (f.sizeBytes ?? 0) > 0)
            .map((f) => ({
              quant: quantLabel(f.quant, f.path),
              bytes: f.sizeBytes ?? 0,
            })),
          mmprojBytes: mmproj?.sizeBytes,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setQuants({ repo: detailRepo, options: [], files: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [detailRepo, catalog, hfToken, kind]);
  /*
   * WHICH REPO'S CARD TO FETCH.
   *
   * A Discover row's id IS the HF repo id. A LOCAL catalog entry's is not —
   * it is a short slug like `qwen3.5-4b` with no slash — but the entry records
   * the repo it came from in `hfRepo`, so its card is perfectly fetchable.
   */
  const cardRepo = useMemo(() => {
    if (detailRepo === undefined) return undefined;
    if (detailRepo.includes('/')) return detailRepo;
    return catalog.find((e) => e.id === detailRepo)?.hfRepo;
  }, [detailRepo, catalog]);

  useEffect(() => {
    if (detailRepo === undefined) {
      setCard(null);
      return;
    }
    if (cardRepo === undefined) {
      /*
       * THE PERMANENT SPINNER. the user: "why is this 'loading model card' sometimes
       * there and taking forever/not happening at all."
       *
       * This branch used to `setCard(null)` and return — and the pane reads a
       * null card as "still loading", so every model without a slash in its id
       * (i.e. every ON-DEVICE model) sat on "Loading model card…" for as long as
       * you left it open. Not slow: never resolving, because nothing was ever
       * started. A state with no terminal value is the bug; saying so plainly is
       * the fix.
       */
      setCard({ repo: detailRepo, error: 'No card recorded for this local model.' });
      return;
    }
    let cancelled = false;
    setCard({ repo: detailRepo, loading: true });
    /*
     * AND A DEADLINE. Every branch above now ends somewhere, but "the spinner
     * spins until something calls setCard" is only as good as every future
     * caller. MEASURED across 8 repos here: 100-400ms, so 15s means something is
     * genuinely wrong — an unsettled IPC, main wedged behind a download — and
     * the pane should say so rather than pretend to still be working.
     */
    const deadline = setTimeout(() => {
      if (!cancelled) {
        setCard({ repo: detailRepo, error: 'The model card took too long to load.' });
      }
    }, 15_000);
    void window.piDesktop
      /* `kind` is not optional in practice: a dataset's README lives under
         huggingface.co/datasets/<id>, and the model path answers 401 for it —
         which the hub used to render as "gated", about a public dataset. */
      .invoke('modelcard:fetch', {
        repoId: cardRepo,
        kind: kind === 'datasets' ? 'dataset' : 'model',
      })
      .then((res) => {
        clearTimeout(deadline);
        if (!cancelled) setCard({ repo: detailRepo, ...res });
      })
      .catch(() => {
        clearTimeout(deadline);
        if (!cancelled)
          setCard({
            repo: detailRepo,
            error: `could not load the ${kind === 'datasets' ? 'dataset' : 'model'} card`,
          });
      });
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [detailRepo, cardRepo, kind]);
  const localCount = all.filter((m) => m.downloaded === true).length;

  /* The hub's whole purpose. This was a <span> with no handler, in a pane the
     default view never rendered — so the page could not download a model. */
  const openOnHf = (id: string) => {
    // Datasets live in their own namespace on the Hub — huggingface.co/<id>
    // for a dataset id is a 404 in the user's browser.
    const path = kind === 'datasets' ? `datasets/${id}` : id;
    void window.piDesktop
      .invoke('canvas:open-external', { url: `https://huggingface.co/${path}` })
      .catch(() => undefined);
  };
  const copyId = (id: string) => void navigator.clipboard?.writeText(id);

  /*
   * WHAT THE ROW'S PRIMARY BUTTON DOES.
   *
   * "Get" ran the model download path for datasets too, which looks for a GGUF
   * ladder that does not exist and ended at "Could not resolve a file to
   * download for this model." — about a dataset. Local dataset download is its
   * own piece of work (fetching a repo, not a single weights file); until it
   * exists the button offers the Hub page, which is a real destination.
   */
  const rowAction = (mdl: HubModel) => {
    if (kind === 'datasets') {
      openOnHf(mdl.id);
      return;
    }
    if (mdl.downloaded !== true) void download(mdl.id);
  };

  /*
   * DOWNLOADING AN HF MODEL IS A TWO-STEP. `llm:download-model` takes a CATALOG
   * id; an HF repo id is not one, so passing it straight through failed with
   * "unknown model: unsloth/Qwen3.8-27B-GGUF" — every Discover download did.
   * `hf:register` adapts the hit + the chosen file into a catalog entry and
   * hands back the real id, which is what the existing Browse-HF flow does; we
   * reuse that store rather than reimplementing the adaptation.
   */
  const download = async (id: string, quant?: string) => {
    setBusyId(id);
    setError(null);
    try {
      const local = catalog.find((e) => e.id === id);
      if (local !== undefined) {
        const res = await window.piDesktop.invoke(
          'llm:download-model',
          quant === undefined ? { modelId: id } : { modelId: id, quant },
        );
        // A cancel comes back as `success: false`. Reading that as a failure
        // put "the download could not start" on screen every time someone
        // pressed the X — the one outcome they had just asked for.
        if (res.success !== true && res.cancelled !== true && res.paused !== true) {
          setError(res.error ?? 'the download could not start');
        }
      } else {
        /*
         * A CURATED PICK IS NOT IN THE SEARCH RESULTS, and used to fail here.
         *
         * This path resolved the repo by looking it up in `hits` — the current
         * Hugging Face search — which is exactly what a hand-picked list is not
         * in. Every Download on the Recommended tab ended at "Could not resolve
         * a file to download for this model." The registration only needs the
         * repo's identity, so a curated entry supplies its own: same shape, from
         * the catalogue instead of from a search we did not run.
         */
        const curatedHit = curatedIndex.get(id);
        const hit =
          hits.find((h) => h.id === id) ??
          (curatedHit === undefined
            ? undefined
            : {
                id,
                author: id.split('/')[0] ?? curatedHit.family.org,
                name: id.split('/')[1] ?? curatedHit.family.name,
                downloads: 0,
                likes: 0,
                tags: [],
                gated: false,
              });
        const files = quants?.repo === id ? quants.files : [];
        // Match on the label the picker showed, then fall back to the ladder's
        // best — a user who never opened the picker still gets a sane file.
        const file =
          files.find((f) => quantLabel(f.quant, f.path) === quant) ??
          files.find((f) => f.mmproj !== true && (f.sizeBytes ?? 0) > 0);
        if (hit === undefined || file === undefined) {
          // Being specific about WHICH half failed: a repo with no GGUF in it is
          // an image/video/audio model that this downloader cannot install, and
          // saying "could not resolve a file" sends people looking for a bug.
          setError(
            file === undefined && hit !== undefined
              ? `${id} publishes no GGUF weights — it runs on the generation stack, which fetches it on first use.`
              : 'Could not resolve a file to download for this model.',
          );
        } else {
          await useHfStore.getState().addAndDownload(hit, file, {
            mmproj: quants?.mmproj,
            mtpFile: files.find((f) => f.mtp === true),
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the download could not start');
    }
    await refreshCatalog();
    setBusyId(null);
  };

  /*
   * ONE CLICK, TWO DOWNLOADERS, and the variant decides which.
   *
   * A text family is a GGUF out of a ladder and belongs to the inference
   * supervisor, which knows about quants and about the server that will load it.
   * Everything else is a repo — or a RECIPE within one, `allow` naming the
   * transformer, the encoder and the VAE — and goes to the store. Choosing here
   * rather than at the button means the card never has to know the difference.
   */
  const downloadVariant = async (family: RecommendedFamily, variant: RecommendedVariant) => {
    if (installKindOf(family) === 'gguf') {
      setSelected(variant.repo);
      await download(variant.repo);
      return;
    }
    /*
     * A RECIPE CAN SPAN REPOS, and all of it has to arrive or none of it is
     * useful: a quantized LTX transformer without its T5 encoder and VAE is 1.3
     * GB that cannot generate anything. The parts are queued in order behind the
     * primary — the store runs one at a time, so this is a queue rather than a
     * race, and the top-bar bar shows whichever is moving.
     */
    const primary = {
      repo: variant.repo,
      kind: family.output,
      name: `${family.name} ${variant.label}`,
      family: family.id,
      ...(variant.tasks === undefined ? {} : { tasks: variant.tasks }),
      ...(variant.allow === undefined ? {} : { allow: variant.allow }),
      ...(variant.note === undefined ? {} : { notes: variant.note }),
    };
    await storeDownload(primary);
    for (const part of variant.parts ?? []) {
      await storeDownload({
        repo: part.repo,
        kind: family.output,
        name: part.repo.split('/')[1] ?? part.repo,
        family: family.id,
        ...(part.allow === undefined ? {} : { allow: part.allow }),
        notes: `Needed by ${family.name} ${variant.label}`,
      });
    }
  };

  /*
   * "USE" IS A REAL ACTION, not a second way to select a row.
   *
   * the user replaced the on-disk badge with a button that says Use, which means the
   * button IS the state — and a button that only re-selects what clicking the
   * card already selects would make that a lie. So a text model becomes the chat
   * model, and a generation model opens the studio that runs it. Both are the
   * thing someone wanted when they pressed it.
   */
  const useRecommendation = async (rec: ModelRecommendation): Promise<void> => {
    if (rec.family.output === 'text') {
      const entry = catalog.find((e) => e.hfRepo === rec.variant.repo);
      if (entry !== undefined) {
        await activateLocalModel(entry.id, rec.quant?.rung.quant);
        return;
      }
    }
    useModalityStore.getState().setView(rec.family.output === '3d' ? '3d' : 'studio');
  };

  /** Stop whichever downloader is carrying this variant. */
  const cancelVariant = async (family: RecommendedFamily, variant: RecommendedVariant) => {
    if (installKindOf(family) === 'gguf') {
      await cancelHere();
      return;
    }
    // Every part, not just the one that is moving: cancelling a recipe means
    // cancelling the recipe.
    await storeCancel(variant.repo);
    for (const part of variant.parts ?? []) await storeCancel(part.repo);
  };

  /** 0..1 per repo, for the bar on a family row. */
  const storeFractions = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [repo, p] of Object.entries(storeProgress)) out[repo] = p.fraction;
    return out;
  }, [storeProgress]);

  /*
   * Bytes as well as the fraction, because the recommendation cards reveal
   * "1.2 GB / 6.3 GB · 19%" on hover and a fraction alone cannot say that.
   * The GGUF path folds in here too — the user does not know there are two
   * downloaders, so a text recommendation must show a bar like any other.
   */
  const storeProgressByRepo = useMemo(() => {
    const out: Record<string, { received: number; total: number; fraction: number }> = {};
    for (const [repo, p] of Object.entries(storeProgress)) {
      out[repo] = { received: p.received, total: p.total, fraction: p.fraction };
    }
    if (progress !== null && busyId !== null) {
      const total = progress.jobTotal ?? progress.total ?? 0;
      const received = progress.jobReceived ?? progress.received;
      out[busyId] = { received, total, fraction: downloadFraction(progress) ?? 0 };
    }
    return out;
  }, [storeProgress, progress, busyId]);

  /*
   * CANCEL, ACKNOWLEDGED FIRST. the user: "immediate feedback even if download
   * doesn't cancel immediately it shows up that way". Clearing `busyId` here
   * restores the Download button on the same frame as the click; the store
   * clears the progress record the same way, and the supervisor discards the
   * `.part` files on its own cancel path. The in-flight `download()` above then
   * returns `{cancelled: true}`, which is why it must not be read as a failure.
   */
  const cancelHere = async () => {
    setBusyId(null);
    setError(null);
    await cancelDownload();
  };
  /* Does THIS source carry popularity data? The bundled catalog does not; the
     HF browse path does. Drives whether those columns exist at all. */
  /* Describes the SOURCE ON SCREEN. Reading `all` (the local catalog) meant the
     columns stayed hidden even on Discover, where every row has real counts. */
  const hasCounts = scoped.some((m) => m.downloads !== undefined || m.likes !== undefined);
  /* Same rule the counts columns follow: a column of em-dashes reads as data
     that failed to load rather than a property this source does not have. On
     the Datasets tab nothing has capabilities, so the column was 110px of
     dashes. Data-driven rather than `kind === 'datasets'`, so it comes back on
     its own if HF ever gives datasets modality tags. */
  const hasCaps = scoped.some((m) => m.capabilities.length > 0);

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
  /*
   * ALWAYS the full modality set, not just the capabilities present in the
   * current results. Deriving these from what is loaded made a chicken-and-egg
   * trap: the default view is text/gguf, so "Image" / "Video" / "Audio" never
   * appeared — and picking one is the only way to LOAD those models. The filter
   * exists to switch modality, so it must offer modalities you cannot yet see.
   */
  const capabilityOptions = CAPABILITY_OPTIONS;

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="models-view">
      {/* No traffic-light strip: the hub renders INSIDE the chat shell now, which
          already owns the drag region and the top bar. A second one here left a
          dead 44px band and a back button under the real title. */}
      {/* Header + hardware strip */}
      <div className="flex shrink-0 items-start justify-between gap-6 px-6 pt-3 pb-3">
        <div>
          {/* No "Back to chat": the sidebar is always present now and its New
              chat row sits inches away — the user: "don't put a back to chat button
              it's right next to the 'new chat' button anyways." */}
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
          placeholder={kind === 'datasets' ? 'Search datasets' : 'Search all models'}
          className="min-w-0 flex-1 rounded-full border border-border-subtle bg-bg-raised px-4 py-2 text-body text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-text-muted pd-focusable"
        />
      </div>

      {/* Filter row */}
      <div className="flex shrink-0 items-center gap-2 px-6 pb-4">
        {/* A quant format is a model property; datasets have none, so offering
            the control there is offering a dead end. */}
        {kind === 'models' ? (
          <Dropdown
            testid="filter-format"
            value={filters.format}
            options={formatOptions}
            onChange={(format) => setFilters((f) => ({ ...f, format }))}
          />
        ) : null}
        {kind === 'models' ? (
          <CapabilityFilter
            selected={filters.capabilities}
            options={capabilityOptions}
            onChange={(capabilities) => setFilters((f) => ({ ...f, capabilities }))}
          />
        ) : null}
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
        {/*
         * RECOMMENDED / ALL. the user: "by default, the 'newest' will show just a
         * bunch of random models, so if you could just have reputable
         * organizations shown, for example a 'reccomended/all' toggle".
         *
         * A two-state pill rather than another dropdown: it has two values, it
         * is the single biggest lever over what the list contains, and it should
         * be visible without opening anything.
         */}
        <div className="flex rounded-full bg-bg-inset p-0.5" data-testid="hub-scope">
          {(['recommended', 'all'] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`hub-scope-${v}`}
              aria-pressed={(filters.scope ?? 'recommended') === v}
              onClick={() => setFilters((f) => ({ ...f, scope: v }))}
              className={cx(
                'rounded-full px-3 py-1 text-footnote transition-colors',
                (filters.scope ?? 'recommended') === v
                  ? 'bg-bg-raised text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {v === 'recommended' ? 'Recommended' : 'All'}
            </button>
          ))}
        </div>

        {/*
         * OUTPUT — what a model MAKES. the user: "everything filterable by output
         * also".
         *
         * Pills rather than another dropdown, because this is the axis people
         * arrive with ("I want to make a video") and there are only five of
         * them: a menu would hide a five-item choice behind a click. Multi-select
         * with none-means-all, the same grammar as the capability filter.
         */}
        <div className="flex items-center gap-1" data-testid="filter-output">
          {(['text', 'image', 'video', 'audio', '3d'] as const).map((o) => {
            const on = (filters.outputs ?? []).includes(o);
            return (
              <button
                key={o}
                type="button"
                data-testid={`filter-output-${o}`}
                aria-pressed={on}
                onClick={() =>
                  setFilters((f) => {
                    const cur = f.outputs ?? [];
                    return {
                      ...f,
                      outputs: cur.includes(o)
                        ? cur.filter((x) => x !== o)
                        : ([...cur, o] as readonly OutputModality[]),
                    };
                  })
                }
                className={cx(
                  'rounded-full border px-3 py-1.5 text-footnote transition-colors pd-focusable',
                  on
                    ? 'border-transparent bg-accent-primary text-text-on-accent'
                    : 'border-border-subtle bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                {OUTPUT_LABEL[o]}
              </button>
            );
          })}
        </div>

        {/*
         * SIZE CAP. A maximum rather than a range: the question a hub gets asked
         * is "what fits", never "what is at least this big".
         *
         * The UNIT follows the rows, and the label says which. Datasets and
         * on-disk files have real bytes; a Discover repo only has a parameter
         * count, because its storage is every quant it publishes summed
         * together. Capping repo bytes would hide a 27B repo that holds a
         * perfectly good 8GB Q4 — so the axis there is B of parameters.
         */}
        <label
          className="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-raised px-3.5 py-1.5 text-footnote text-text-secondary shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
          data-testid="filter-size"
        >
          <span className="whitespace-nowrap">
            {filters.maxSize === undefined
              ? 'Any size'
              : `≤ ${filters.maxSize}${sizeUnit === 'gb' ? ' GB' : 'B params'}`}
          </span>
          <input
            type="range"
            min={1}
            max={SIZE_CAP_MAX}
            step={1}
            aria-label={sizeUnit === 'gb' ? 'Maximum size in GB' : 'Maximum parameters in B'}
            value={filters.maxSize ?? SIZE_CAP_MAX}
            onChange={(e) => {
              const v = Number(e.target.value);
              // The top of the range means "no cap", so the slider can be
              // dismissed without a second control.
              setFilters((f) => ({ ...f, maxSize: v >= SIZE_CAP_MAX ? undefined : v }));
            }}
            className="h-1 w-24 cursor-pointer accent-[var(--pd-accent-primary)]"
          />
        </label>

        {isFiltered ? (
          <button
            type="button"
            data-testid="filters-reset"
            onClick={resetFilters}
            className="rounded-full border border-border-subtle bg-bg-raised px-3 py-1.5 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
          >
            Reset
          </button>
        ) : null}
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

      {needsToken ? (
        <div
          className="mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-default bg-bg-inset px-3 py-2"
          data-testid="hf-token-row"
        >
          <span className="text-footnote text-text-secondary">
            This repo is gated or private. Paste a Hugging Face token to see its files.
          </span>
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="hf_…"
            autoComplete="off"
            spellCheck={false}
            data-testid="hf-token-input"
            className="min-w-[180px] flex-1 rounded-md border border-border-default bg-bg-base px-2 py-1 text-footnote text-text-primary placeholder:text-text-muted pd-focusable"
          />
          <button
            type="button"
            data-testid="hf-token-save"
            disabled={tokenDraft.trim().length === 0}
            onClick={() => {
              void setHfToken(tokenDraft.trim());
              setTokenDraft('');
              setNeedsToken(false);
            }}
            className={cx(
              'rounded-md px-2.5 py-1 text-footnote',
              tokenDraft.trim().length === 0
                ? 'bg-bg-active text-text-muted'
                : 'bg-accent-primary text-text-on-accent hover:opacity-90',
            )}
          >
            Save
          </button>
        </div>
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
              {!curated &&
              kind === 'models' &&
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
                        className="cursor-pointer rounded-2xl border border-border-subtle bg-bg-raised p-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all hover:border-border-default hover:bg-bg-hover hover:shadow-[0_2px_8px_rgba(0,0,0,0.07)] pd-focusable"
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
                  // The curated list is cards, not a table, so it keeps the
                  // detail pane beside it even in the compact view — otherwise
                  // clicking a version would have nowhere to show it.
                  curated
                    ? 'grid-cols-[minmax(0,1fr)_420px]'
                    : view === 'compact'
                      ? ''
                      : view === 'split'
                        ? 'grid-cols-[minmax(0,1fr)_420px]'
                        : 'grid-cols-[300px_minmax(0,1fr)]',
                )}
              >
                <div>
                  {/*
                   * TWO HEADINGS ON THE CURATED TAB, not one. the user: "the little
                   * 'recommended' text shouldn't be there, the 5 cards you show
                   * should say 'Top Recommended' much larger and then 'More'
                   * below."
                   *
                   * The old single "Recommended · 26 families, smallest first"
                   * labelled the whole tab, which left the five picks and the
                   * long browsable list looking like one undifferentiated pile.
                   * They are different offers — here is what to get, and here is
                   * everything else — so each gets its own heading and the
                   * counting furniture goes.
                   */}
                  {!curated ? (
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
                        {`${rows.length} ${kind === 'datasets' ? 'dataset' : 'model'}${rows.length === 1 ? '' : 's'}`}
                      </span>
                    </div>
                  ) : null}

                  {curated ? (
                    <h2
                      className="mb-3 text-title font-medium text-text-primary"
                      data-testid="top-recommended-heading"
                    >
                      Top Recommended
                    </h2>
                  ) : null}

                  {curated ? (
                    <BestForYourMachine
                      hardware={hardware}
                      downloaded={downloadedRepos}
                      onSelect={setSelected}
                      onDownload={(rec) => {
                        setSelected(rec.variant.repo);
                        void downloadVariant(rec.family, rec.variant);
                      }}
                      onUse={(rec) => void useRecommendation(rec)}
                      onCancel={(rec) => void cancelVariant(rec.family, rec.variant)}
                      progress={storeProgressByRepo}
                    />
                  ) : null}
                  {curated ? (
                    /*
                     * The curated list REPLACES the results table here rather
                     * than sitting above it: two lists of models on one screen,
                     * one hand-picked and one not, is exactly the ambiguity the
                     * Recommended/All toggle exists to remove.
                     */
                    <div className="flex flex-col gap-2" data-testid="curated-families">
                      <h2
                        className="mt-4 mb-1 text-title font-medium text-text-primary"
                        data-testid="more-heading"
                      >
                        More
                      </h2>
                      {families.map((family) => (
                        <FamilyCard
                          key={family.id}
                          family={family}
                          downloaded={downloadedRepos}
                          selectedRepo={selected}
                          memoryGB={hw?.ramGiB ?? 0}
                          progress={storeFractions}
                          bytes={storeProgressByRepo}
                          onSelect={setSelected}
                          onDownload={(variant) => void downloadVariant(family, variant)}
                          onCancel={(variant) => void cancelVariant(family, variant)}
                        />
                      ))}
                      {families.length === 0 ? (
                        <p className="py-6 text-body text-text-muted" data-testid="curated-empty">
                          Nothing recommended makes that yet — switch to All to search the Hub.
                        </p>
                      ) : null}
                    </div>
                  ) : view === 'compact' ? (
                    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-raised shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                      {/* Downloads/Likes only exist for HF-sourced entries. A
                          column of em-dashes is worse than no column: it looks
                          like the data failed to load rather than never
                          applying to a bundled catalog. */}
                      <div
                        className={cx(
                          'grid items-center gap-2 border-b border-border-subtle bg-bg-sunken px-4 py-2.5 text-footnote text-text-muted',
                          COMPACT_GRID[
                            `${hasCaps ? 'caps' : 'nocaps'}-${hasCounts ? 'counts' : 'nocounts'}`
                          ],
                        )}
                      >
                        <span>{kind === 'datasets' ? 'Dataset' : 'Model'}</span>
                        {hasCaps ? <span>Capabilities</span> : null}
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
                          /* Clicking anywhere on the row opens the card — the user:
                             "maybe clicking generally on it shows the model
                             cart". In compact there is no pane, so it switches
                             to split, which is where the card lives. */
                          onClick={() => {
                            setSelected(mdl.id);
                            if (view === 'compact') setView('split');
                          }}
                          className={cx(
                            'grid w-full cursor-pointer items-center gap-2 border-b border-border-subtle px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-bg-hover',
                            hasCounts
                              ? 'grid-cols-[1fr_110px_80px_100px_80px_92px_36px]'
                              : 'grid-cols-[1fr_110px_80px_92px_36px]',
                            selected === mdl.id ? 'bg-bg-active' : '',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <OrgAvatar org={mdl.org} size={30} />
                            <span className="min-w-0">
                              <span className="block truncate text-body text-text-primary">
                                {mdl.name}
                              </span>
                              <span className="flex items-center gap-1.5 text-footnote text-text-muted">
                                {mdl.org !== '' ? (
                                  <span className="flex items-center gap-1 truncate">
                                    {mdl.org}
                                    {mdl.verified === true ? (
                                      <span className="text-accent-primary">✓</span>
                                    ) : null}
                                  </span>
                                ) : null}
                                <PipelineBadge tag={mdl.pipelineTag} />
                              </span>
                            </span>
                          </span>
                          {hasCaps ? (
                            <CapabilityPills caps={mdl.capabilities} dense max={4} />
                          ) : null}
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
                          {/* A real, prominent button. the user: "maybe a big blue
                              quick download button on the right". The faint
                              glyph read as decoration. */}
                          {/* biome-ignore lint/a11y/useSemanticElements: nested inside the row <button> — button-in-button is invalid */}
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Download ${mdl.name}`}
                            data-testid={`row-download-${mdl.id}`}
                            aria-disabled={mdl.downloaded === true}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              rowAction(mdl);
                            }}
                            onKeyDown={(ev) => {
                              if (ev.key !== 'Enter' && ev.key !== ' ') return;
                              ev.preventDefault();
                              ev.stopPropagation();
                              rowAction(mdl);
                            }}
                            className={cx(
                              'flex h-7 items-center justify-center gap-1 rounded-lg px-2.5 text-caption font-medium transition-opacity',
                              mdl.downloaded === true
                                ? 'cursor-default bg-bg-active text-text-muted'
                                : busyId === mdl.id
                                  ? 'cursor-default bg-bg-active text-text-muted'
                                  : 'cursor-pointer bg-accent-primary text-text-on-accent hover:opacity-90',
                            )}
                          >
                            {kind === 'datasets' ? (
                              <>
                                <IconExternal size={12} /> Open
                              </>
                            ) : mdl.downloaded === true ? (
                              <>
                                <IconCheck size={12} /> On disk
                              </>
                            ) : busyId === mdl.id ? (
                              'Starting…'
                            ) : (
                              // the user: "the quick 'Get' buttons with the down arrow
                              // should just be replaced with a no arrow 'Download'
                              // button."
                              'Download'
                            )}
                          </span>
                          <RowMenu
                            model={mdl}
                            kind={kind}
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
                              'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
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

                {curated && detail === undefined ? (
                  /* The pane is pinned and empty until something is picked;
                     saying so beats a 420px hole beside the list. */
                  <aside
                    className="sticky top-0 self-start rounded-2xl border border-border-subtle border-dashed p-5 text-footnote text-text-muted"
                    data-testid="curated-detail-hint"
                  >
                    Open a family and pick a version to see its card, its quant ladder and what it
                    needs.
                  </aside>
                ) : null}
                {(curated || view !== 'compact') && detail !== undefined ? (
                  /*
                   * PINNED. the user: "the right item showing the model card needs
                   * to be pinned and not lost as we scroll down otherwise we
                   * scroll down through the list find something we like, click
                   * it and nothing appears on the right."
                   *
                   * It already had its own max-height and inner scroll, but it
                   * sat in normal flow — so a list long enough to scroll carried
                   * the pane off the top of the window with it, and by the time
                   * you had scrolled to something worth clicking, the place its
                   * details appear was somewhere above the viewport. `sticky`
                   * with `self-start` is the whole fix: self-start stops the
                   * grid stretching it to the row's full height, which is what
                   * would otherwise leave it nothing to stick within.
                   */
                  <aside
                    className={cx(
                      'sticky top-0 self-start overflow-y-auto rounded-2xl border border-border-subtle bg-bg-raised p-5 shadow-[0_1px_3px_rgba(0,0,0,0.05)]',
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
                        <p className="flex flex-wrap items-center gap-1.5 text-footnote text-text-muted">
                          <span className="flex items-center gap-1">
                            {detail.org}
                            {detail.verified === true ? (
                              <span className="text-accent-primary">✓</span>
                            ) : null}
                          </span>
                          <PipelineBadge tag={detail.pipelineTag} />
                        </p>
                      </div>
                    </div>

                    {detail.capabilities.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <CapabilityPills caps={detail.capabilities} />
                      </div>
                    ) : null}

                    {kind === 'datasets' ? (
                      /* No quant ladder exists for a dataset, and the picker's
                         loading state never resolves without one — it would sit
                         on "Loading files…" for as long as the pane is open. */
                      <button
                        type="button"
                        data-testid="dataset-open"
                        onClick={() => openOnHf(detail.id)}
                        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent-primary px-3 py-2.5 text-footnote text-text-on-accent transition-opacity hover:opacity-90 pd-focusable"
                      >
                        <IconExternal size={14} /> Open on Hugging Face
                      </button>
                    ) : curatedPick !== undefined && installKindOf(curatedPick.family) === 'gen' ? (
                      /*
                       * A GENERATION MODEL DOWNLOADS FOR REAL, into the store.
                       * What it does NOT get is the quant ladder below: there is
                       * no ladder to pick from, because the choice was already
                       * made in the family card — which transformer, which
                       * precision, which job — and travels here as the recipe
                       * this variant names.
                       */
                      <>
                        <DownloadAction
                          installed={hasRepo(storeModels, detail.id)}
                          busy={storeProgress[detail.id] !== undefined}
                          fraction={storeProgress[detail.id]?.fraction ?? null}
                          received={storeProgress[detail.id]?.received}
                          total={storeProgress[detail.id]?.total}
                          onDownload={() =>
                            void downloadVariant(curatedPick.family, curatedPick.variant)
                          }
                          onCancel={() => void storeCancel(detail.id)}
                          testid="detail-download"
                        />
                        {/*
                         * the user: "that line about 'the whole repository in this
                         * apps model store' or something is not needed and
                         * especially not true in this case above." It was both:
                         * noise on every card, and wrong wherever the variant is
                         * a recipe rather than the repo. The size is already on
                         * the row that was clicked; the only thing left worth
                         * saying is when the machine cannot run what it is about
                         * to fetch.
                         */}
                        {fitFor(curatedPick.variant, hw?.ramGiB ?? 0) === 'too-big' ? (
                          <p
                            className="mt-2 text-caption text-status-danger-fg"
                            data-testid="detail-gen-install"
                          >
                            Needs more memory than this Mac has — it will download, but not run
                            here.
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {/* The headline action: one click, the recommended file,
                            no question asked. The ladder below is for the people
                            who want to answer that question anyway. */}
                        <DownloadAction
                          installed={detail.downloaded === true}
                          busy={busyId === detail.id}
                          fraction={progress === null ? null : downloadFraction(progress)}
                          received={progress?.jobReceived ?? progress?.received}
                          total={progress?.jobTotal ?? progress?.total}
                          eta={
                            progress === null ? undefined : formatEta(downloadEtaSeconds(progress))
                          }
                          onDownload={() => void download(detail.id)}
                          onCancel={() => void cancelHere()}
                          testid="detail-download"
                        />
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
                      </>
                    )}

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
                      {/* Spin only while a fetch is EXPLICITLY in flight. The
                          old condition spun whenever the state held neither a
                          body nor an error, so any path that set nothing left it
                          spinning forever. */}
                      {card?.repo !== detail.id || card.loading === true ? (
                        <p className="flex items-center gap-2 text-footnote text-text-muted">
                          <Spinner size={12} /> Loading model card…
                        </p>
                      ) : card.error !== undefined ? (
                        <p className="text-footnote text-text-muted">{card.error}</p>
                      ) : (
                        // Markdown renders its own .pd-prose container; do not
                        // double-wrap it.
                        <ModelCard
                          markdown={card.markdown ?? ''}
                          onOpenLink={(url) =>
                            void window.piDesktop
                              .invoke('canvas:open-external', { url })
                              .catch(() => undefined)
                          }
                        />
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
