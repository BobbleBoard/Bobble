/**
 * CANDIDATE 4 — "Shelf+". The one I would put in front of the user.
 *
 * Round 1 ended with a sentence — "ship Shelf with two pieces of Reach folded
 * in" — that described a design nobody had rendered. This is that design,
 * rebuilt against what the critique found instead of what the sentence said:
 *
 *   - The model hub's idiom, not a slide-over: a reserved pane beside the list
 *     when the box is wide enough, an overlay sheet when it is not, and below
 *     ~720px of content the detail takes the list's place under the same
 *     header. The list never changes width because something was picked.
 *   - The pane's resting state IS the ledger: what is on, with its switches,
 *     needs-setup first, the engine mode in the footer. That is what the
 *     "On now" strip was for, so the strip is gone.
 *   - Every section is capped, the way every reference caps, with a
 *     "Show all N" row — unless you searched or filtered, in which case you
 *     asked for the subset and get all of it.
 *   - Cards keep the description. The reach sentence appears where every item
 *     is installed — the ledger rows and the pane — so one grid never mixes
 *     two kinds of second line.
 *   - Add is a "+"; installed is a switch; "Set up" is the only word, and only
 *     where attention is needed.
 *   - An installed server's tools are drawn from the cache the moment the
 *     pane opens (data.ts); the server was listed when it was turned on.
 */
import {
  Button,
  IconChevronDown,
  IconChevronLeft,
  IconClose,
  IconPlus,
  IconSearch,
  ScrollArea,
} from '@pi-desktop/ui';
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AddServerDialog } from '../../connectors/AddServerDialog';
import { cx } from '../../onboarding/cx';
import {
  type Actions,
  type Catalog,
  FILTERS,
  failing,
  failureLine,
  hasKeys,
  type Item,
  type KindFilter,
  ledgerLine,
  matches,
  needsAttention,
  passesFilter,
  shortReason,
  summarize,
  summaryLine,
  useActions,
  useCatalog,
  useWarmTools,
} from './data';
import {
  AboutSection,
  CustomSection,
  DetailHeader,
  EngineMode,
  ReachSection,
  RemoveRow,
  SetupSection,
  SkillBody,
  ToolsSection,
} from './detail-parts';
import { ItemMark, StateControl, StateDot } from './marks';

/**
 * From this much content up, the pane sits beside the list.
 *
 * 1104, not 1080: the pinned list is the box minus the 420px pane, and the
 * card grid goes to two columns from 660px of LIST (candidates.css) — but
 * the list is a scroll container with `scrollbar-gutter: stable`, so its
 * container width is ~15px under its box. At 1080 that left a ~24px band
 * (judgement 6: one column at 1081, two at 1079 under the overlay) where a
 * window drag across the crossing changed the pane mode AND the column
 * count. From 1104 the pinned list is 684 − gutter ≥ 660, so a drag across
 * the crossing changes the pane mode and nothing else.
 */
const PINNED_MIN = 1104;
/** Below this much content, the pane takes the list's place instead of overlaying 200px of it. */
const OVERLAY_MIN = 720;

type PaneMode = 'pinned' | 'overlay' | 'full';

const CAPS = { tools: 8, skills: 6, builtins: 4 } as const;

/** The width of the box this component is in — not the window. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ───────────────────────────── the list ─────────────────────────────

function Card({
  item,
  selected,
  busy,
  actions,
  onOpen,
  onSetup,
}: {
  item: Item;
  selected: boolean;
  busy: boolean;
  actions: Actions;
  /** The card body: opens the detail, or closes it if this is the one open. */
  onOpen: () => void;
  /** A word-button ("Set up", "Try again"): opens the detail and never closes it. */
  onSetup: () => void;
}): JSX.Element {
  return (
    <div className="cand-card" data-selected={selected} data-testid={`cand-card-${item.id}`}>
      <button
        type="button"
        className="cand-open flex min-w-0 flex-1 items-start gap-3 text-left"
        data-testid={`cand-open-${item.id}`}
        onClick={onOpen}
      >
        <ItemMark item={item} size={36} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* The name gets the room; nothing beside it can push it to "C.". */}
          <span className="truncate text-body text-text-primary">{item.name}</span>
          <span className="line-clamp-2 text-footnote text-text-muted leading-snug">
            {item.description}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center self-start">
        <StateControl item={item} busy={busy} actions={actions} onSetup={onSetup} />
      </div>
    </div>
  );
}

/** A recommendation is a quick add: mark, name, "+". Three fit on one line. */
function Chip({
  item,
  selected,
  busy,
  actions,
  onOpen,
  onSetup,
}: {
  item: Item;
  selected: boolean;
  busy: boolean;
  actions: Actions;
  onOpen: () => void;
  onSetup: () => void;
}): JSX.Element {
  const reason = item.kind === 'connector' && item.reason !== undefined ? item.reason : undefined;
  return (
    <div className="cand-chip" data-selected={selected} title={reason}>
      <button
        type="button"
        className="cand-open flex min-w-0 items-center gap-2 text-left"
        onClick={onOpen}
        data-testid={`cand-open-${item.id}`}
      >
        <ItemMark item={item} size={26} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-footnote text-text-primary">{item.name}</span>
          {reason !== undefined ? (
            <span className="truncate text-caption text-text-muted">{shortReason(reason)}</span>
          ) : null}
        </span>
      </button>
      <StateControl item={item} busy={busy} actions={actions} onSetup={onSetup} />
    </div>
  );
}

function ShowAll({
  rest,
  peek,
  onClick,
}: {
  rest: readonly Item[];
  peek: readonly Item[];
  onClick: () => void;
}): JSX.Element {
  const names = peek.map((i) => i.name);
  const others = rest.length - names.length;
  const label =
    others > 0
      ? `Show all — ${names.join(', ')} and ${others} more`
      : `Show all — ${names.join(', ')}`;
  return (
    <button
      type="button"
      className="cand-showall pd-focusable"
      onClick={onClick}
      data-testid="cand-show-all"
    >
      <span className="cand-cluster">
        {peek.map((i) => (
          <ItemMark key={i.id} item={i} size={24} />
        ))}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function Section({
  id,
  title,
  blurb,
  items,
  cap,
  capped,
  layout = 'grid',
  children,
}: {
  id: string;
  title: string;
  blurb?: string;
  items: readonly Item[];
  cap: number;
  /** False while a search or filter is active: the subset was asked for. */
  capped: boolean;
  layout?: 'grid' | 'chips';
  children: (item: Item) => JSX.Element;
}): JSX.Element | null {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  // A group of cap+1 is whole: "Show all — Playwright" for one card is a click
  // charged for one row (the tools list has the same rule).
  const limit = capped && !all && items.length > cap + 1 ? cap : items.length;
  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  return (
    <section data-testid={`cand-section-${id}`}>
      <div className="cand-group-head">
        <h2 className="text-body text-text-primary">{title}</h2>
        <span className="text-caption text-text-muted">{items.length}</span>
        {blurb !== undefined ? (
          <span className="text-caption text-text-muted">· {blurb}</span>
        ) : null}
      </div>
      {layout === 'chips' ? (
        <div className="flex flex-wrap gap-2">{shown.map(children)}</div>
      ) : (
        <div className="cand-grid">{shown.map(children)}</div>
      )}
      {rest.length > 0 ? (
        <div className="mt-1.5">
          <ShowAll rest={rest} peek={rest.slice(0, 3)} onClick={() => setAll(true)} />
        </div>
      ) : all && capped && items.length > cap + 1 ? (
        <button
          type="button"
          className="cand-textbtn pd-focusable mt-2 px-3"
          onClick={() => setAll(false)}
          data-testid="cand-show-fewer"
        >
          Show fewer
        </button>
      ) : null}
    </section>
  );
}

function groupItems(visible: readonly Item[]): {
  recommended: Item[];
  tools: Item[];
  skills: Item[];
  builtins: Item[];
} {
  const recommended = visible.filter(
    (i) => i.kind === 'connector' && i.reason !== undefined && i.state === 'available',
  );
  const rec = new Set(recommended.map((i) => i.id));
  const customs = visible.filter((i) => i.kind === 'custom');
  const connectors = visible.filter(
    (i) => i.kind === 'connector' && i.state !== 'builtin' && !rec.has(i.id),
  );
  // What you have first (needs setup — or on and failing — then on, off), then
  // official, then community.
  const rank = (i: Item): number =>
    needsAttention(i)
      ? 0
      : i.state === 'on'
        ? 1
        : i.state === 'off'
          ? 2
          : i.kind === 'connector' && i.connector.official
            ? 3
            : 4;
  const sorted = [...customs, ...connectors].sort((a, b) => rank(a) - rank(b));
  return {
    recommended,
    tools: sorted,
    skills: visible.filter((i) => i.kind === 'skill'),
    builtins: visible.filter((i) => i.kind === 'connector' && i.state === 'builtin'),
  };
}

// ───────────────────────────── the pane ─────────────────────────────

function PaneRow({
  item,
  line,
  busy,
  actions,
  onOpen,
  compact = false,
}: {
  item: Item;
  line?: string;
  busy: boolean;
  actions: Actions;
  onOpen: () => void;
  compact?: boolean;
}): JSX.Element {
  // A server that is on and did not answer: the row's second line is the
  // failure, in amber, and its control is the Set up / Try again pill — the
  // row itself says so, not only the detail's Tools paragraph (judgement 1).
  const failed = failureLine(item);
  return (
    <div className={cx('cand-row', compact && 'min-h-[34px] py-1')}>
      <button
        type="button"
        className="cand-open flex min-w-0 flex-1 items-center gap-2.5 text-left"
        onClick={onOpen}
        data-testid={`cand-pane-open-${item.id}`}
      >
        <ItemMark item={item} size={compact ? 22 : 30} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-footnote text-text-primary">{item.name}</span>
          {failed !== null ? (
            <span
              className="truncate text-caption text-status-warning-fg"
              data-testid={`cand-row-failure-${item.id}`}
            >
              {failed}
            </span>
          ) : line !== undefined ? (
            <span className="truncate text-caption text-text-muted">{line}</span>
          ) : null}
        </span>
      </button>
      {/* The ledger's rows are only ever opening, never closing, so the
          word-buttons and the row body do the same thing here. */}
      {compact ? null : <StateControl item={item} busy={busy} actions={actions} onSetup={onOpen} />}
    </div>
  );
}

function PaneGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}): JSX.Element | null {
  if (count === 0) return null;
  return (
    <div className="pt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-caption text-text-muted">{title}</span>
        <span className="text-caption text-text-muted">{count}</span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

/** The pane at rest: the ledger. What the agent has, with the switches that change it. */
function Resting({
  cat,
  actions,
  onOpen,
}: {
  cat: Catalog;
  actions: Actions;
  onOpen: (id: string) => void;
}): JSX.Element {
  const summary = summarize(cat.items);
  // "Needs setup" is the attention group: a key still unfilled, or on and not
  // answering (round 4, item 1). A failing server is never under "On".
  const setup = cat.items.filter(needsAttention);
  const on = cat.items.filter((i) => i.kind !== 'skill' && i.state === 'on' && !failing(i));
  const off = cat.items.filter((i) => i.kind !== 'skill' && i.state === 'off');
  const skills = cat.items.filter((i) => i.kind === 'skill' && i.state === 'on');
  const builtins = cat.items.filter((i) => i.state === 'builtin');
  const row = (item: Item) => (
    <PaneRow
      key={item.id}
      item={item}
      line={ledgerLine(item)}
      busy={cat.busyId === item.id}
      actions={actions}
      onOpen={() => onOpen(item.id)}
    />
  );
  const empty = setup.length + on.length + off.length + skills.length === 0;
  // The built-in group opens by itself when it is all the ledger has: the
  // fresh pane said "the built-in tools below are already on" over a
  // collapsed group and 400px of nothing (judgement 4). Once the person has
  // toggled it, their choice holds for as long as the pane is at rest.
  const [builtinsToggled, setBuiltinsToggled] = useState<boolean | null>(null);
  const builtinsOpen = builtinsToggled ?? (empty && cat.loaded);
  const setBuiltinsOpen = (next: (v: boolean) => boolean) => setBuiltinsToggled(next(builtinsOpen));
  return (
    <>
      <div className="px-5 pt-5 pb-1">
        <h2 className="text-heading text-text-primary">Your agent</h2>
        <p className="mt-0.5 text-footnote text-text-muted" data-testid="cand-summary">
          {summaryLine(summary)}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-3">
        {empty && cat.loaded ? (
          <div className="px-2 pt-3" data-testid="cand-pane-empty">
            <p className="text-footnote text-text-primary">Nothing added yet.</p>
            <p className="mt-1 text-footnote text-text-muted">
              Pick a tool or a skill from the list; it appears here with a switch. The built-in
              tools below are already on.
            </p>
          </div>
        ) : null}
        <PaneGroup title="Needs setup" count={setup.length}>
          {setup.map(row)}
        </PaneGroup>
        <PaneGroup title="On" count={on.length}>
          {on.map(row)}
        </PaneGroup>
        <PaneGroup title="Off" count={off.length}>
          {off.map(row)}
        </PaneGroup>
        <PaneGroup title="Skills on" count={skills.length}>
          {skills.map(row)}
        </PaneGroup>
        {builtins.length > 0 ? (
          <div className="pt-3 pb-3">
            <button
              type="button"
              className="pd-focusable flex w-full items-center justify-between rounded-md px-2 py-1 text-caption text-text-muted hover:bg-bg-hover hover:text-text-primary"
              aria-expanded={builtinsOpen}
              onClick={() => setBuiltinsOpen((v) => !v)}
              data-testid="cand-builtins-toggle"
            >
              <span>Built in · always on</span>
              <span className="inline-flex items-center gap-1.5">
                {builtins.length}
                <span
                  className={cx('inline-flex transition-transform', builtinsOpen && 'rotate-180')}
                  style={{ transitionDuration: 'var(--pd-duration-base)' }}
                >
                  <IconChevronDown size={12} />
                </span>
              </span>
            </button>
            {/* Opens to its measured height (candidates.css), the way the hub's
                family card does; a mounted-on-open list would snap. */}
            <div className="candp-collapse" data-open={builtinsOpen} data-testid="cand-builtins">
              <div>
                <div className="flex flex-col">
                  {builtins.map((item) => (
                    <PaneRow
                      key={item.id}
                      item={item}
                      busy={false}
                      actions={actions}
                      onOpen={() => onOpen(item.id)}
                      compact
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </ScrollArea>
      <div className="border-border-subtle border-t px-5 py-3">
        <EngineMode mode={cat.mode} actions={actions} compact />
      </div>
    </>
  );
}

/**
 * The way back from a detail. Rendered by the screen OUTSIDE the keyed pane
 * body, so it holds still while the body under it remounts: at 0ms of a swap
 * the whole pane used to be blank, back link included (judgement 9), and a
 * fixed element pretending to be content is what the eye loses its place on.
 */
function BackLink({ mode, onClose }: { mode: PaneMode; onClose: () => void }): JSX.Element {
  if (mode === 'overlay') {
    return (
      <>
        <span />
        <button
          type="button"
          aria-label="Close"
          className="pd-focusable inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={onClose}
          data-testid="cand-back"
        >
          <IconClose size={14} />
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      className="pd-focusable inline-flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-footnote text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      onClick={onClose}
      data-testid="cand-back"
    >
      <IconChevronLeft size={14} /> {mode === 'pinned' ? 'Your agent' : 'Tools and skills'}
    </button>
  );
}

function Detail({
  item,
  busy,
  actions,
  mode,
  onClose,
  onSearch,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  mode: PaneMode;
  onClose: () => void;
  onSearch: (query: string) => void;
}): JSX.Element {
  // A saved key that turned out wrong: the Tools section offers "Change the
  // key", which reopens the setup card over the saved value — and a detail
  // opened on a server already in that state (from the ledger's "Set up"
  // pill) opens with the card already there, since the card is the fix.
  const [editKeys, setEditKeys] = useState(() => failing(item) && hasKeys(item));
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        className={cx(
          'flex flex-col gap-5 px-5 pt-2 pb-6',
          // Full-width mode: the detail is the whole content box; keep it a
          // readable column, not a 640px-wide one.
          mode === 'full' && 'mx-auto w-full max-w-[560px]',
        )}
      >
        <DetailHeader item={item} busy={busy} actions={actions} onSetup={() => undefined} />
        {item.kind === 'connector' ? (
          <>
            <SetupSection
              item={item}
              busy={busy}
              actions={actions}
              open={editKeys}
              onClose={() => setEditKeys(false)}
            />
            <ToolsSection
              item={item}
              actions={actions}
              split
              // No "Change the key" link under the error while the card it
              // opens is already open above it.
              onEditKeys={editKeys ? undefined : () => setEditKeys(true)}
            />
            <ReachSection item={item} />
            <AboutSection item={item} onSearch={onSearch} />
            <RemoveRow item={item} busy={busy} actions={actions} onRemoved={onClose} />
          </>
        ) : item.kind === 'custom' ? (
          <CustomSection item={item} busy={busy} actions={actions} onRemoved={onClose} split />
        ) : (
          <>
            <AboutSection item={item} onSearch={onSearch} />
            <SkillBody item={item} actions={actions} />
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// ───────────────────────────── the screen ─────────────────────────────

export function ShelfPlus(): JSX.Element {
  const cat = useCatalog();
  const actions = useActions();
  useWarmTools(cat, actions);
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const mode: PaneMode = width >= PINNED_MIN ? 'pinned' : width >= OVERLAY_MIN ? 'overlay' : 'full';
  const pinned = mode === 'pinned';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<KindFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const selected = cat.items.find((i) => i.id === selectedId) ?? null;
  const filtered = query.trim() !== '' || filter !== 'all';
  const visible = useMemo(
    () => cat.items.filter((i) => matches(i, query) && passesFilter(filter, i)),
    [cat.items, query, filter],
  );
  const groups = useMemo(() => groupItems(visible), [visible]);
  // The pill counts what needs attention: a key unfilled, or on and failing
  // — the count went from 1 to 0 on a bad key in round 4's frames.
  const setupCount = useMemo(() => cat.items.filter(needsAttention).length, [cat.items]);
  const summary = useMemo(() => summarize(cat.items), [cat.items]);

  const open = (id: string) => setSelectedId((cur) => (cur === id ? null : id));
  const select = (id: string) => setSelectedId(id);
  // The category link in a detail: search for it, and in the narrow modes
  // come back to the list so the result is what you see.
  const searchFor = (q: string) => {
    setQuery(q);
    setFilter('all');
    if (!pinned) setSelectedId(null);
  };
  const card = (item: Item) => (
    <Card
      key={item.id}
      item={item}
      selected={item.id === selectedId}
      busy={cat.busyId === item.id}
      actions={actions}
      onOpen={() => open(item.id)}
      onSetup={() => select(item.id)}
    />
  );
  const chip = (item: Item) => (
    <Chip
      key={item.id}
      item={item}
      selected={item.id === selectedId}
      busy={cat.busyId === item.id}
      actions={actions}
      onOpen={() => open(item.id)}
      onSetup={() => select(item.id)}
    />
  );

  const paneOpen = pinned || selected !== null;
  const listHidden = mode === 'full' && selected !== null;
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? 'All';

  return (
    <div
      ref={rootRef}
      className="candp flex h-full flex-col bg-bg-base"
      data-testid="cand-shelf-plus"
      data-pane-mode={mode}
    >
      {/* The header stays put while the list scrolls — the hub's rule. The
          first round-2 render had it inside the scroll, and opening a skill
          near the bottom scrolled the search box off the top of the window. */}
      <div className="flex shrink-0 flex-col gap-3 px-6 pt-5 pb-3">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-title text-text-primary">Connectors</h1>
            <p className="mt-0.5 text-footnote text-text-muted">
              {pinned
                ? 'Tools and skills your agent can use. Everything here runs on this Mac.'
                : summaryLine(summary)}
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            className="shrink-0"
            onClick={() => setAddOpen(true)}
            data-testid="cand-add-server"
          >
            <IconPlus size={14} /> Add MCP server
          </Button>
        </div>
        <div className="candp-controls">
          <div className="cand-search-wrap">
            <IconSearch size={15} />
            <input
              type="search"
              className="cand-search pd-focusable"
              placeholder="Search tools, skills and categories"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="cand-search"
            />
          </div>
          <div className="candp-filters">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="cand-pill pd-focusable"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                data-testid={`cand-filter-${f.id}`}
              >
                {f.id === 'setup' && setupCount > 0 ? <StateDot state="needs-setup" /> : null}
                {f.label}
                {f.id === 'setup' && setupCount > 0 ? (
                  <span className="cand-pill-count">{setupCount}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="candp-body">
        <ScrollArea className="candp-list" data-hidden={listHidden} data-testid="cand-list">
          <div className="flex w-full max-w-[1100px] flex-col gap-6 px-6 pt-2 pb-8">
            {!cat.loaded ? (
              <p className="text-footnote text-text-muted">Loading…</p>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-start gap-2 py-6" data-testid="cand-empty">
                <p className="text-body text-text-primary">
                  Nothing matches
                  {query.trim() !== '' ? ` “${query.trim()}”` : ''}
                  {filter !== 'all' ? ` in ${filterLabel}` : ''}.
                </p>
                <p className="text-footnote text-text-muted">
                  Try another word, or a server the catalog does not know yet with Add MCP server.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                  data-testid="cand-clear"
                >
                  Clear search and filters
                </Button>
              </div>
            ) : null}

            <Section
              id="recommended"
              title="Recommended for you"
              blurb="apps found on this Mac"
              items={groups.recommended}
              cap={6}
              capped={!filtered}
              layout="chips"
            >
              {chip}
            </Section>
            <Section
              id="tools"
              title="Tools"
              blurb="each one runs as a local process"
              items={groups.tools}
              cap={CAPS.tools}
              capped={!filtered}
            >
              {card}
            </Section>
            <Section
              id="skills"
              title="Skills"
              blurb="playbooks the agent reads; they touch nothing by themselves"
              items={groups.skills}
              cap={CAPS.skills}
              capped={!filtered}
            >
              {card}
            </Section>
            <Section
              id="builtin"
              title="Built in"
              blurb="always on, no server"
              items={groups.builtins}
              cap={CAPS.builtins}
              capped={!filtered}
            >
              {card}
            </Section>

            <div className="flex flex-col gap-4 border-border-subtle border-t pt-5">
              {pinned ? null : <EngineMode mode={cat.mode} actions={actions} />}
              <p className="text-caption text-text-muted leading-relaxed">
                Third-party names and marks belong to their owners and identify the tool only.
              </p>
            </div>
          </div>
        </ScrollArea>

        {mode === 'overlay' && selected !== null ? (
          <button
            type="button"
            className="candp-scrim"
            aria-label="Close details"
            onClick={() => setSelectedId(null)}
          />
        ) : null}
        {paneOpen ? (
          <aside className="candp-pane" data-mode={mode} data-testid="cand-pane">
            {/* The back link is chrome, outside the keyed body: it holds still
                while the body under it swaps. */}
            {selected !== null ? (
              <div className="flex shrink-0 items-center justify-between px-3 pt-3">
                <BackLink mode={mode} onClose={() => setSelectedId(null)} />
              </div>
            ) : null}
            {/* Keyed: a swap remounts the body and runs its entrance again. */}
            <div className="candp-pane-body" key={selected?.id ?? 'resting'}>
              {selected !== null ? (
                <Detail
                  item={selected}
                  busy={cat.busyId === selected.id}
                  actions={actions}
                  mode={mode}
                  onClose={() => setSelectedId(null)}
                  onSearch={searchFor}
                />
              ) : (
                <Resting cat={cat} actions={actions} onOpen={open} />
              )}
            </div>
          </aside>
        ) : null}
      </div>

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={(server) => void actions.saveCustom(server)}
      />
    </div>
  );
}
