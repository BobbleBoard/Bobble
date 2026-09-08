/**
 * The Connectors screen — what Bobble can use, and how to give it more.
 *
 * Laid out the way the reference lays out its plugins page: a title, one line
 * under it, a compact search on the title row; "Installed" as a strip of marks;
 * then sections of rows on the bare background, two to a line — mark, name,
 * one line, and one control: "+" to add, "···" once it is yours. No side pane,
 * no filter pills, no cards. A row opens its detail in the list's place, in one
 * readable column with a way back at the top.
 *
 * What the reference could not know about: everything here runs on this Mac
 * as a process, some of it needs a key, some of it can fail to start. Those
 * states are the row's second line, in amber, and the detail leads with the
 * card that fixes them. "Installed ›" opens in place into every row that is
 * yours — needs attention first, then on, then off — with the same menus: the
 * ledger, folded into the page. The section order never changes because a
 * switch was flipped; what you have is indexed by the strip instead.
 *
 * Everything is the real thing: the registry in ~/.pi/desktop/mcp-connectors.json,
 * the skills dir, the mcp mode in settings, and a server's tools listed by
 * starting it once (model.ts).
 */
import type { McpServerConfig } from '@pi-desktop/mcp-lite';
import {
  Button,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconSearch,
  ScrollArea,
  Tooltip,
} from '@pi-desktop/ui';
import { type JSX, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddServerDialog } from './AddServerDialog';
import './connectors.css';
import {
  AboutSection,
  DetailHeader,
  EngineMode,
  FailureCard,
  HowItRunsSection,
  ReachSection,
  RemoveRow,
  SetupSection,
  SkillBody,
  ToolsSection,
  TrySection,
} from './detail-parts';
import { ItemMark, RowControl } from './marks';
import {
  type Actions,
  attentionLine,
  type Catalog,
  CUSTOM_PREFIX,
  cardLine,
  commandLine,
  failing,
  hasKeys,
  type Item,
  isInstalled,
  ledgerLine,
  matches,
  needsAttention,
  SECTIONS,
  type SectionId,
  sectionOf,
  shortReason,
  type Tool,
  useActions,
  useCachedTools,
  useCatalog,
  useWarmTools,
} from './model';

/** Rows a section shows before "See …, and more" — three to a column. */
const CAP = 6;

/** The server a row's Edit and Remove act on; none for a skill or a built-in. */
function serverOf(item: Item): McpServerConfig | undefined {
  return item.kind === 'skill' || item.state === 'builtin' ? undefined : item.server;
}

/** In the Installed list: needs attention, then on, then off, then skills. */
function rank(i: Item): number {
  if (needsAttention(i)) return 0;
  if (i.kind === 'skill') return 3;
  return i.state === 'on' ? 1 : 2;
}

// ───────────────────────────── rows ─────────────────────────────

function Row({
  item,
  line,
  busy,
  actions,
  onOpen,
  onEdit,
  onRemove,
}: {
  item: Item;
  /** The second line; the description when not given. Amber attention lines win. */
  line?: string;
  busy: boolean;
  actions: Actions;
  /** Opens the detail (`keyboard` when it was Enter/Space). */
  onOpen: (keyboard: boolean) => void;
  onEdit?: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const warn = attentionLine(item);
  const text = line ?? cardLine(item);
  return (
    <div
      className="pdc-row"
      data-state={item.state}
      data-attention={warn !== null}
      data-testid={`connector-card-${item.id}`}
    >
      <button
        type="button"
        className="pdc-open"
        aria-label={`Open ${item.name}`}
        data-testid={`connector-open-${item.id}`}
        onClick={(e) => onOpen(e.detail === 0)}
      >
        <ItemMark item={item} size={40} />
        <span className="pdc-row-text">
          <span className="pdc-row-name">{item.name}</span>
          <span className="pdc-row-line" data-warn={warn !== null}>
            {warn ?? (item.state === 'off' ? `Off · ${text}` : text)}
          </span>
        </span>
      </button>
      <RowControl
        item={item}
        busy={busy}
        actions={actions}
        onOpen={() => onOpen(false)}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </div>
  );
}

/** "See Git, Time, and more" — three of the rest as marks, two by name. */
function SeeMore({ rest, onClick }: { rest: readonly Item[]; onClick: () => void }): JSX.Element {
  const names = rest.slice(0, 2).map((i) => i.name);
  const label =
    rest.length > 2
      ? `See ${names.join(', ')}, and more`
      : rest.length === 2
        ? `See ${names[0] ?? ''} and ${names[1] ?? ''}`
        : `See ${names[0] ?? ''}`;
  return (
    <button
      type="button"
      className="pdc-seemore pd-focusable"
      onClick={onClick}
      data-testid="connectors-show-all"
    >
      <span className="pdc-cluster">
        {rest.slice(0, 3).map((i) => (
          <ItemMark key={i.id} item={i} size={22} />
        ))}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function Section({
  id,
  title,
  items,
  capped,
  children,
}: {
  id: string;
  title: string;
  items: readonly Item[];
  /** False while a search is active: the subset was asked for, show all of it. */
  capped: boolean;
  children: (item: Item) => JSX.Element;
}): JSX.Element | null {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  // A group of cap+1 is whole: "See Playwright" for one row is a click
  // charged for one row.
  const overflow = capped && items.length > CAP + 1;
  const shown = overflow && !all ? items.slice(0, CAP) : items;
  const rest = items.slice(shown.length);
  return (
    <section className="pdc-section" data-testid={`connectors-section-${id}`}>
      <h2 className="pdc-h2">{title}</h2>
      <div className="pdc-grid">{shown.map(children)}</div>
      {rest.length > 0 ? (
        <SeeMore rest={rest} onClick={() => setAll(true)} />
      ) : overflow ? (
        <button
          type="button"
          className="pdc-seemore pd-focusable"
          onClick={() => setAll(false)}
          data-testid="connectors-show-fewer"
        >
          Show fewer
        </button>
      ) : null}
    </section>
  );
}

// ───────────────────────────── installed ─────────────────────────────

/** A mark in the strip: the thing itself, with an amber dot when it needs attention. */
function Tile({ item, onOpen }: { item: Item; onOpen: () => void }): JSX.Element {
  const warn = attentionLine(item);
  const label =
    warn !== null
      ? `${item.name} · ${warn}`
      : item.state === 'off'
        ? `${item.name} · off`
        : item.name;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="pdc-tile pd-focusable"
        data-state={item.state}
        aria-label={`Open ${item.name}`}
        data-testid={`connector-tile-${item.id}`}
        onClick={onOpen}
      >
        <ItemMark item={item} size={40} />
        {warn !== null ? <span className="pdc-tile-dot" aria-hidden="true" /> : null}
      </button>
    </Tooltip>
  );
}

/**
 * "Installed ›": a strip of marks — what you added, and the one way to add a
 * server of your own at its end. Open, it is every one of those as a row with
 * its menu, and under them what is built in (always on, nothing to press).
 * The built-ins stay out of the strip: seven of them in front of the one
 * thing you added is a wall, not an index.
 */
function Installed({
  items,
  builtins,
  open,
  onToggle,
  onOpen,
  onAdd,
  addRef,
  row,
}: {
  items: readonly Item[];
  builtins: readonly Item[];
  open: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  addRef: RefObject<HTMLButtonElement | null>;
  row: (item: Item, line?: string) => JSX.Element;
}): JSX.Element {
  const attention = items.filter(needsAttention).length;
  return (
    <section className="pdc-section pdc-installed" data-testid="connectors-installed">
      <div className="pdc-h2-row">
        <button
          type="button"
          className="pdc-h2-btn pd-focusable"
          aria-expanded={open}
          onClick={onToggle}
          data-testid="connectors-installed-toggle"
        >
          Installed
          <span className="pdc-chev">
            <IconChevronRight size={16} />
          </span>
        </button>
        {attention > 0 ? (
          <span className="pdc-attention" data-testid="connectors-attention">
            {attention} {attention === 1 ? 'needs' : 'need'} attention
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="pdc-installed-open" data-testid="connectors-installed-list">
          {items.length > 0 ? (
            <div className="pdc-grid">{items.map((i) => row(i, ledgerLine(i)))}</div>
          ) : (
            <p className="pdc-quiet" data-testid="connectors-installed-empty">
              Nothing added yet. Anything you add below appears here, with its switch.
            </p>
          )}
          {builtins.length > 0 ? (
            <>
              <p className="pdc-label">Built in · always on</p>
              <div className="pdc-grid">{builtins.map((i) => row(i, ledgerLine(i)))}</div>
            </>
          ) : null}
          <button
            ref={addRef}
            type="button"
            className="pdc-addrow pd-focusable"
            onClick={onAdd}
            data-testid="connectors-add-server"
          >
            <span className="pdc-tile pdc-tile--add" aria-hidden="true">
              <IconPlus size={18} />
            </span>
            <span className="pdc-row-text">
              <span className="pdc-row-name">Add a server</span>
              <span className="pdc-row-line">
                One you run yourself, that the catalog does not know
              </span>
            </span>
          </button>
        </div>
      ) : (
        <div className="pdc-strip">
          {items.map((i) => (
            <Tile key={i.id} item={i} onOpen={() => onOpen(i.id)} />
          ))}
          <Tooltip label="Add a server you run yourself">
            <button
              ref={addRef}
              type="button"
              className="pdc-tile pdc-tile--add pd-focusable"
              aria-label="Add a server"
              onClick={onAdd}
              data-testid="connectors-add-server"
            >
              <IconPlus size={18} />
            </button>
          </Tooltip>
          {items.length === 0 ? (
            <span className="pdc-quiet self-center" data-testid="connectors-installed-empty">
              What you add appears here. The built-in tools below already work.
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── grouping ─────────────────────────────

interface Groups {
  readonly recommended: Item[];
  readonly customs: Item[];
  readonly sections: ReadonlyArray<{ id: SectionId; title: string; items: Item[] }>;
  readonly skills: Item[];
  readonly builtins: Item[];
}

/**
 * A row appears once. What the /Applications scan recommends is its own
 * section and is left out of its category; a hand-added server is under
 * "Added by you"; a built-in under "Built in". Within a section the catalog's
 * own order holds.
 */
function groupItems(visible: readonly Item[]): Groups {
  const recommended = visible.filter(
    (i) => i.kind === 'connector' && i.reason !== undefined && i.state === 'available',
  );
  const rec = new Set(recommended.map((i) => i.id));
  const bySection = new Map<SectionId, Item[]>();
  for (const i of visible) {
    if (i.kind !== 'connector' || i.state === 'builtin' || rec.has(i.id)) continue;
    const id = sectionOf(i.connector.category);
    const list = bySection.get(id);
    if (list === undefined) bySection.set(id, [i]);
    else list.push(i);
  }
  return {
    recommended,
    customs: visible.filter((i) => i.kind === 'custom'),
    sections: SECTIONS.map((s) => ({ id: s.id, title: s.title, items: bySection.get(s.id) ?? [] })),
    skills: visible.filter((i) => i.kind === 'skill'),
    builtins: visible.filter((i) => i.kind === 'connector' && i.state === 'builtin'),
  };
}

// ───────────────────────────── the detail ─────────────────────────────

/** The tools a detail's example is derived from: the cached list, else the catalog's. */
function useToolsFor(item: Item): readonly Tool[] {
  const serverId =
    item.kind === 'connector' ? item.id : item.kind === 'custom' ? item.server.id : '';
  const cmd = item.kind !== 'skill' && item.server !== undefined ? commandLine(item.server) : '';
  const cached = useCachedTools(serverId, cmd);
  if (cached !== null) return cached.tools;
  return item.kind === 'connector' ? (item.connector.tools ?? []) : [];
}

function Detail({
  item,
  busy,
  actions,
  cat,
  armRemove,
  backRef,
  onClose,
  onSearch,
  onEdit,
  onTry,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  cat: Catalog;
  /** Opened from a row's "Remove…": the confirm is already armed. */
  armRemove: boolean;
  backRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSearch: (query: string) => void;
  onEdit: (server: McpServerConfig) => void;
  onTry?: (prompt: string) => void;
}): JSX.Element {
  // A saved key that turned out wrong: "Change the key" reopens the setup
  // card over the saved value — and a detail opened on a server already in
  // that state opens with the card already there, since the card is the fix.
  const [editKeys, setEditKeys] = useState(() => failing(item) && hasKeys(item));
  const [removeArmed, setRemoveArmed] = useState(armRemove);
  const tools = useToolsFor(item);
  const server = serverOf(item);
  const edit = server !== undefined ? () => onEdit(server) : undefined;
  const arm = server !== undefined ? () => setRemoveArmed(true) : undefined;
  return (
    <ScrollArea className="pdc-detail" data-testid="connector-detail">
      <div className="pdc-col pdc-col--detail">
        <button
          ref={backRef}
          type="button"
          className="pdc-back pd-focusable"
          onClick={onClose}
          data-testid="connectors-back"
        >
          <IconChevronLeft size={16} /> Connectors
        </button>
        <DetailHeader
          item={item}
          busy={busy}
          actions={actions}
          tools={tools}
          onEdit={edit}
          onRemove={arm}
          onTry={onTry}
        />
        <div className="pdc-detail-body">
          {item.kind === 'connector' ? (
            <>
              <FailureCard
                item={item}
                actions={actions}
                onEditKeys={hasKeys(item) && !editKeys ? () => setEditKeys(true) : undefined}
                onEdit={edit}
              />
              <SetupSection
                item={item}
                busy={busy}
                actions={actions}
                open={editKeys}
                onClose={() => setEditKeys(false)}
              />
              <TrySection item={item} tools={tools} />
              <ToolsSection item={item} actions={actions} mode={cat.mode} split />
              <ReachSection
                item={item}
                onChangeKey={hasKeys(item) && !editKeys ? () => setEditKeys(true) : undefined}
              />
              <AboutSection item={item} onSearch={onSearch} />
              <RemoveRow
                item={item}
                busy={busy}
                actions={actions}
                onRemoved={onClose}
                armed={removeArmed}
                onArm={setRemoveArmed}
              />
            </>
          ) : item.kind === 'custom' ? (
            <>
              <FailureCard item={item} actions={actions} onEdit={edit} />
              <TrySection item={item} tools={tools} />
              <ToolsSection item={item} actions={actions} mode={cat.mode} split />
              <HowItRunsSection item={item} onEdit={() => onEdit(item.server)} />
              <RemoveRow
                item={item}
                busy={busy}
                actions={actions}
                onRemoved={onClose}
                armed={removeArmed}
                onArm={setRemoveArmed}
              />
            </>
          ) : (
            <>
              <TrySection item={item} tools={tools} />
              <AboutSection item={item} onSearch={onSearch} />
              <SkillBody item={item} actions={actions} />
            </>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

// ───────────────────────────── the screen ─────────────────────────────

export function ConnectorsScreen({
  onTryInChat,
}: {
  /** Start a new chat with this prompt ready to send. */
  onTryInChat?: (prompt: string) => void;
}): JSX.Element {
  const cat = useCatalog();
  const actions = useActions();
  useWarmTools(cat, actions);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [armRemove, setArmRemove] = useState(false);
  const [installedOpen, setInstalledOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusBackOnOpen = useRef(false);

  const selected = cat.items.find((i) => i.id === selectedId) ?? null;
  const searching = query.trim() !== '';
  const visible = useMemo(() => cat.items.filter((i) => matches(i, query)), [cat.items, query]);
  const groups = useMemo(() => groupItems(visible), [visible]);
  const installed = useMemo(
    () => cat.items.filter(isInstalled).sort((a, b) => rank(a) - rank(b)),
    [cat.items],
  );
  const builtins = useMemo(() => cat.items.filter((i) => i.state === 'builtin'), [cat.items]);

  // Click = open; never a toggle. A person who clicks the thing they are
  // reading about must not make it vanish.
  const open = useCallback((id: string, opts: { keyboard?: boolean; arm?: boolean } = {}) => {
    focusBackOnOpen.current = opts.keyboard === true;
    setArmRemove(opts.arm === true);
    setSelectedId(id);
  }, []);
  const close = useCallback(() => {
    const was = selectedId;
    setSelectedId(null);
    if (was !== null) {
      // The keyboard goes back to the row it came from.
      requestAnimationFrame(() => {
        const btn = rootRef.current?.querySelector<HTMLElement>(
          `[data-testid="connector-open-${CSS.escape(was)}"]`,
        );
        btn?.focus({ preventScroll: true });
      });
    }
  }, [selectedId]);

  // Opened from the keyboard: the way back is reachable at once.
  useEffect(() => {
    if (selectedId === null || !focusBackOnOpen.current) return;
    focusBackOnOpen.current = false;
    backRef.current?.focus();
  }, [selectedId]);

  // Escape closes the detail — from anywhere but a dialog or a menu. On the
  // WINDOW, not the screen's root: after the key card saves, the field that
  // had focus is gone and the keyboard is on <body>, whose keydown never
  // reaches a listener inside the screen. MEASURED: Escape did nothing after
  // "Save and turn on" until the next click.
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || addOpen || editing !== null) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="menu"]') != null) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, addOpen, editing, close]);

  // The category link in a detail: back to the list, searching for it.
  const searchFor = (q: string) => {
    setQuery(q);
    setSelectedId(null);
  };

  /** After Add or Edit: the detail opens on it. */
  const saved = (server: McpServerConfig, listed?: readonly Tool[]) => {
    void actions.saveServer(server, listed).then(() => {
      setArmRemove(false);
      setSelectedId(catalogIds(cat).has(server.id) ? server.id : `${CUSTOM_PREFIX}${server.id}`);
    });
  };

  const row = (item: Item, line?: string) => {
    const server = serverOf(item);
    return (
      <Row
        key={item.id}
        item={item}
        line={line}
        busy={cat.busyId === item.id}
        actions={actions}
        onOpen={(keyboard) => open(item.id, { keyboard })}
        onEdit={server !== undefined ? () => setEditing(server) : undefined}
        onRemove={server !== undefined ? () => open(item.id, { arm: true }) : undefined}
      />
    );
  };
  /** A recommendation's line is why it is here: "Xcode is installed". */
  const recommendedRow = (item: Item) =>
    row(
      item,
      item.kind === 'connector' && item.reason !== undefined ? shortReason(item.reason) : undefined,
    );

  return (
    <div
      ref={rootRef}
      /*
       * `min-h-0 flex-1`, not `h-full` alone: the shell's main surface is a
       * flex column with the top bar above this, and a 100%-tall child of it
       * is the top bar's height too tall — MEASURED: the page's footer sat
       * 40px below the window, and the document itself became scrollable.
       */
      className="pdc pd-settings-enter flex h-full min-h-0 flex-1 flex-col bg-bg-base"
      data-testid="connectors-screen"
      data-detail={selected !== null}
    >
      {/* The list stays mounted under an open detail — hidden, not unmounted —
          so it keeps its scroll position for the way back. */}
      <ScrollArea
        className="pdc-list"
        data-hidden={selected !== null}
        data-testid="connectors-list"
      >
        <div className="pdc-col">
          <div className="pdc-head">
            <div className="min-w-0">
              <h1 className="pdc-title">Connectors</h1>
              <p className="pdc-sub" data-testid="connectors-intro">
                Tools and skills Bobble can use. Everything here runs on this Mac.
              </p>
            </div>
            <div className="pdc-search-wrap">
              <IconSearch size={15} />
              <input
                type="search"
                className="pdc-search pd-focusable"
                placeholder="Search connectors"
                aria-label="Search connectors"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="connectors-search"
              />
            </div>
          </div>

          {!cat.loaded ? <p className="pdc-quiet pdc-section">Loading…</p> : null}

          {cat.loaded && !searching ? (
            <Installed
              items={installed}
              builtins={builtins}
              open={installedOpen}
              onToggle={() => setInstalledOpen((v) => !v)}
              onOpen={(id) => open(id)}
              onAdd={() => setAddOpen(true)}
              addRef={addButtonRef}
              row={row}
            />
          ) : null}

          {cat.loaded && searching && visible.length === 0 ? (
            <div className="pdc-section pdc-empty" data-testid="connectors-empty">
              <p className="pdc-row-name">Nothing matches “{query.trim()}”.</p>
              <p className="pdc-quiet">
                Try another word — or add a server the catalog does not know yet.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setQuery('')}
                  data-testid="connectors-clear"
                >
                  Clear the search
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}>
                  <IconPlus size={14} /> Add a server
                </Button>
              </div>
            </div>
          ) : null}

          <Section
            id="recommended"
            title="Recommended for you"
            items={groups.recommended}
            capped={!searching}
          >
            {recommendedRow}
          </Section>
          <Section id="custom" title="Added by you" items={groups.customs} capped={!searching}>
            {(i) => row(i)}
          </Section>
          {groups.sections.map((s) => (
            <Section key={s.id} id={s.id} title={s.title} items={s.items} capped={!searching}>
              {(i) => row(i)}
            </Section>
          ))}
          <Section id="skills" title="Skills" items={groups.skills} capped={!searching}>
            {(i) => row(i)}
          </Section>
          <Section id="builtin" title="Built in" items={groups.builtins} capped={!searching}>
            {(i) => row(i)}
          </Section>

          {cat.loaded ? (
            <div className="pdc-foot">
              <EngineMode mode={cat.mode} actions={actions} />
              <p
                className="text-caption text-text-muted leading-relaxed"
                data-testid="connectors-disclaimer"
              >
                Third-party names and marks belong to their owners and identify the tool only.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {/* Keyed: a swap remounts the detail and runs its entrance again. */}
      {selected !== null ? (
        <Detail
          key={selected.id}
          item={selected}
          busy={cat.busyId === selected.id}
          actions={actions}
          cat={cat}
          armRemove={armRemove}
          backRef={backRef}
          onClose={close}
          onSearch={searchFor}
          onEdit={(server) => setEditing(server)}
          onTry={onTryInChat}
        />
      ) : null}

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={saved}
        existingIds={cat.serverIds}
        onTest={actions.probe}
        returnFocusTo={addButtonRef}
      />
      <AddServerDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        onAdd={saved}
        initial={editing ?? undefined}
        existingIds={cat.serverIds}
        onTest={actions.probe}
        returnFocusTo={selected !== null ? backRef : addButtonRef}
      />
    </div>
  );
}

/** The catalog's ids: a saved server with one of them is that catalog item, not a custom one. */
function catalogIds(cat: Catalog): ReadonlySet<string> {
  return new Set(cat.connectors.map((c) => c.id));
}
