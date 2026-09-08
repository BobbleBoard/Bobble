/**
 * Marks, dots and the one control every row carries.
 *
 * A connector shows its real brand mark (ConnectorIcon); a custom server shows
 * a prompt glyph; a skill shows a glyph of its own drawn in the same 24-grid
 * line style as the catalog's neutral marks — so a skills list does not
 * become the wall of identical icons the reference directories turned into.
 *
 * No "official" mark anywhere on a row: a badge on 25 of 37 rows is texture.
 * The exception — a community server for a vendor's product — is named in the
 * detail's About section, where it is information.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconMore,
  IconPlus,
  Spinner,
  Tooltip,
} from '@pi-desktop/ui';
import type { JSX, ReactNode } from 'react';
import { ConnectorIcon } from './ConnectorIcon';
import {
  type Actions,
  commandLine,
  failing,
  hasKeys,
  type Item,
  type ItemState,
  needsConfig,
  serverIdOf,
} from './model';

function Glyph({ size, children }: { size: number; children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** One glyph per skill, authored once. A skill the map does not know falls back to its category. */
function SkillOwnGlyph({ id, size }: { id: string; size: number }): JSX.Element | null {
  switch (id) {
    case 'code-review':
      return (
        <Glyph size={size}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
          <path d="M7.75 10.75l1.75 1.75 3.25-3.5" />
        </Glyph>
      );
    case 'data-analysis':
      return (
        <Glyph size={size}>
          <path d="M5 19V11" />
          <path d="M10.5 19V5" />
          <path d="M16 19v-7" />
          <path d="M3 19h18" />
        </Glyph>
      );
    case 'debugging':
      return (
        <Glyph size={size}>
          <circle cx="12" cy="13" r="5.5" />
          <path d="M12 7.5v11" />
          <path d="M6.5 13H4M20 13h-2.5" />
          <path d="M7.5 9.5L5.5 7.5M16.5 9.5l2-2" />
          <path d="M7.5 16.5l-2 2M16.5 16.5l2 2" />
        </Glyph>
      );
    case 'doc-coauthoring':
      return (
        <Glyph size={size}>
          <path d="M8 3h7l4 4v10H8z" />
          <path d="M15 3v4h4" />
          <path d="M5 7v14h11" />
        </Glyph>
      );
    case 'git-workflow':
      return (
        <Glyph size={size}>
          <path d="M6 3v12" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </Glyph>
      );
    case 'internal-comms':
      return (
        <Glyph size={size}>
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M8 9h8M8 12.5h5" />
        </Glyph>
      );
    case 'mcp-builder':
      return (
        <Glyph size={size}>
          <path d="M9 3v5M15 3v5" />
          <path d="M7 8h10v4a5 5 0 0 1-10 0z" />
          <path d="M12 17v4" />
        </Glyph>
      );
    case 'pdf-toolkit':
      return (
        <Glyph size={size}>
          <path d="M6 3h8l5 5v13H6z" />
          <path d="M14 3v5h5" />
          <rect x="8.5" y="13" width="7" height="4" rx="1" />
        </Glyph>
      );
    case 'spreadsheet-toolkit':
      return (
        <Glyph size={size}>
          <rect x="4" y="5" width="16" height="14" rx="1.5" />
          <path d="M4 11h16M12 5v14" />
        </Glyph>
      );
    case 'web-research':
      return (
        <Glyph size={size}>
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16" />
          <path d="M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" />
        </Glyph>
      );
    case 'webapp-testing':
      return (
        <Glyph size={size}>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <path d="M3.5 9h17" />
          <path d="M8.5 14.5l2.5 2.5 4.5-4.5" />
        </Glyph>
      );
    case 'writing-docs':
      return (
        <Glyph size={size}>
          <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
          <path d="M13.5 6.5l3 3" />
        </Glyph>
      );
    default:
      return null;
  }
}

export function SkillGlyph({
  id,
  category,
  size,
}: {
  id?: string;
  category: string;
  size: number;
}): JSX.Element {
  const own = id !== undefined ? SkillOwnGlyph({ id, size }) : null;
  if (own !== null) return own;
  switch (category) {
    case 'authoring':
      return (
        <Glyph size={size}>
          <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
          <path d="M13.5 6.5l3 3" />
        </Glyph>
      );
    case 'dev':
      return (
        <Glyph size={size}>
          <path d="M8 7l-4 5 4 5" />
          <path d="M16 7l4 5-4 5" />
          <path d="M13.5 5l-3 14" />
        </Glyph>
      );
    case 'data':
      return (
        <Glyph size={size}>
          <path d="M5 19V11" />
          <path d="M10.5 19V5" />
          <path d="M16 19v-7" />
          <path d="M3 19h18" />
        </Glyph>
      );
    case 'research':
      return (
        <Glyph size={size}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
        </Glyph>
      );
    case 'productivity':
      return (
        <Glyph size={size}>
          <path d="M4 6.5l1.5 1.5L8 5.5" />
          <path d="M11 7h9" />
          <path d="M4 12.5l1.5 1.5L8 11.5" />
          <path d="M11 13h9" />
          <path d="M4 18.5l1.5 1.5L8 17.5" />
          <path d="M11 19h9" />
        </Glyph>
      );
    default:
      return (
        <Glyph size={size}>
          <path d="M6 3h8l5 5v13H6z" />
          <path d="M14 3v5h5" />
          <path d="M9 13h7M9 17h7" />
        </Glyph>
      );
  }
}

/** A hand-added server's mark: a prompt, not an emoji in a line-icon system. */
export function PromptGlyph({ size }: { size: number }): JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M5 7l5 5-5 5" />
      <path d="M12 18h7" />
    </Glyph>
  );
}

/** The glyph alone, for a container that draws its own box. */
export function ItemGlyph({ item, size }: { item: Item; size: number }): JSX.Element {
  if (item.kind === 'connector') return <ConnectorIcon connector={item.connector} size={size} />;
  if (item.kind === 'custom') return <PromptGlyph size={size} />;
  return <SkillGlyph id={item.skill.id} category={item.skill.category} size={size} />;
}

export function ItemMark({ item, size = 40 }: { item: Item; size?: number }): JSX.Element {
  const inner = Math.round(size * 0.55);
  // The corner scales with the tile: a row's 40px mark takes the large radius,
  // the detail's 72px the surface radius, anything smaller the medium one.
  const radius =
    size >= 64
      ? 'var(--pd-radius-surface)'
      : size >= 36
        ? 'var(--pd-radius-lg)'
        : 'var(--pd-radius-md)';
  return (
    <span
      className={item.kind === 'skill' ? 'pdc-mark pdc-mark--skill' : 'pdc-mark'}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <ItemGlyph item={item} size={inner} />
    </span>
  );
}

export function StateDot({ state }: { state: ItemState }): JSX.Element {
  return <span className="pdc-dot" data-state={state} aria-hidden="true" />;
}

/**
 * The one control a row carries — two glyphs, the way the reference does it:
 *   not yours yet → "+"    adds it (a key-needing one opens the detail, where
 *                          the keys live; a skill turns on)
 *   yours         → "···"  a menu — the remedy first when something is wrong
 *                          (Set up, Try again, Change the key), then Turn
 *                          on / off, Edit, Remove
 *   built in      → nothing to press
 * The switch the rows used to carry lives in the detail's header now; on the
 * row, a server that needs a key or would not start says so on its second
 * line, in amber, and its menu leads with the fix.
 */
export function RowControl({
  item,
  busy,
  actions,
  onOpen,
  onEdit,
  onRemove,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  /** Open the detail — the setup card, the failure card and the remove confirm live there. */
  onOpen: () => void;
  /** Given for a server the dialog can edit. */
  onEdit?: () => void;
  /** Open the detail with its remove confirm already armed. */
  onRemove?: () => void;
}): JSX.Element | null {
  if (busy) return <Spinner size={16} />;
  if (item.state === 'builtin') return null;
  if (item.state === 'available') {
    const asks = item.kind === 'connector' && needsConfig(item.connector);
    const label =
      item.kind === 'skill'
        ? `Turn on ${item.name}`
        : asks
          ? `Set up ${item.name}`
          : `Add ${item.name}`;
    return (
      <Tooltip label={item.kind === 'skill' ? 'Turn on' : asks ? 'Set up and add' : 'Add'}>
        <button
          type="button"
          className="pdc-ctl pd-focusable"
          aria-label={label}
          data-testid={asks ? `connector-setup-${item.id}` : `connector-add-${item.id}`}
          onClick={() => {
            if (item.kind === 'skill') void actions.setOn(item, true);
            else if (asks) onOpen();
            else if (item.kind === 'connector') void actions.add(item);
          }}
        >
          <IconPlus size={16} />
        </button>
      </Tooltip>
    );
  }
  return (
    <RowMenu item={item} actions={actions} onOpen={onOpen} onEdit={onEdit} onRemove={onRemove} />
  );
}

function RowMenu({
  item,
  actions,
  onOpen,
  onEdit,
  onRemove,
}: {
  item: Item;
  actions: Actions;
  onOpen: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const failed = item.kind !== 'skill' && failing(item);
  const keys = hasKeys(item);
  const on = item.state === 'on';
  // "Try again" retries where it is clicked and opens the detail, so the
  // spinner and then the answer are in view. A key-needing server's likeliest
  // failure is the key, so its remedy is the key card, which the detail opens
  // with; a server waiting for a key gets the same card.
  const retry = () => {
    const serverId = serverIdOf(item);
    if (item.kind !== 'skill' && serverId !== null && item.server !== undefined) {
      void actions.listTools(serverId, commandLine(item.server));
    }
    onOpen();
  };
  const remedy = failed
    ? keys
      ? { label: 'Change the key…', id: `connector-setup-${item.id}`, run: onOpen }
      : { label: 'Try again', id: `connector-retry-${item.id}`, run: retry }
    : item.state === 'needs-setup'
      ? { label: 'Set up…', id: `connector-setup-${item.id}`, run: onOpen }
      : null;
  const more = onEdit !== undefined || onRemove !== undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="pdc-ctl pd-focusable"
          aria-label={`More for ${item.name}`}
          data-testid={`connector-menu-${item.id}`}
        >
          <IconMore size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {remedy !== null ? (
          <DropdownMenuItem onSelect={remedy.run} data-testid={remedy.id}>
            {remedy.label}
          </DropdownMenuItem>
        ) : null}
        {item.state !== 'needs-setup' ? (
          <DropdownMenuItem
            onSelect={() => void actions.setOn(item, !on)}
            data-testid={`connector-menu-toggle-${item.id}`}
          >
            {on ? 'Turn off' : 'Turn on'}
          </DropdownMenuItem>
        ) : null}
        {more ? <DropdownMenuSeparator /> : null}
        {onEdit !== undefined ? (
          <DropdownMenuItem onSelect={onEdit} data-testid={`connector-menu-edit-${item.id}`}>
            Edit…
          </DropdownMenuItem>
        ) : null}
        {onRemove !== undefined ? (
          <DropdownMenuItem
            onSelect={onRemove}
            className="text-status-danger-fg"
            data-testid={`connector-menu-remove-${item.id}`}
          >
            Remove…
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
