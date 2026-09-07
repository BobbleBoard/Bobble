/**
 * CANDIDATE 3 — "Reach".
 *
 * The position: on an offline, local app the question about a connector is
 * not "is it popular?" but "what can this reach on my computer?". So the
 * catalog is grouped by reach — Your Mac / Apps on this Mac / Accounts and
 * services / Local tools — every row says in one sentence what it touches,
 * and a detail expands IN PLACE (the model hub's family-card move) with the
 * tools split into what looks things up and what changes things. Skills sit
 * at the end as playbooks, framed by the same question: they touch nothing.
 */
import { Button, IconChevronDown, IconPlus, IconSearch, ScrollArea } from '@pi-desktop/ui';
import {
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AddServerDialog } from '../../connectors/AddServerDialog';
import { cx } from '../../onboarding/cx';
import {
  type Actions,
  type Item,
  matches,
  REACH_BLURB,
  REACH_TITLE,
  type Reach as ReachKey,
  reachLine,
  reachOf,
  useActions,
  useCatalog,
} from './data';
import {
  AboutSection,
  CustomSection,
  EngineMode,
  ReachSection,
  RemoveRow,
  SetupSection,
  SkillBody,
  ToolsSection,
} from './detail-parts';
import { ItemMark, OfficialMark, StateControl } from './marks';

/** Measured-height expansion: content mounts only while open (so nothing spawns for a closed row). */
function Expand({ open, children }: { open: boolean; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [height, setHeight] = useState<number | 'auto'>(open ? 'auto' : 0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const el = ref.current;
    if (el === null) {
      setMounted(false);
      return;
    }
    setHeight(el.scrollHeight);
    const raf = requestAnimationFrame(() => setHeight(0));
    const t = window.setTimeout(() => setMounted(false), 340);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const el = ref.current;
    if (el === null) return;
    setHeight(el.scrollHeight);
    const t = window.setTimeout(() => setHeight('auto'), 340);
    return () => window.clearTimeout(t);
  }, [open, mounted]);

  if (!mounted) return null;
  return (
    <div className="cand-expand" style={{ height }}>
      <div ref={ref}>{children}</div>
    </div>
  );
}

function Row({
  item,
  open,
  busy,
  actions,
  onToggle,
  line,
}: {
  item: Item;
  open: boolean;
  busy: boolean;
  actions: Actions;
  onToggle: () => void;
  line: string;
}): JSX.Element {
  return (
    <div data-testid={`cand-reach-row-${item.id}`} data-open={open}>
      <div className={cx('flex items-center gap-3 px-3 py-2.5', open && 'bg-bg-hover')}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
          onClick={onToggle}
          data-testid={`cand-open-${item.id}`}
        >
          <ItemMark item={item} size={36} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-body text-text-primary">{item.name}</span>
              {item.kind === 'connector' &&
              item.connector.official &&
              item.connector.firstParty !== true ? (
                <OfficialMark />
              ) : null}
              {item.kind === 'connector' && item.reason !== undefined ? (
                <span className="truncate text-caption text-status-success-fg">
                  · {item.reason}
                </span>
              ) : null}
            </span>
            <span className="truncate text-footnote text-text-muted">{line}</span>
          </span>
          <span
            className={cx('inline-flex text-text-muted transition-transform', open && 'rotate-180')}
            style={{ transitionDuration: 'var(--pd-duration-base)' }}
          >
            <IconChevronDown size={14} />
          </span>
        </button>
        <div className="flex w-[92px] shrink-0 justify-end">
          <StateControl item={item} busy={busy} actions={actions} onSetup={onToggle} />
        </div>
      </div>
      <Expand open={open}>
        <div className="cand-expand-body flex flex-col gap-5">
          {/* The row above already shows the mark, the name and the control;
              repeating them here was a second header for the same thing. */}
          {/* A skill's row already shows its description; a tool's row shows
              its reach line instead, so only a tool needs the description here. */}
          {item.kind === 'skill' ? (
            <div className="border-border-subtle border-t" />
          ) : (
            <div className="border-border-subtle border-t pt-4">
              <p className="text-footnote text-text-secondary">{item.description}</p>
            </div>
          )}
          {item.kind === 'connector' ? (
            <>
              <SetupSection item={item} busy={busy} actions={actions} />
              <ReachSection item={item} showGroup={false} />
              <ToolsSection item={item} actions={actions} split />
              <AboutSection item={item} />
              <RemoveRow item={item} busy={busy} actions={actions} onRemoved={onToggle} />
            </>
          ) : item.kind === 'custom' ? (
            <CustomSection item={item} busy={busy} actions={actions} onRemoved={onToggle} />
          ) : (
            <>
              <AboutSection item={item} />
              <SkillBody item={item} actions={actions} />
            </>
          )}
        </div>
      </Expand>
    </div>
  );
}

function Group({
  id,
  title,
  blurb,
  items,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  items: readonly Item[];
  children: (item: Item) => JSX.Element;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section data-testid={`cand-reach-group-${id}`}>
      <div className="mb-2 flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-body text-text-primary">{title}</h2>
          <span className="text-caption text-text-muted">{items.length}</span>
        </div>
        <p className="text-caption text-text-muted">{blurb}</p>
      </div>
      <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-raised">
        {items.map(children)}
      </div>
    </section>
  );
}

const ORDER: ReachKey[] = ['mac-data', 'mac-app', 'account', 'local'];

const STATE_RANK: Record<Item['state'], number> = {
  'needs-setup': 0,
  on: 1,
  builtin: 2,
  off: 3,
  available: 4,
};

export function Reach(): JSX.Element {
  const cat = useCatalog();
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const visible = useMemo(() => cat.items.filter((i) => matches(i, query)), [cat.items, query]);

  const byReach = useMemo(() => {
    const out = new Map<ReachKey, Item[]>(ORDER.map((k) => [k, []]));
    for (const i of visible) {
      if (i.kind !== 'connector') continue;
      out.get(reachOf(i.connector))?.push(i);
    }
    for (const list of out.values()) {
      list.sort((a, b) => {
        const ra = a.kind === 'connector' && a.reason !== undefined ? -1 : STATE_RANK[a.state];
        const rb = b.kind === 'connector' && b.reason !== undefined ? -1 : STATE_RANK[b.state];
        return ra - rb;
      });
    }
    return out;
  }, [visible]);
  const customs = visible.filter((i) => i.kind === 'custom');
  const skills = visible.filter((i) => i.kind === 'skill');

  const row = (item: Item) => (
    <Row
      key={item.id}
      item={item}
      open={openId === item.id}
      busy={cat.busyId === item.id}
      actions={actions}
      onToggle={() => setOpenId((cur) => (cur === item.id ? null : item.id))}
      line={
        item.kind === 'connector'
          ? reachLine(item.connector, item.server)
          : item.kind === 'custom'
            ? `Runs ${item.server.command} · added by you`
            : item.description
      }
    />
  );

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="cand-reach">
      <div className="mx-auto w-full max-w-[920px] px-8 pt-5 pb-3">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-title text-text-primary">Connectors</h1>
            <p className="mt-0.5 text-footnote text-text-muted">
              Grouped by what each one can reach. Everything runs on this Mac; nothing leaves it
              unless you hand a tool a key.
            </p>
          </div>
          {/* shrink-0: MEASURED under claude-light, the flex squeeze took the
              IconPlus from 14px to 6.9px wide — a dot — before the text wrapped. */}
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
              placeholder="Search by name, or by what it touches"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="cand-search"
            />
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6 px-8 pt-2 pb-8">
          {cat.loaded && visible.length === 0 ? (
            <p className="text-footnote text-text-muted" data-testid="cand-empty">
              Nothing matches.
            </p>
          ) : null}
          <Group
            id="custom"
            title="Added by you"
            blurb="Servers you configured by hand. Bobble knows only the command you gave it."
            items={customs}
          >
            {row}
          </Group>
          {ORDER.map((k) => (
            <Group
              key={k}
              id={k}
              title={REACH_TITLE[k]}
              blurb={REACH_BLURB[k]}
              items={byReach.get(k) ?? []}
            >
              {row}
            </Group>
          ))}
          <Group
            id="skills"
            title="Playbooks"
            blurb="Skills: instructions the agent reads. They touch nothing by themselves; they change how it works."
            items={skills}
          >
            {row}
          </Group>
          <div className="flex flex-col gap-4 border-border-subtle border-t pt-5">
            <EngineMode mode={cat.mode} actions={actions} />
            <p className="text-caption text-text-muted leading-relaxed">
              Third-party names and marks belong to their owners and identify the tool only.
            </p>
          </div>
        </div>
      </ScrollArea>
      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={(server) => void actions.saveCustom(server)}
      />
    </div>
  );
}
