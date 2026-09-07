/**
 * CANDIDATE 1 — "Shelf".
 *
 * The position: ONE surface. A person does not think "is this an MCP server or
 * a markdown playbook?" — they think "what can my agent use, and what can I
 * add?". So tools and skills are one catalog with one search; the kind is a
 * FILTER, not a tab that hides half the shelf. What is on right now is a strip
 * of marks at the top (the one good idea in ChatGPT's Installed row), and a
 * detail slides in beside the list instead of replacing it.
 */
import { Button, IconClose, IconPlus, IconSearch, ScrollArea, Tooltip } from '@pi-desktop/ui';
import { type JSX, useMemo, useState } from 'react';
import { AddServerDialog } from '../../connectors/AddServerDialog';
import { type Actions, type Item, matches, shortReason, useActions, useCatalog } from './data';
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
import { ItemGlyph, ItemMark, OfficialMark, STATE_LABEL, StateControl, StateDot } from './marks';

type Filter = 'all' | 'tools' | 'skills' | 'on' | 'setup';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'tools', label: 'Tools' },
  { id: 'skills', label: 'Skills' },
  { id: 'on', label: 'On' },
  { id: 'setup', label: 'Needs setup' },
];

function passes(filter: Filter, item: Item): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'tools':
      return item.kind !== 'skill';
    case 'skills':
      return item.kind === 'skill';
    case 'on':
      return item.state === 'on' || item.state === 'builtin';
    case 'setup':
      return item.state === 'needs-setup';
  }
}

function ShelfCard({
  item,
  selected,
  busy,
  actions,
  onOpen,
}: {
  item: Item;
  selected: boolean;
  busy: boolean;
  actions: Actions;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="cand-card" data-selected={selected} data-testid={`cand-card-${item.id}`}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
        data-testid={`cand-open-${item.id}`}
        onClick={onOpen}
      >
        <ItemMark item={item} size={40} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* The name never yields to the reason: it is what the card is. */}
            <span className="shrink-0 text-body text-text-primary">{item.name}</span>
            {item.kind === 'connector' &&
            item.connector.official &&
            item.connector.firstParty !== true ? (
              <OfficialMark />
            ) : null}
            {item.kind === 'connector' &&
            item.reason !== undefined &&
            item.state === 'available' ? (
              <span className="min-w-0 truncate text-caption text-status-success-fg">
                · {shortReason(item.reason)}
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-footnote text-text-muted leading-snug">
            {item.description}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center self-start pt-0.5">
        <StateControl item={item} busy={busy} actions={actions} onSetup={onOpen} />
      </div>
    </div>
  );
}

function Section({
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
    <section data-testid={`cand-shelf-section-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="cand-group-head">
        <h2 className="text-body text-text-primary">{title}</h2>
        <span className="text-caption text-text-muted">{items.length}</span>
        {blurb !== undefined ? (
          <span className="text-caption text-text-muted">· {blurb}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">{items.map(children)}</div>
    </section>
  );
}

function Sheet({
  item,
  busy,
  actions,
  onClose,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside className="cand-sheet" data-testid="cand-sheet">
      <div className="flex shrink-0 items-center justify-end px-3 pt-3">
        <button
          type="button"
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={onClose}
          data-testid="cand-back"
        >
          <IconClose size={14} />
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-5 pt-2 pb-6">
          <DetailHeader item={item} busy={busy} actions={actions} onSetup={() => undefined} />
          {item.kind === 'connector' ? (
            <>
              <SetupSection item={item} busy={busy} actions={actions} />
              <ToolsSection item={item} actions={actions} />
              <ReachSection item={item} />
              <AboutSection item={item} />
              <RemoveRow item={item} busy={busy} actions={actions} onRemoved={onClose} />
            </>
          ) : item.kind === 'custom' ? (
            <CustomSection item={item} busy={busy} actions={actions} onRemoved={onClose} />
          ) : (
            <>
              <AboutSection item={item} />
              <SkillBody item={item} actions={actions} />
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

/** The strip: everything the agent can use right now, as marks. */
function OnNow({
  items,
  selectedId,
  onOpen,
}: {
  items: readonly Item[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  // Built-ins sit after a hairline: always on, never something you chose.
  const firstBuiltin = items.findIndex((i) => i.state === 'builtin');
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="cand-on-now">
      {items.map((item, index) => (
        <Tooltip key={item.id} label={`${item.name} · ${STATE_LABEL[item.state]}`}>
          <button
            type="button"
            className="cand-tile"
            aria-label={item.name}
            aria-pressed={item.id === selectedId}
            onClick={() => onOpen(item.id)}
            data-testid={`cand-tile-${item.id}`}
            style={index === firstBuiltin && index > 0 ? { marginLeft: 12 } : undefined}
            data-builtin={item.state === 'builtin' ? 'true' : undefined}
          >
            <ItemGlyph item={item} size={22} />
            <StateDot state={item.state} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function orderTools(visible: readonly Item[]): {
  recommended: Item[];
  tools: Item[];
  builtins: Item[];
  skills: Item[];
} {
  const recommended = visible.filter(
    (i) => i.kind === 'connector' && i.reason !== undefined && i.state === 'available',
  );
  const rec = new Set(recommended.map((i) => i.id));
  const customs = visible.filter((i) => i.kind === 'custom');
  const connectors = visible.filter(
    (i) => i.kind === 'connector' && i.state !== 'builtin' && !rec.has(i.id),
  );
  // Official servers before community ones, catalog order otherwise.
  const official = connectors.filter((i) => i.kind === 'connector' && i.connector.official);
  const community = connectors.filter((i) => i.kind === 'connector' && !i.connector.official);
  return {
    recommended,
    tools: [...customs, ...official, ...community],
    builtins: visible.filter((i) => i.kind === 'connector' && i.state === 'builtin'),
    skills: visible.filter((i) => i.kind === 'skill'),
  };
}

export function Shelf(): JSX.Element {
  const cat = useCatalog();
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const selected = cat.items.find((i) => i.id === selectedId) ?? null;
  const onNow = useMemo(
    () =>
      [...cat.items]
        .filter((i) => i.state === 'on' || i.state === 'needs-setup' || i.state === 'builtin')
        .sort((a, b) => (a.state === 'builtin' ? 1 : 0) - (b.state === 'builtin' ? 1 : 0)),
    [cat.items],
  );
  const visible = useMemo(
    () => cat.items.filter((i) => matches(i, query) && passes(filter, i)),
    [cat.items, query, filter],
  );
  const groups = useMemo(() => orderTools(visible), [visible]);
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, tools: 0, skills: 0, on: 0, setup: 0 };
    for (const i of cat.items) {
      for (const f of FILTERS) if (passes(f.id, i)) out[f.id] += 1;
    }
    return out;
  }, [cat.items]);

  const card = (item: Item) => (
    <ShelfCard
      key={item.id}
      item={item}
      selected={item.id === selectedId}
      busy={cat.busyId === item.id}
      actions={actions}
      onOpen={() => setSelectedId(item.id)}
    />
  );

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="cand-shelf">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-[1040px] px-8 pt-5">
            <div className="flex items-start justify-between gap-6">
              <div>
                <h1 className="text-title text-text-primary">Connectors</h1>
                <p className="mt-0.5 text-footnote text-text-muted">
                  Tools and skills your agent can use. Everything here runs on this Mac.
                </p>
              </div>
              {/* shrink-0: a squeezed button squeezes its icon first — under the
                  claude flavour's wider type the plus collapsed to a 7px dot. */}
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

            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-caption text-text-muted">On now</span>
                <span className="text-caption text-text-muted">{onNow.length}</span>
              </div>
              <OnNow items={onNow} selectedId={selectedId} onOpen={setSelectedId} />
            </div>

            <div className="mt-4 flex items-center gap-2">
              <div className="cand-search-wrap">
                <IconSearch size={15} />
                <input
                  type="search"
                  className="cand-search pd-focusable"
                  placeholder="Search tools and skills"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  data-testid="cand-search"
                />
              </div>
              <div className="flex items-center gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="cand-pill pd-focusable"
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    data-testid={`cand-filter-${f.id}`}
                  >
                    {f.label}
                    <span className="cand-pill-count">{counts[f.id]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-8 pt-5 pb-8">
              {!cat.loaded ? (
                <p className="text-footnote text-text-muted">Loading…</p>
              ) : visible.length === 0 ? (
                <p className="text-footnote text-text-muted" data-testid="cand-empty">
                  Nothing matches.
                </p>
              ) : null}
              <Section
                title="Recommended for you"
                blurb="apps found on this Mac"
                items={groups.recommended}
              >
                {card}
              </Section>
              <Section title="Tools" blurb="each one runs as a local process" items={groups.tools}>
                {card}
              </Section>
              <Section
                title="Skills"
                blurb="playbooks the agent reads; they touch nothing by themselves"
                items={groups.skills}
              >
                {card}
              </Section>
              <Section title="Built in" blurb="always on, no server" items={groups.builtins}>
                {card}
              </Section>
              <div className="flex flex-col gap-4 border-border-subtle border-t pt-5">
                <EngineMode mode={cat.mode} actions={actions} />
                <p className="text-caption text-text-muted leading-relaxed">
                  Third-party names and marks belong to their owners and identify the tool only.
                </p>
              </div>
            </div>
          </ScrollArea>
        </div>

        {selected !== null ? (
          <Sheet
            item={selected}
            busy={cat.busyId === selected.id}
            actions={actions}
            onClose={() => setSelectedId(null)}
          />
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
