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
import { sayIfRaw } from '@pi-desktop/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Glyph,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDownload as IconDownloadShared,
  IconExternal,
  IconLayoutLeft,
  IconLayoutRight,
  IconListCompact,
  IconMore,
  IconRefresh,
  IconSlider,
  ScrollArea,
  Spinner,
  writeClipboardText,
} from '@pi-desktop/ui';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  type HfLadder,
  hfLadder,
  pickHfDownload,
  pickRefusal,
  quantsOnDisk,
  recipeQuant,
} from './hf-download';
import { type LocalUse, pickLocalUse } from './local-use';
import { ModelCard } from './ModelCard';
import { CapabilityPills } from './model-pills';
import { hostFor, type ModelRecommendation, recommendFor } from './model-recommender';
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
import { StorageView } from './StorageView';
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
    downloadedQuants: e.downloadedQuants,
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
 * One repo's `hf:list-files`, read once and shared by everything on the page that
 * asks which file of that repo to fetch (see `listingFor`).
 */
interface RepoListing {
  readonly repo: string;
  /* The RAW file objects, kept because registering an HF model needs the file
     itself (path/sha/size), not the display label we ranked it by. Dropping
     them is what made every Discover download fail with "unknown model". */
  readonly files: readonly HfGgufFileDTO[];
  /** The rows the picker ranks — hf-download.ts owns what is and is not one. */
  readonly ladder: HfLadder;
  /** Why the listing is empty, when it failed. */
  readonly error?: string;
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

/**
 * The pinned panel's height.
 *
 * A HEIGHT, not a max-height: the dividing border has to run the whole column
 * whether the card is two lines or two thousand, and a max-height stops it
 * wherever the content happens to end. The subtrahend is the chrome above the
 * scroll area (title block, tabs, filter row) plus its bottom padding.
 */
const DETAIL_HEIGHT = 'h-[calc(100vh-236px)]';

/**
 * Does the model's own name already state its parameter count?
 *
 * Most do — "Qwen3.5 9B · MLX" — and appending "· 9B" to the line underneath
 * says the same number twice within 40px.
 */
const NAME_SAYS_SIZE = /\d+(?:\.\d+)?\s*[BM]\b/i;

/**
 * The download count's glyph: the shared tray-and-arrow (Hugeicons), not a bare
 * arrow. the user: "the down arrow feels out of place, maybe better with the bottom
 * half of a square's edge line below the down arrow and being slightly
 * thicker." So it keeps one step more weight than the 1px set beside a number.
 */
function IconDownload({ size = 13 }: { size?: number }) {
  return <IconDownloadShared size={size} style={{ '--pd-icon-stroke': 1.25 } as CSSProperties} />;
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
   * FREE DISK, beside the RAM and the cores. the user: "show available storage
   * space in the top right as well as the other specs" — a download is decided
   * against this number as much as against memory. Re-read whenever this page
   * regains the eye (a tab switch, a finished download) rather than polled.
   */
  const [disk, setDisk] = useState<{ free: number; total: number } | null>(null);
  const refreshDisk = useCallback(() => {
    void window.piDesktop
      .invoke('storage:disk', undefined)
      .then((d) => setDisk(d.total > 0 ? { free: d.free, total: d.total } : null))
      .catch(() => {});
  }, []);
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
  const [tab, setTab] = useState<'discover' | 'device' | 'storage'>('discover');
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
  /* The supervisor's refusal for a download this page did not call directly
     (the Discover path goes through the HF store) — a bar that flashed and
     vanished is not a message. */
  const downloadError = useLlmStore((s) => s.downloadError);
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
  /*
   * THE MACHINE THE HUB RECOMMENDS FOR — one value, handed to Top Recommended,
   * to every family's Quick Download and to the text pick whose listing is read
   * up front, so no two of them judge against different budgets. Quick
   * Download used to take total RAM (24 GB where Top Recommended took 18) and
   * fetched bigger variants than the top of the page picks.
   */
  const host = useMemo(() => (hardware === null ? null : hostFor(hardware)), [hardware]);
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
  /** The refinements behind Filters that are set — the count on its button. */
  const refinements =
    (filters.format !== (kind === 'datasets' ? DEFAULT_DATASET_FILTERS : DEFAULT_FILTERS).format
      ? 1
      : 0) +
    (filters.capabilities.length > 0 ? 1 : 0) +
    (filters.onlyFits ? 1 : 0) +
    (filters.maxSize !== undefined ? 1 : 0);
  /* The machine's specs and the power filters are folded away until asked for. */
  const [macOpen, setMacOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  /*
   * EVERY HUGGING FACE LISTING THIS PAGE HAS READ, by repo.
   *
   * ONE LISTING, READ BY EVERYONE WHO ASKS. The picker's ladder lived in state
   * that followed the selection, and the Download buttons read it out of
   * whichever render made them — so Top Recommended and Quick Download, which
   * select a repo and download it in the same click, read the PREVIOUS
   * selection's ladder. On a fresh hub that is none at all, and the 27B came
   * back as "unsloth/Qwen3.8-27B-GGUF publishes no GGUF weights" about a repo
   * that publishes thirty files. A download now asks for the listing of the
   * repo it is downloading, and the picker draws the very same object.
   */
  const [listings, setListings] = useState<Readonly<Record<string, RepoListing>>>({});
  const reads = useRef(new Map<string, Promise<RepoListing>>());
  /* A token changes what a gated repo lists; answers read without it are dropped. */
  const readsFor = useRef(hfToken);
  const listingFor = useCallback(
    (repo: string): Promise<RepoListing> => {
      if (readsFor.current !== hfToken) {
        readsFor.current = hfToken;
        reads.current.clear();
        setListings({});
      }
      const reading = reads.current.get(repo);
      if (reading !== undefined) return reading;
      const read = window.piDesktop
        .invoke('hf:list-files', {
          repoId: repo,
          ...(hfToken.length > 0 ? { hfToken } : {}),
        })
        .then(
          (res): RepoListing => ({
            repo,
            files: res.files ?? [],
            ladder: hfLadder(res.files ?? []),
            ...(res.error === undefined ? {} : { error: res.error }),
          }),
          (): RepoListing => ({
            repo,
            files: [],
            ladder: hfLadder([]),
            error: 'Could not reach Hugging Face.',
          }),
        )
        .then((listing) => {
          // Stale: the token changed while this was in flight.
          if (reads.current.get(repo) !== read) return listing;
          // A failure is shown, not kept — the next ask tries again.
          if (listing.error !== undefined) reads.current.delete(repo);
          setListings((all) => ({ ...all, [repo]: listing }));
          return listing;
        });
      reads.current.set(repo, read);
      return read;
    },
    [hfToken],
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
              ? 'Hugging Face is rate-limiting us. Showing what we have.'
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
  }, [
    tab,
    filters.query,
    filters.sort,
    filters.scope,
    filters.capabilities,
    filters.format,
    hfToken,
  ]);

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
              ? 'Hugging Face is rate-limiting us. Showing what we have.'
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

  // How many store downloads are in flight — changes when one starts or ends,
  // not on every progress tick (statfs on each tick would be silly).
  const storeInFlight = Object.keys(storeProgress).length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: these ARE the triggers — a tab switch, a download starting or ending
  useEffect(() => {
    refreshDisk();
  }, [refreshDisk, tab, busyId, storeInFlight]);

  useEffect(() => {
    void refreshCatalog();
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((i) => setHw({ ramGiB: Math.round(i.totalMemoryBytes / 1024 ** 3), cpus: i.cpuCount }))
      .catch(() => undefined);
  }, [refreshCatalog]);

  const all = useMemo(() => catalog.map((e) => toHubModel(e, hw?.ramGiB ?? 0)), [catalog, hw]);
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
  /*
   * WHICH QUANTS OF A REPO ARE ON DISK, for every card keyed on a repo (a
   * Recommended pick, a Hub search hit) and every Download that fetches from
   * one: the picker's `isDownloaded` and `pickHfDownload`'s. One answer per
   * repo, derived from the catalog (quantsOnDisk), so both read the same one.
   * Its identity holds until the catalog changes, because the picker's
   * recommendation is memoised on it.
   */
  const onDiskFor = useMemo(() => {
    const byRepo = new Map<string, (quant: string) => boolean>();
    return (repo: string) => {
      let isDownloaded = byRepo.get(repo);
      if (isDownloaded === undefined) {
        const held = quantsOnDisk(catalog, repo);
        isDownloaded = (quant: string) => held.has(quant);
        byRepo.set(repo, isDownloaded);
      }
      return isDownloaded;
    };
  }, [catalog]);
  /* Discover = Hugging Face; On Device = what is actually on this disk. They
     are different SOURCES, not two filters over one list. A hit is on disk
     when its REPO is — the catalog ids it was compared with never equal a repo
     id, so no hit ever was, and a hit's card offered its headline Download for
     a model already here, as the curated card (downloadedRepos) does not. */
  const discovered = useMemo(
    () => hits.map((h) => ({ ...hfToHubModel(h), downloaded: downloadedRepos.has(h.id) })),
    [hits, downloadedRepos],
  );
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
   *
   * ONE ROW PER MODEL, NOT PER FILE, and only rows a Download can fetch — the
   * rules live in hf-download.ts (`hfLadder`), because every Download on this
   * page has to resolve its file by the same ones.
   *
   * DERIVED, NOT STORED. An HF ladder is the listing's own object, so a catalog
   * refresh — which every download attempt ends with — no longer hands the
   * picker a fresh array and wipes the quant someone had just picked.
   */
  const localEntry = useMemo(
    () => (detailRepo === undefined ? undefined : catalog.find((e) => e.id === detailRepo)),
    [catalog, detailRepo],
  );
  const localOptions = useMemo(
    () => localEntry?.quants.filter((q) => q.bytes > 0) ?? [],
    [localEntry],
  );
  const listing = detailRepo === undefined ? undefined : listings[detailRepo];
  const quants = useMemo((): {
    repo: string;
    options: readonly QuantOption[];
    mmprojBytes?: number;
    loading: boolean;
  } | null => {
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
    if (kind !== 'models' || detailRepo === undefined) return null;
    if (localEntry !== undefined) {
      return { repo: detailRepo, options: localOptions, loading: false };
    }
    if (!detailRepo.includes('/')) return { repo: detailRepo, options: [], loading: false };
    if (listing === undefined) return { repo: detailRepo, options: [], loading: true };
    return {
      repo: detailRepo,
      options: listing.ladder.options,
      mmprojBytes: listing.ladder.mmproj?.sizeBytes,
      loading: false,
    };
  }, [kind, detailRepo, localEntry, localOptions, listing]);
  const detailIsLocal = localEntry !== undefined;
  useEffect(() => {
    if (kind !== 'models' || detailRepo === undefined || detailIsLocal) return;
    if (!detailRepo.includes('/')) return;
    let cancelled = false;
    void listingFor(detailRepo).then((read) => {
      /*
       * A 401 here is not a failure to explain away — it means the repo is
       * gated or private and we have no token. Say that, and offer the fix
       * inline, rather than printing "HTTP 401" and leaving the user to guess.
       */
      if (!cancelled && read.error !== undefined && /401|403|gated/i.test(read.error)) {
        setNeedsToken(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [detailRepo, detailIsLocal, kind, listingFor]);

  /*
   * THE FILE A LADDER RECOMMENDATION WILL FETCH, for the cards that name a size
   * and a quant before anyone opens a picker (Top Recommended, Quick Download).
   *
   * The recommender chooses the MODEL from a bytes-per-weight estimate, and it
   * used to name the quant as well: "17.2 GB · Q3_K_M" on the 27B, a quant that
   * repo does not publish, above a picker pinning UD-Q3_K_XL. Which FILE is the
   * listing's answer, by the same call a Download makes, so wherever a repo's
   * listing is here the card, the picker and the button name one file. With a
   * file of the repo on disk, that is the file you have: it tops the pick as it
   * tops the picker, so the card names what is here rather than something else.
   */
  const picks = useMemo(() => {
    const out: Record<string, { quant: string; bytes: number }> = {};
    const totalRamGB = hw?.ramGiB ?? 0;
    if (totalRamGB <= 0) return out;
    for (const [repo, read] of Object.entries(listings)) {
      const pick = pickHfDownload(
        read.files,
        { totalRamGB, mmprojBytes: read.ladder.mmproj?.sizeBytes },
        { isDownloaded: onDiskFor(repo) },
      );
      if (pick.kind === 'file') out[repo] = { quant: pick.quant, bytes: pick.file.sizeBytes ?? 0 };
    }
    return out;
  }, [listings, hw, onDiskFor]);
  /*
   * WHAT "USE" STARTS, by repo, for every repo with a file on disk: an entry
   * that holds it, at a quant that is here — the pick above whenever it is
   * (local-use.ts). Top Recommended's card names this file once its button
   * says Use, and the button starts this one, so the two cannot disagree.
   */
  const uses = useMemo(() => {
    const out: Record<string, LocalUse> = {};
    const totalRamGB = hw?.ramGiB ?? 0;
    for (const e of catalog) {
      const repo = e.hfRepo;
      if (repo === undefined || out[repo] !== undefined) continue;
      const use = pickLocalUse(catalog, repo, {
        ...(picks[repo] === undefined ? {} : { pick: picks[repo].quant }),
        fit: { totalRamGB, mmprojBytes: listings[repo]?.ladder.mmproj?.sizeBytes },
      });
      if (use !== undefined) out[repo] = use;
    }
    return out;
  }, [catalog, picks, listings, hw]);
  /* Top Recommended's text pick names its file, so that one listing is read up
     front: the request its card's picker would make, made once. */
  const textPickRepo = useMemo(() => {
    if (!curated || host === null) return undefined;
    const rec = recommendFor('text', host);
    return rec !== undefined && installKindOf(rec.family) === 'gguf' ? rec.variant.repo : undefined;
  }, [curated, host]);
  useEffect(() => {
    if (textPickRepo !== undefined) void listingFor(textPickRepo);
  }, [textPickRepo, listingFor]);
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
  /*
   * Which quants of the model on screen are actually on disk: the picker's
   * `isDownloaded`.
   *
   * A LOCAL entry's card (On Device) answers for that entry's own files, since
   * its Download fetches into that entry and its files are what that entry
   * launches. Any other card is a REPO's (a Recommended pick, a Hub search
   * hit), which carries no `downloadedQuants` of its own. It answers for every
   * entry holding a file of that repo, with the same `onDiskFor` its Downloads
   * rank with. Recreated per detail and per catalog, so the identity is stable
   * across renders: it feeds a `useMemo` in the picker, and a fresh closure
   * every render would recompute the recommendation on every keystroke
   * elsewhere on the page.
   */
  const quantOnDisk = useMemo(() => {
    if (localEntry === undefined) {
      return detailRepo === undefined ? () => false : onDiskFor(detailRepo);
    }
    const own = new Set(localEntry.downloadedQuants ?? []);
    return (q: string) => own.has(q);
  }, [localEntry, detailRepo, onDiskFor]);

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
  const copyId = (id: string) => void writeClipboardText(id);

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
  /*
   * ROOM FIRST. the user: "don't allow / warn of disk space issues when downloading
   * a model that there isn't enough space for." The main process refuses a
   * download that would not fit (`spaceRefusal`, with a margin kept back), but
   * a refusal that arrives after the click is a bar that never appears; so the
   * same question is asked here, before anything is queued, and the answer is
   * shown where the download was asked for. Nothing is queued when it says no.
   */
  const roomFor = async (bytes: number | undefined): Promise<boolean> => {
    if (bytes === undefined || bytes <= 0) return true;
    const r = await window.piDesktop
      .invoke('storage:check-space', { bytes })
      .catch(() => ({ ok: true, refusal: null, free: 0 }));
    if (r.ok) return true;
    setError(r.refusal ?? 'Not enough disk space for this download.');
    refreshDisk();
    return false;
  };

  const download = async (id: string, quant?: string) => {
    setBusyId(id);
    setError(null);
    try {
      const local = catalog.find((e) => e.id === id);
      if (local !== undefined) {
        // The quant asked for, else the first — the same choice the supervisor
        // makes when none is named, so this asks about the file that will move.
        const want = local.quants.find((q) => q.quant === quant) ?? local.quants[0];
        if (!(await roomFor(want?.bytes))) {
          setBusyId(null);
          return;
        }
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
        if (hit === undefined) {
          setError('Could not resolve a file to download for this model.');
        } else {
          /*
           * THE FILE IS THE PICKER'S. `pickHfDownload` ranks this repo's listing
           * with the picker's own call and inputs, so Download pressed without
           * opening the picker fetches the row it pins. It used to take the
           * listing's FIRST file — alphabetically, on the 27B, one 50 GB shard of
           * a BF16 that cannot load on the 24 GB Mac it was fetched for — and a
           * label chosen in the picker found the speed head of that name first.
           *
           * The listing is the one for `id`, read now if it has not been: this
           * click may also have just selected `id` (Top Recommended, Quick
           * Download), and the picker's state still belongs to the last card.
           * So is what is on disk: `onDiskFor(id)` is the repo's own answer,
           * the one its card's picker ranks with.
           */
          const read = await listingFor(id);
          const totalRamGB =
            hw?.ramGiB ??
            (await window.piDesktop
              .invoke('app:get-info', undefined)
              .then((i) => Math.round(i.totalMemoryBytes / 1024 ** 3))
              .catch(() => 0));
          const onDisk = onDiskFor(id);
          const pick = pickHfDownload(
            read.files,
            { totalRamGB, mmprojBytes: read.ladder.mmproj?.sizeBytes },
            { ...(quant === undefined ? {} : { quant }), isDownloaded: onDisk },
          );
          if (pick.kind !== 'file') {
            // Gated: the token row says so and takes the token; one message is enough.
            if (read.error !== undefined && /401|403|gated/i.test(read.error)) setNeedsToken(true);
            else setError(pickRefusal(id, pick, read.error));
          } else if (onDisk(pick.quant)) {
            /* Already here, held by another entry of this repo. The picker says
               "On disk" for it and offers no Download, and no other path may
               fetch it a second time into a new entry either. */
            setError(`${pick.quant} of ${id} is already on disk.`);
          } else if (await roomFor((pick.file.sizeBytes ?? 0) + (pick.mmproj?.sizeBytes ?? 0))) {
            await useHfStore.getState().addAndDownload(hit, pick.file, {
              ...(pick.mmproj === undefined ? {} : { mmproj: pick.mmproj }),
              ...(pick.mtpFile === undefined ? {} : { mtpFile: pick.mtpFile }),
            });
          }
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
      // The recipe's own file when it names one (Ling 3.0's "tiny · Q4"), not
      // whatever the picker would recommend for this machine.
      await download(variant.repo, recipeQuant(variant.allow));
      return;
    }
    /*
     * A RECIPE CAN SPAN REPOS, and all of it has to arrive or none of it is
     * useful: a quantized LTX transformer without its T5 encoder and VAE is 1.3
     * GB that cannot generate anything. The parts are queued in order behind the
     * primary — the store runs one at a time, so this is a queue rather than a
     * race, and the top-bar bar shows whichever is moving.
     */
    setError(null);
    if (!(await roomFor(variant.approxBytes))) return;
    const primary = {
      repo: variant.repo,
      kind: family.output,
      name: `${family.name} ${variant.label}`,
      family: family.id,
      ...(variant.tasks === undefined ? {} : { tasks: variant.tasks }),
      ...(variant.allow === undefined ? {} : { allow: variant.allow }),
      ...(variant.note === undefined ? {} : { notes: variant.note }),
      // The whole recipe's size, so the main-side guard judges the recipe.
      ...(variant.approxBytes === undefined ? {} : { approxBytes: variant.approxBytes }),
    };
    await storeDownload(primary);
    // The store's refusal (no room, no repo, …) used to stay inside the store.
    const refused = useStoreModels.getState().error;
    if (refused !== null) {
      setError(refused);
      return;
    }
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
   *
   * A TEXT MODEL STARTS WHAT IS ON DISK (`uses`). This took the first catalog
   * entry naming the repo at the recommender's rung: the 27B asked the server
   * for a Q3_K_M its repo does not publish, and with only the hub's own
   * download here it started a download of that quant under the curated entry,
   * which was not downloaded. Whatever the start answers is shown — the result
   * used to be dropped, so a failed Use looked like a button that did nothing.
   */
  const applyRecommendation = async (rec: ModelRecommendation): Promise<void> => {
    if (rec.family.output === 'text') {
      setError(null);
      const use = uses[rec.variant.repo];
      if (use === undefined) {
        setError(`${rec.family.name} ${rec.variant.label} is no longer on this disk.`);
        await refreshCatalog();
        return;
      }
      const started = await activateLocalModel(use.modelId, use.quant, 'fast-text', {
        waitForIdleTurn: true,
      }).catch((e: unknown) => ({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (!started.success) {
        setError(started.error ?? `${rec.family.name} ${rec.variant.label} did not start.`);
      }
      return;
    }
    /* Straight to the room that makes this kind of thing, rather than to one
       studio that then has to be told which mode it is in. */
    const out = rec.family.output;
    useModalityStore
      .getState()
      .setView(
        out === '3d' ? '3d' : out === 'video' ? 'video' : out === 'audio' ? 'audio' : 'image',
      );
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
    /*
     * `flex-1 min-h-0`, NOT `h-full`. The hub sits under the 48px top bar
     * inside the main surface's column; `h-full` measured against the whole
     * surface, so the page ran 48px past the bottom of the window (MEASURED:
     * root 48→915 in an 867px window) and the last row of every list was cut
     * off behind the edge — the "stable 3 audio is cut off" report, which had
     * been treated with extra bottom padding. The column's own remaining
     * height is the honest size.
     */
    <div className="flex min-h-0 flex-1 flex-col bg-bg-base" data-testid="models-view">
      {/* No traffic-light strip: the hub renders INSIDE the chat shell now, which
          already owns the drag region and the top bar. A second one here left a
          dead 44px band and a back button under the real title. */}
      {/*
       * THE HEADER, FOR SOMEONE WHO JUST WANTS A MODEL.
       *
       * the user (2026-10-08): "'model hub' feels like a thing for technical users
       * when it's put like this, but it's placed by default on the sidebar … we
       * should make it more friendly", and the page was "a mess of filters and
       * options all dumped there". So: one plain title; the three places
       * (Discover, On this Mac, Storage) are the first control; the machine's
       * specs fold into "This Mac"; datasets (for training) move into the ⋯
       * menu; and the power filters (format, capabilities, sort, size, layout)
       * sit behind one Filters button. The testids are unchanged.
       */}
      <div className="flex shrink-0 items-start justify-between gap-6 px-6 pt-4 pb-3">
        <div className="min-w-0">
          <h1 className="pd-display-l text-text-primary">
            {kind === 'datasets' ? 'Datasets' : 'Models'}
          </h1>
          <p className="mt-1 text-footnote text-text-secondary">
            {kind === 'datasets'
              ? 'Data to train a model on, from Hugging Face.'
              : 'Pick one for what you want to make. It downloads once, then runs on this Mac.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          <button
            type="button"
            data-testid="hub-mac-toggle"
            aria-expanded={macOpen}
            onClick={() => setMacOpen((v) => !v)}
            className="pd-hub-quiet pd-focusable"
          >
            <Glyph name="onDevice" size={14} />
            <span>This Mac</span>
            {hw !== null ? (
              <span className="text-text-muted tabular-nums">{hw.ramGiB} GB</span>
            ) : null}
            <IconChevronDown
              size={13}
              className={cx('text-text-muted transition-transform', macOpen && 'rotate-180')}
            />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="hub-more"
                aria-label="More"
                title="More"
                className="pd-hub-quiet pd-hub-quiet--icon pd-focusable"
              >
                <IconMore size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="min-w-[220px]">
              {kind === 'models' ? (
                <DropdownMenuItem
                  data-testid="hub-kind-datasets"
                  icon={<Glyph name="training" size={16} />}
                  onSelect={() => setKind('datasets')}
                >
                  Datasets for training
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  data-testid="hub-kind-models"
                  icon={<Glyph name="models" size={16} />}
                  onSelect={() => setKind('models')}
                >
                  Back to models
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* This Mac — what the fit verdicts are judged against, one click away. */}
      <div className="pd-hub-reveal shrink-0 px-6" data-open={macOpen} inert={!macOpen}>
        <div>
          <div className="flex flex-wrap items-center gap-1.5 pb-3" data-testid="hardware-strip">
            <Chip label="downloaded" value={String(localCount)} />
            <Chip label="available" value={String(all.length)} />
            {hw !== null ? (
              <>
                <Chip label="GB RAM" value={String(hw.ramGiB)} />
                <Chip label={hw.cpus === 1 ? 'CPU core' : 'CPU cores'} value={String(hw.cpus)} />
              </>
            ) : null}
            {disk !== null ? (
              <span data-testid="hub-disk-free" title={`${compactBytes(disk.total)} disk`}>
                <Chip label="GB free" value={String(Math.round(disk.free / 1024 ** 3))} />
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* The three places, then search. */}
      <div className="flex shrink-0 items-center gap-3 px-6 pb-3">
        {kind === 'models' ? (
          <div className="pd-hub-tabs" role="tablist" aria-label="Models">
            {(['discover', 'device', 'storage'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                data-testid={`models-tab-${t}`}
                data-active={tab === t}
                onClick={() => setTab(t)}
                className="pd-hub-tab pd-focusable"
              >
                <Glyph
                  name={t === 'storage' ? 'storage' : t === 'discover' ? 'discover' : 'onDevice'}
                  size={16}
                />
                {t === 'discover' ? 'Discover' : t === 'device' ? 'On this Mac' : 'Storage'}
              </button>
            ))}
          </div>
        ) : null}
        {tab === 'storage' && kind === 'models' ? null : (
          <input
            data-testid="models-search"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            placeholder={kind === 'datasets' ? 'Search datasets' : 'Search all models'}
            className="min-w-0 flex-1 rounded-full border border-border-subtle bg-bg-raised px-4 py-2 text-body text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-text-muted pd-focusable"
          />
        )}
      </div>

      {/*
        WHAT THE LIST SHOWS. Recommended or All, and what a model makes, stay in
        view — they are what people arrive with. Everything else is a refinement
        of All and opens with Filters.

        WHAT IS HIDDEN ON THE RECOMMENDED VIEW, AND WHY. The curated list has its
        own order — smallest way into each family first — and its own shape: a
        family, not a repo. So the sort, the quant format and the capability
        filter have nothing to act on there. Left visible they were worse than
        useless: the sort read "Newest" over a list that is not sorted by date.
       */}
      {tab === 'storage' && kind === 'models' ? null : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3">
            {/*
             * RECOMMENDED / ALL. the user: "by default, the 'newest' will show just a
             * bunch of random models, so if you could just have reputable
             * organizations shown, for example a 'reccomended/all' toggle".
             *
             * A two-state pill rather than another dropdown: it has two values, it
             * is the single biggest lever over what the list contains, and it should
             * be visible without opening anything.
             */}
            <div
              className={cx(
                'flex rounded-full border border-border-subtle bg-bg-inset p-0.5',
                // Recommended or All chooses what Discover lists; it does not
                // touch what is on this Mac, so there it is not offered.
                tab === 'device' && kind === 'models' && 'hidden',
              )}
              data-testid="hub-scope"
            >
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

            {curated ? null : (
              <button
                type="button"
                data-testid="hub-filters"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((v) => !v)}
                className="pd-hub-quiet pd-focusable"
              >
                <IconSlider size={14} />
                <span>Filters</span>
                {refinements > 0 ? <span className="pd-hub-count">{refinements}</span> : null}
                <IconChevronDown
                  size={13}
                  className={cx(
                    'text-text-muted transition-transform',
                    filtersOpen && 'rotate-180',
                  )}
                />
              </button>
            )}
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
          </div>
          {curated ? null : (
            <div
              className="pd-hub-reveal shrink-0 px-6"
              data-open={filtersOpen}
              inert={!filtersOpen}
            >
              <div>
                <div
                  className="flex flex-wrap items-center gap-2 pb-4"
                  data-testid="hub-filters-panel"
                >
                  {/* A quant format is a model property; datasets have none, so offering
                      the control there is offering a dead end. */}
                  {kind === 'models' && !curated ? (
                    <Dropdown
                      testid="filter-format"
                      value={filters.format}
                      options={formatOptions}
                      onChange={(format) => setFilters((f) => ({ ...f, format }))}
                    />
                  ) : null}
                  {kind === 'models' && !curated ? (
                    <CapabilityFilter
                      selected={filters.capabilities}
                      options={capabilityOptions}
                      onChange={(capabilities) => setFilters((f) => ({ ...f, capabilities }))}
                    />
                  ) : null}
                  {curated ? null : (
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
                  )}
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
                  {curated ? null : (
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
                        aria-label={
                          sizeUnit === 'gb' ? 'Maximum size in GB' : 'Maximum parameters in B'
                        }
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
                  )}

                  {/*
                   * THE LAYOUT SWITCH HAS NO LAYOUT TO SWITCH ON THE CURATED VIEW.
                   *
                   * the user: "the layout buttons actually don't do anything except they
                   * oddly resize the model card." Exactly right — the curated grid is
                   * hardcoded to list-plus-420px-pane (a card list has nowhere to put a
                   * table), so the only thing these three buttons still reached was the
                   * pane's max-height, which made the card grow and shrink for no stated
                   * reason. They belong to the table, so they appear with it.
                   */}
                  {curated ? null : (
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
                              <IconListCompact size={14} />
                            ) : v === 'split' ? (
                              <IconLayoutRight size={14} />
                            ) : (
                              <IconLayoutLeft size={14} />
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {hfError !== null ? (
        <p
          className="mx-6 mb-3 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-secondary"
          data-testid="models-hf-error"
        >
          {sayIfRaw(hfError, 'search')}
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

      {error !== null || downloadError !== null ? (
        <p
          className="mx-6 mb-3 rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-primary"
          data-testid="models-error"
        >
          {sayIfRaw(error ?? downloadError?.error, 'download')}
        </p>
      ) : null}

      {tab === 'storage' ? (
        /*
         * NO EDGE FADE HERE. The scroll-driven mask paints 16px of transparency
         * over the top of the viewport once the page has moved, and this page
         * pins its toolbar and its card to that very edge — so the search box,
         * the sort and the top of the card were being faded out (the user: "fix the
         * cutoff / fade out that shouldn't be happening at the top"). The
         * toolbar carries its own background instead, and rows slide under it.
         */
        <ScrollArea className="min-h-0 flex-1" fade={false} data-testid="storage-scroll">
          <div className="px-6 pb-16">
            <StorageView />
          </div>
        </ScrollArea>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {/*
          MORE ROOM AT THE BOTTOM. the user: "I scrolled to the bottom here and the
          stable 3 audio is cut off on the bottom." At max scroll the last card
          cleared the fold by exactly the 40px of padding — and the scroll area
          paints a 16px bottom fade over that, so the final card was landing in
          a 40px gap with a gradient across half of it. The last row of a long
          list should end well clear of the edge, not just barely inside it.

          FOUND LATER (2026-09-13): the bigger reason was the hub's root being
          `h-full` under the 48px top bar — the whole page ran 48px past the
          window, so the bottom of every list was behind the edge, fade or no
          fade. That is fixed at the root (`flex-1 min-h-0`); the padding stays
          because the last row still deserves air.
        */}
          <div className="px-6 pb-16">
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
                    'grid',
                    // The curated list is cards, not a table, so it keeps the
                    // detail pane beside it even in the compact view — otherwise
                    // clicking a version would have nowhere to show it.
                    //
                    // NO GAP THERE. The pane is a panel divided from the list by
                    // one hairline, not a card floating beside it, so the two
                    // columns meet and the border does the separating.
                    curated
                      ? 'grid-cols-[minmax(0,1fr)_460px] gap-0'
                      : view === 'compact'
                        ? 'gap-5'
                        : view === 'split'
                          ? 'grid-cols-[minmax(0,1fr)_420px] gap-5'
                          : 'grid-cols-[300px_minmax(0,1fr)] gap-5',
                  )}
                >
                  {/* A gutter, so the cards do not run into the divider. With the
                    columns flush the family cards' right borders sat ~8px from
                    the panel's hairline and read as one crowded double line. */}
                  <div className={curated ? 'pr-6' : undefined}>
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
                              ? 'On this Mac'
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
                        className="pd-display-m mb-3 text-text-primary"
                        data-testid="top-recommended-heading"
                      >
                        Top Recommended
                      </h2>
                    ) : null}

                    {curated ? (
                      <BestForYourMachine
                        host={host}
                        downloaded={downloadedRepos}
                        picks={picks}
                        uses={uses}
                        onSelect={setSelected}
                        onDownload={(rec) => {
                          setSelected(rec.variant.repo);
                          void downloadVariant(rec.family, rec.variant);
                        }}
                        onUse={(rec) => void applyRecommendation(rec)}
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
                          className="pd-display-m mt-4 mb-1 text-text-primary"
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
                            host={host}
                            progress={storeFractions}
                            bytes={storeProgressByRepo}
                            picks={picks}
                            onSelect={setSelected}
                            onDownload={(variant) => void downloadVariant(family, variant)}
                            onCancel={(variant) => void cancelVariant(family, variant)}
                          />
                        ))}
                        {families.length === 0 ? (
                          <p className="py-6 text-body text-text-muted" data-testid="curated-empty">
                            Nothing recommended makes that yet. Switch to All to search the Hub.
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
                          tab === 'device' && kind === 'models' && localCount === 0 ? (
                            /* Nothing installed is not "nothing matches these
                               filters" — there were no filters to match. */
                            <div
                              className="flex items-center gap-3 px-4 py-6"
                              data-testid="models-empty"
                            >
                              <span className="text-body text-text-secondary">
                                No models on this Mac yet.
                              </span>
                              <button
                                type="button"
                                onClick={() => setTab('discover')}
                                className="pd-hub-quiet pd-focusable"
                                data-testid="models-empty-discover"
                              >
                                <Glyph name="discover" size={14} />
                                Find one in Discover
                              </button>
                            </div>
                          ) : (
                            <p
                              className="px-4 py-6 text-body text-text-muted"
                              data-testid="models-empty"
                            >
                              Nothing matches these filters.
                            </p>
                          )
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
                      /* Same panel as the filled state, so nothing moves or
                       changes shape when a version is picked. */
                      className={cx(
                        'pd-detail-panel sticky top-0 self-start text-footnote text-text-muted',
                        DETAIL_HEIGHT,
                      )}
                      data-testid="curated-detail-hint"
                    >
                      Pick a model to see what it makes, how big it is, and whether it fits this
                      Mac.
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
                        // The same edge as every other card on the page. It used
                        // to carry its own lighter border and a 5%-black shadow
                        // that vanished on a dark theme, so the one pane that is
                        // always on screen was the one with no visible edge.
                        'pd-detail-scroll sticky top-0 self-start overflow-y-auto',
                        // Curated: a full-height panel. Otherwise: the old card,
                        // which still floats beside a TABLE and should.
                        curated
                          ? cx('pd-detail-panel', DETAIL_HEIGHT)
                          : cx(
                              'pd-hub-card p-5',
                              view === 'detail'
                                ? 'max-h-[calc(100vh-190px)]'
                                : 'max-h-[calc(100vh-260px)]',
                            ),
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
                            {/* The parameter count belongs to the model's NAME, not
                              to the popularity stats below. On its own down there
                              it was a single stray tag floating between the
                              Download button and the card. */}
                            {detail.params !== undefined && !NAME_SAYS_SIZE.test(detail.name) ? (
                              <span>· {detail.params}</span>
                            ) : null}
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
                      ) : curatedPick !== undefined &&
                        installKindOf(curatedPick.family) === 'gen' ? (
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
                              className="mt-2 text-caption text-status-warning-fg"
                              data-testid="detail-gen-install"
                            >
                              Needs more memory than this computer has. It will download, but not
                              run here.
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {/* The headline action: one click, the recommended file,
                            no question asked. The ladder below is for the people
                            who want to answer that question anyway. */}
                          {/*
                          NO "ON DISK" SLAB ABOVE THE LADDER. the user: "there's a
                          'on disk' and 'installed' greyed out here… 'on disk'
                          has no place there." The ladder below already answers
                          it per FILE, which is the answer that is true — the
                          slab was a second, coarser reply to the same question,
                          sitting directly on top of the accurate one.
                        */}
                          {detail.downloaded === true ? null : (
                            <DownloadAction
                              installed={false}
                              busy={busyId === detail.id}
                              fraction={progress === null ? null : downloadFraction(progress)}
                              received={progress?.jobReceived ?? progress?.received}
                              total={progress?.jobTotal ?? progress?.total}
                              eta={
                                progress === null
                                  ? undefined
                                  : formatEta(downloadEtaSeconds(progress))
                              }
                              onDownload={() => void download(detail.id)}
                              onCancel={() => void cancelHere()}
                              testid="detail-download"
                            />
                          )}
                          <QuantPicker
                            options={quants?.repo === detail.id ? quants.options : []}
                            loading={quants?.repo === detail.id ? quants.loading : true}
                            totalRamGB={hw?.ramGiB ?? 0}
                            mmprojBytes={quants?.mmprojBytes}
                            format={detail.formats[0]?.toUpperCase()}
                            /* The per-QUANT truth. Without it the picker fell back
                             to the repo-level flag and mislabelled every row. */
                            isDownloaded={quantOnDisk}
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
                        {detail.formats.map((f) => (
                          <Chip key={f} value={f.toUpperCase()} />
                        ))}
                      </div>

                      {/* No rule above the card. the user: "that top border with the
                        fade out of the model card has no need to happen." The
                        README opens with its own heading, which separates it
                        from the chips better than a hairline that reads as the
                        pane's second top edge. */}
                      <div className="mt-5" data-testid="model-card">
                        {/* Spin only while a fetch is EXPLICITLY in flight. The
                          old condition spun whenever the state held neither a
                          body nor an error, so any path that set nothing left it
                          spinning forever. */}
                        {card?.repo !== detail.id || card.loading === true ? (
                          <p className="flex items-center gap-2 text-footnote text-text-muted">
                            <Spinner size={12} /> Loading model card…
                          </p>
                        ) : card.error !== undefined ? (
                          <p className="text-footnote text-text-muted">
                            {sayIfRaw(card.error, 'search')}
                          </p>
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
      )}
    </div>
  );
}
