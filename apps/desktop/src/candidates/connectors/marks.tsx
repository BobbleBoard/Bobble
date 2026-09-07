/**
 * Marks, dots and the one state control every candidate shares.
 *
 * A connector shows its real brand mark (via the shipping ConnectorIcon); a
 * custom server shows a prompt; a skill shows a category glyph drawn in the
 * same 24-grid line style as the catalog's neutral marks — so a skills list
 * does not become the wall of identical icons the Anthropic plugin directory
 * turned into.
 */
import { Button, Spinner, Switch, Tooltip } from '@pi-desktop/ui';
import type { JSX, ReactNode } from 'react';
import { ConnectorIcon } from '../../connectors/ConnectorIcon';
import { type Actions, type Item, type ItemState, needsConfig } from './data';

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

export function SkillGlyph({ category, size }: { category: string; size: number }): JSX.Element {
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

/** The vendor's own server. A quiet check, not a blue badge on every card. */
export function OfficialMark({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <Tooltip label="Official: published by the vendor itself">
      <span className="inline-flex text-text-muted" data-testid="cand-official">
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2.5l2.4 1.7 2.9-.3 1 2.8 2.5 1.5-.6 2.9 1.4 2.6-2.1 2-.3 2.9-2.8.8-1.6 2.5-2.8-1-2.8 1-1.6-2.5-2.8-.8-.3-2.9-2.1-2 1.4-2.6-.6-2.9L5.7 6.7l1-2.8 2.9.3z" />
          <path d="M8.5 12.2l2.3 2.3 4.7-4.8" />
        </svg>
      </span>
    </Tooltip>
  );
}

/** The glyph alone, for a container that draws its own box (the strip tiles). */
export function ItemGlyph({ item, size }: { item: Item; size: number }): JSX.Element {
  if (item.kind === 'connector') return <ConnectorIcon connector={item.connector} size={size} />;
  if (item.kind === 'custom') return <PromptGlyph size={size} />;
  return <SkillGlyph category={item.skill.category} size={size} />;
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
 * The one control a row carries, by state:
 *   available (no setup)  → Add
 *   available (needs key) → Set up   (opens the detail, where the keys live)
 *   needs-setup           → Set up
 *   on / off              → a switch
 *   builtin               → "Built in", nothing to press
 * Skills are a switch in every state: installing one is a file copy, instant
 * and reversible, so on/off is the honest grammar.
 */
export function StateControl({
  item,
  busy,
  actions,
  onSetup,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  onSetup: () => void;
}): JSX.Element {
  if (busy) return <Spinner size={16} />;
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
      return <span className="text-caption text-text-muted">Built in</span>;
    case 'on':
    case 'off':
      return toggle;
    case 'needs-setup':
      return (
        <Button size="sm" variant="outline" onClick={onSetup} data-testid={`cand-setup-${item.id}`}>
          <StateDot state="needs-setup" /> Set up
        </Button>
      );
    default:
      if (item.kind === 'connector' && needsConfig(item.connector)) {
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={onSetup}
            data-testid={`cand-setup-${item.id}`}
          >
            Set up
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          variant="outline"
          data-testid={`cand-add-${item.id}`}
          onClick={() => {
            if (item.kind === 'connector') void actions.add(item);
          }}
        >
          Add
        </Button>
      );
  }
}
