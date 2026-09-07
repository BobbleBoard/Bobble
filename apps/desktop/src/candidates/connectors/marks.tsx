/**
 * Marks, dots and the one state control every candidate shares.
 *
 * A connector shows its real brand mark (via the shipping ConnectorIcon); a
 * custom server shows a prompt; a skill shows a category glyph drawn in the
 * same 24-grid line style as the catalog's neutral marks — so a skills list
 * does not become the wall of identical icons the Anthropic plugin directory
 * turned into.
 *
 * No "official" mark. Round 1 replaced the references' blue badge with a quiet
 * check and drew it on 23 of 27 tools, which is the same noise at lower
 * contrast. The exception — a community server — is named in the detail.
 */
import { Button, IconButton, IconPlus, Spinner, Switch, Tooltip } from '@pi-desktop/ui';
import type { JSX, ReactNode } from 'react';
import { ConnectorIcon } from '../../connectors/ConnectorIcon';
import {
  type Actions,
  commandLine,
  failing,
  hasKeys,
  type Item,
  type ItemState,
  needsConfig,
  serverIdOf,
} from './data';

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

/**
 * One glyph per skill, authored once. The category glyphs below were five
 * shapes for twelve skills — `</>` on four of the six cards on the first
 * screen — which is the beginning of the plugin-directory wall of identical
 * marks. A skill the map does not know falls back to its category.
 */
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

export function PromptGlyph({ size }: { size: number }): JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M5 7l5 5-5 5" />
      <path d="M12 18h7" />
    </Glyph>
  );
}

/** The glyph alone, for a container that draws its own box (the strip tiles). */
export function ItemGlyph({ item, size }: { item: Item; size: number }): JSX.Element {
  if (item.kind === 'connector') return <ConnectorIcon connector={item.connector} size={size} />;
  if (item.kind === 'custom') return <PromptGlyph size={size} />;
  return <SkillGlyph id={item.skill.id} category={item.skill.category} size={size} />;
}

export function ItemMark({ item, size = 40 }: { item: Item; size?: number }): JSX.Element {
  const inner = Math.round(size * 0.55);
  const box = { width: size, height: size };
  return (
    <span
      className={item.kind === 'skill' ? 'cand-mark cand-mark--skill' : 'cand-mark'}
      style={box}
    >
      <ItemGlyph item={item} size={inner} />
    </span>
  );
}

export function StateDot({ state }: { state: ItemState }): JSX.Element {
  return <span className="cand-dot" data-state={state} aria-hidden="true" />;
}

export const STATE_LABEL: Record<ItemState, string> = {
  builtin: 'Built in',
  on: 'On',
  off: 'Off',
  'needs-setup': 'Needs setup',
  available: '',
};

export const KIND_LABEL: Record<Item['kind'], string> = {
  connector: 'Tool',
  custom: 'Custom server',
  skill: 'Skill',
};

/**
 * The one control a row carries, by state — two visual families, not four:
 *   available             → "+"       (a key-needing one opens the detail, where the keys live)
 *   on / off              → a switch
 *   needs-setup           → "● Set up" (the one place a word earns its width: it asks for attention)
 *   on, last listing failed → "● Set up" again where a key is the likeliest cause, "● Try again"
 *                           otherwise: a switch that is on says nothing about a server that
 *                           does not answer (round 4, item 1). The detail's header keeps the
 *                           switch — it is how the server is turned off — and says the state
 *                           in words beside it (`showFailure={false}`).
 *   builtin               → nothing to press; the row says "Built in" where its text goes
 * Skills are a switch in every state: installing one is a file copy, instant
 * and reversible, so on/off is the honest grammar.
 */
export function StateControl({
  item,
  busy,
  actions,
  onSetup,
  showFailure = true,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  onSetup: () => void;
  showFailure?: boolean;
}): JSX.Element | null {
  if (busy) return <Spinner size={16} />;
  if (showFailure && item.kind !== 'skill' && failing(item)) {
    const keys = hasKeys(item);
    const serverId = serverIdOf(item);
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          // "Try again" retries where it is clicked and opens the detail, so
          // the spinner and then the answer are in view; "Set up" opens the
          // detail with the key card already open (ShelfPlus.Detail).
          if (!keys && serverId !== null && item.server !== undefined) {
            void actions.listTools(serverId, commandLine(item.server));
          }
          onSetup();
        }}
        data-testid={keys ? `cand-setup-${item.id}` : `cand-retry-${item.id}`}
      >
        <StateDot state="needs-setup" /> {keys ? 'Set up' : 'Try again'}
      </Button>
    );
  }
  const toggle = (
    <Switch
      size="sm"
      checked={item.state === 'on'}
      aria-label={`${item.state === 'on' ? 'Turn off' : 'Turn on'} ${item.name}`}
      data-testid={`cand-toggle-${item.id}`}
      onCheckedChange={(v) => void actions.setOn(item, v === true)}
    />
  );
  if (item.kind === 'skill') return toggle;
  switch (item.state) {
    case 'builtin':
      return null;
    case 'on':
    case 'off':
      return toggle;
    case 'needs-setup':
      return (
        <Button size="sm" variant="outline" onClick={onSetup} data-testid={`cand-setup-${item.id}`}>
          <StateDot state="needs-setup" /> Set up
        </Button>
      );
    default: {
      const asks = item.kind === 'connector' && needsConfig(item.connector);
      const label = asks ? `Set up ${item.name}` : `Add ${item.name}`;
      return (
        <Tooltip label={asks ? 'Set up and add' : 'Add'}>
          <IconButton
            size="sm"
            variant="outline"
            aria-label={label}
            data-testid={asks ? `cand-setup-${item.id}` : `cand-add-${item.id}`}
            onClick={() => {
              if (asks) onSetup();
              else if (item.kind === 'connector') void actions.add(item);
            }}
          >
            <IconPlus size={14} />
          </IconButton>
        </Tooltip>
      );
    }
  }
}
