/**
 * CANDIDATE 2 — "Ledger".
 *
 * The position: the split that matters is not tools-vs-skills, it is
 * HAVE vs COULD HAVE. Claude's settings table (the one good thing in those
 * refs) is the right shape for managing what you have; a directory is the
 * right shape for adding — but they must be ONE screen, side by side, not a
 * settings page plus a separate Directory modal with its own three-way nav.
 * Kinds are mixed in both panes: a skill and a server are both rows in the
 * ledger, both rows in the directory. Adding something moves it left.
 */
import { Button, IconChevronLeft, IconPlus, IconSearch, ScrollArea } from '@pi-desktop/ui';
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { AddServerDialog } from '../../connectors/AddServerDialog';
import { cx } from '../../onboarding/cx';
import {
  type Actions,
  type Catalog,
  failing,
  failureLine,
  type Item,
  matches,
  needsAttention,
  reachLine,
  shortReason,
  useActions,
  useCatalog,
  useWarmTools,
} from './data';
import {
  AboutSection,
  CATEGORY_LABEL,
  CustomSection,
  categoryOf,
  DetailHeader,
  EngineMode,
  ReachSection,
  RemoveRow,
  SetupSection,
  SkillBody,
  ToolsSection,
} from './detail-parts';
import { ItemMark, StateControl, StateDot } from './marks';

/** What a rail row says under the name: everything in the rail is installed, so the reach line. */
function railLine(item: Item): string {
  if (item.kind === 'connector') return reachLine(item.connector, item.server);
  if (item.kind === 'custom') return `Runs ${item.server.command} · added by you`;
  return item.description;
}

function LedgerGroup({
  title,
  items,
  selectedId,
  busyId,
  actions,
  onOpen,
  compact = false,
}: {
  title: string;
  items: readonly Item[];
  selectedId: string | null;
  busyId: string | null;
  actions: Actions;
  onOpen: (id: string) => void;
  compact?: boolean;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="pt-3" data-testid={`cand-ledger-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-caption text-text-muted">{title}</span>
        <span className="text-caption text-text-muted">{items.length}</span>
      </div>
      <div className="flex flex-col">
        {items.map((item) => (
          <div
            key={item.id}
            className={cx('cand-row', compact && 'min-h-[36px] py-1')}
            data-selected={item.id === selectedId}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              onClick={() => onOpen(item.id)}
              data-testid={`cand-open-${item.id}`}
            >
              <ItemMark item={item} size={compact ? 24 : 30} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-footnote text-text-primary">{item.name}</span>
                {/* Not "Tool · Files": a column of near-constant values. What it
                    touches is the one line worth a second line here. */}
                {!compact ? (
                  failureLine(item) !== null ? (
                    <span className="truncate text-caption text-status-warning-fg">
                      {failureLine(item)}
                    </span>
                  ) : (
                    <span className="truncate text-caption text-text-muted">{railLine(item)}</span>
                  )
                ) : null}
              </span>
            </button>
            {compact ? (
              <StateDot state={item.state} />
            ) : (
              <StateControl
                item={item}
                busy={busyId === item.id}
                actions={actions}
                onSetup={() => onOpen(item.id)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The category chips: one row that scrolls sideways, never four rows of pills
 * (sixteen categories wrapped into a wall at 900px and buried the list). The
 * scrollbar is hidden, so the fade is the only cue that there is more; the
 * `.cand-cats` recipe in candidates.css widens it to 56px and drives it from
 * the scroll position, so it lifts at the end of the row — a static 56px (the
 * first fix) hid the last chip forever. A row that does not overflow gets no
 * fade at all; a mask cannot know that, so it is measured here.
 */
function CategoryRow({ children }: { children: ReactNode }): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    const track = trackRef.current;
    if (row === null || track === null) return;
    const measure = () => {
      row.dataset.overflow = row.scrollWidth > row.clientWidth + 1 ? 'true' : 'false';
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);
  return (
    <ScrollArea
      ref={rowRef}
      axis="x"
      hideScrollbar
      className="cand-cats mt-2.5"
      data-testid="cand-categories"
    >
      <div ref={trackRef} className="flex w-max items-center gap-1 pr-6">
        {children}
      </div>
    </ScrollArea>
  );
}

function DirectoryRow({
  item,
  busy,
  actions,
  onOpen,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  onOpen: () => void;
}): JSX.Element {
  const added = item.state !== 'available';
  return (
    <div className="flex items-center gap-3 px-3 py-2.5" data-testid={`cand-dir-${item.id}`}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
        onClick={onOpen}
        data-testid={`cand-open-${item.id}`}
      >
        <ItemMark item={item} size={36} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* The NAME never yields: at 640 it read "C." beside a full
                "· Developer tools". The category and the reason truncate. */}
            <span className="max-w-full shrink-0 truncate text-body text-text-primary">
              {item.name}
            </span>
            {/* Under ~520px of directory the category goes (cand-dir-cat):
                "Chrome DevTools · … · Ch…" at 640 was three fragments, and
                the reason is the one worth the room. */}
            <span className="cand-dir-cat min-w-0 truncate text-caption text-text-muted">
              · {categoryOf(item)}
            </span>
            {item.kind === 'connector' && item.reason !== undefined ? (
              <span className="min-w-0 truncate text-caption text-status-success-fg">
                · {shortReason(item.reason)}
              </span>
            ) : null}
          </span>
          <span className="truncate text-footnote text-text-muted">{item.description}</span>
        </span>
      </button>
      <div className="flex w-[92px] shrink-0 justify-end">
        {added ? (
          <span className="inline-flex items-center gap-1.5 text-caption text-text-muted">
            <StateDot state={item.state} />
            {item.state === 'builtin'
              ? 'Built in'
              : item.state === 'needs-setup'
                ? 'Needs setup'
                : 'Added'}
          </span>
        ) : (
          <StateControl item={item} busy={busy} actions={actions} onSetup={onOpen} />
        )}
      </div>
    </div>
  );
}

function DirectoryGroup({
  title,
  blurb,
  items,
  children,
}: {
  title: string;
  blurb?: string;
  items: readonly Item[];
  children: (item: Item) => JSX.Element;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="cand-group-head">
        <h2 className="text-body text-text-primary">{title}</h2>
        <span className="text-caption text-text-muted">{items.length}</span>
        {blurb !== undefined ? (
          <span className="text-caption text-text-muted">· {blurb}</span>
        ) : null}
      </div>
      <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-bg-raised">
        {items.map(children)}
      </div>
    </section>
  );
}

function DetailPane({
  item,
  busy,
  actions,
  onBack,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cand-detail">
      <div className="flex shrink-0 items-center px-4 pt-4">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-footnote text-text-secondary hover:bg-bg-hover"
          onClick={onBack}
          data-testid="cand-back"
        >
          <IconChevronLeft size={14} /> Directory
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-6 px-6 pt-3 pb-8">
          <DetailHeader
            item={item}
            busy={busy}
            actions={actions}
            onSetup={() => undefined}
            size={56}
          />
          {item.kind === 'connector' ? (
            <>
              <SetupSection item={item} busy={busy} actions={actions} />
              <ToolsSection item={item} actions={actions} />
              <ReachSection item={item} />
              <AboutSection item={item} />
              <RemoveRow item={item} busy={busy} actions={actions} onRemoved={onBack} />
            </>
          ) : item.kind === 'custom' ? (
            <CustomSection item={item} busy={busy} actions={actions} onRemoved={onBack} />
          ) : (
            <>
              <AboutSection item={item} />
              <SkillBody item={item} actions={actions} />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

type CategoryFilter = 'all' | 'skills' | string;

function ledgerGroups(cat: Catalog): {
  running: Item[];
  setup: Item[];
  off: Item[];
  skills: Item[];
  builtins: Item[];
} {
  const running = cat.items.filter((i) => i.kind !== 'skill' && i.state === 'on' && !failing(i));
  const setup = cat.items.filter(needsAttention);
  const off = cat.items.filter((i) => i.kind !== 'skill' && i.state === 'off');
  const skills = cat.items.filter((i) => i.kind === 'skill' && i.state === 'on');
  const builtins = cat.items.filter((i) => i.state === 'builtin');
  return { running, setup, off, skills, builtins };
}

export function Ledger(): JSX.Element {
  const cat = useCatalog();
  const actions = useActions();
  useWarmTools(cat, actions);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const selected = cat.items.find((i) => i.id === selectedId) ?? null;
  const groups = useMemo(() => ledgerGroups(cat), [cat]);
  const haveCount =
    groups.running.length + groups.setup.length + groups.off.length + groups.skills.length;

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cat.connectors) seen.add(c.connector.category);
    return [...seen].sort((a, b) =>
      (CATEGORY_LABEL[a as keyof typeof CATEGORY_LABEL] ?? a).localeCompare(
        CATEGORY_LABEL[b as keyof typeof CATEGORY_LABEL] ?? b,
      ),
    );
  }, [cat.connectors]);

  const visible = useMemo(
    () =>
      cat.items.filter((i) => {
        if (!matches(i, query)) return false;
        if (category === 'all') return true;
        if (category === 'skills') return i.kind === 'skill';
        return i.kind === 'connector' && i.connector.category === category;
      }),
    [cat.items, query, category],
  );
  const recommended = visible.filter(
    (i) => i.kind === 'connector' && i.reason !== undefined && i.state === 'available',
  );
  const rec = new Set(recommended.map((i) => i.id));
  const tools = visible.filter(
    (i) =>
      (i.kind === 'connector' && i.state !== 'builtin' && !rec.has(i.id)) || i.kind === 'custom',
  );
  const skills = visible.filter((i) => i.kind === 'skill');
  const builtins = visible.filter((i) => i.state === 'builtin');

  const row = (item: Item) => (
    <DirectoryRow
      key={item.id}
      item={item}
      busy={cat.busyId === item.id}
      actions={actions}
      onOpen={() => setSelectedId(item.id)}
    />
  );

  return (
    <div className="flex h-full bg-bg-base" data-testid="cand-ledger">
      <aside
        className="flex shrink-0 flex-col"
        style={{
          // The rail gives way before the directory does: 300 of 640 was half
          // the window for the shorter list.
          width: 'clamp(228px, 30%, 300px)',
          background: 'var(--pd-bg-sidebar)',
          boxShadow: 'inset -1px 0 0 0 var(--pd-border-subtle)',
        }}
        data-testid="cand-ledger-aside"
      >
        <div className="px-4 pt-5 pb-2">
          <h1 className="text-title text-text-primary">Connectors</h1>
          <p className="mt-0.5 text-footnote text-text-muted">
            {haveCount === 0
              ? 'Nothing added yet. Pick from the directory.'
              : `${haveCount} added · ${groups.builtins.length} built in`}
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <LedgerGroup
            title="Running"
            items={groups.running}
            selectedId={selectedId}
            busyId={cat.busyId}
            actions={actions}
            onOpen={setSelectedId}
          />
          <LedgerGroup
            title="Needs setup"
            items={groups.setup}
            selectedId={selectedId}
            busyId={cat.busyId}
            actions={actions}
            onOpen={setSelectedId}
          />
          <LedgerGroup
            title="Off"
            items={groups.off}
            selectedId={selectedId}
            busyId={cat.busyId}
            actions={actions}
            onOpen={setSelectedId}
          />
          <LedgerGroup
            title="Skills on"
            items={groups.skills}
            selectedId={selectedId}
            busyId={cat.busyId}
            actions={actions}
            onOpen={setSelectedId}
          />
          <LedgerGroup
            title="Built in"
            items={groups.builtins}
            selectedId={selectedId}
            busyId={cat.busyId}
            actions={actions}
            onOpen={setSelectedId}
            compact
          />
          <div className="h-3" />
        </ScrollArea>
        <div className="border-border-subtle border-t px-4 py-3">
          <EngineMode mode={cat.mode} actions={actions} compact />
        </div>
      </aside>

      {selected !== null ? (
        <DetailPane
          item={selected}
          busy={cat.busyId === selected.id}
          actions={actions}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <main className="cand-dir flex min-w-0 flex-1 flex-col" data-testid="cand-directory">
          <div className="px-6 pt-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-heading text-text-primary">Directory</h2>
                <p className="mt-0.5 text-footnote text-text-muted">
                  Tools and skills you can add. Each tool runs as a process on this Mac.
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
            <div className="mt-3 flex items-center gap-2">
              <div className="cand-search-wrap">
                <IconSearch size={15} />
                <input
                  type="search"
                  className="cand-search pd-focusable"
                  placeholder="Search the directory"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  data-testid="cand-search"
                />
              </div>
            </div>
            <CategoryRow>
              <button
                type="button"
                className="cand-pill pd-focusable"
                aria-pressed={category === 'all'}
                onClick={() => setCategory('all')}
              >
                All
              </button>
              <button
                type="button"
                className="cand-pill pd-focusable"
                aria-pressed={category === 'skills'}
                onClick={() => setCategory('skills')}
              >
                Skills
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="cand-pill pd-focusable"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                >
                  {CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] ?? c}
                </button>
              ))}
            </CategoryRow>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-6 px-6 pt-4 pb-8">
              {cat.loaded && visible.length === 0 ? (
                <div className="flex flex-col items-start gap-2 py-4" data-testid="cand-empty">
                  <p className="text-body text-text-primary">
                    Nothing matches
                    {query.trim() !== '' ? ` “${query.trim()}”` : ''}
                    {category !== 'all'
                      ? ` in ${
                          category === 'skills'
                            ? 'Skills'
                            : (CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL] ?? category)
                        }`
                      : ''}
                    .
                  </p>
                  <p className="text-footnote text-text-muted">
                    Try another word, or a server the catalog does not know yet with Add MCP server.
                  </p>
                  {/* Shelf+'s empty state is the template: say what to clear, and clear it. */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQuery('');
                      setCategory('all');
                    }}
                    data-testid="cand-clear"
                  >
                    Clear search and category
                  </Button>
                </div>
              ) : null}
              <DirectoryGroup
                title="Recommended for you"
                blurb="apps found on this Mac"
                items={recommended}
              >
                {row}
              </DirectoryGroup>
              <DirectoryGroup title="Tools" items={tools}>
                {row}
              </DirectoryGroup>
              <DirectoryGroup
                title="Skills"
                blurb="playbooks; they touch nothing by themselves"
                items={skills}
              >
                {row}
              </DirectoryGroup>
              <DirectoryGroup title="Built in" blurb="always on" items={builtins}>
                {row}
              </DirectoryGroup>
              <p className="text-caption text-text-muted leading-relaxed">
                Third-party names and marks belong to their owners and identify the tool only.
              </p>
            </div>
          </ScrollArea>
        </main>
      )}

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={(server) => void actions.saveCustom(server)}
      />
    </div>
  );
}
