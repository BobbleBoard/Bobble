import type { ReactElement, ReactNode } from 'react';

/**
 * Join menu groups with a rule between them — and only between two that are both
 * non-empty.
 *
 * THE BUG THIS EXISTS FOR: every group in this menu is conditional (a row only
 * renders when it has a handler) while the `<DropdownMenuSeparator />`s between
 * them were not. A build with no project/GitHub/skills handlers therefore
 * rendered separator, nothing, separator — two rules touching, plus one hanging
 * off the end. The user: "this + menu has so many double lines and confusion."
 *
 * Filtering first makes that unrepresentable rather than merely fixed: there is
 * no arrangement of absent handlers that can produce two rules in a row.
 */
/** A group's identity: the keys of the rows in it, which React already requires
 * to be unique and stable. */
function keyOf(group: readonly ReactNode[] | undefined): string {
  return (group ?? [])
    .map((n) => (n !== null && typeof n === 'object' && 'key' in n ? String(n.key) : '?'))
    .join('|');
}

export function joinGroups(groups: readonly (ReactNode | null)[][]): ReactNode[] {
  const filled = groups
    .map((g) => g.filter((n): n is ReactNode => n !== null && n !== undefined && n !== false))
    .filter((g) => g.length > 0);
  const out: ReactNode[] = [];
  for (const [i, group] of filled.entries()) {
    /* The separator's identity is the pair of groups it divides, not its
       position in the array — so adding a group above does not renumber (and
       remount) every rule below it. */
    if (i > 0)
      out.push(<DropdownMenuSeparator key={`sep-${keyOf(filled[i - 1])}-${keyOf(group)}`} />);
    out.push(...group);
  }
  return out;
}

import { IconButton } from './button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
} from './dropdown-menu.tsx';
import {
  IconConnector,
  IconFilm,
  IconFolderPlus,
  IconGithub,
  IconGlobe,
  IconImage,
  IconPaperclip,
  IconPlus,
  IconPuzzle,
  IconSearch,
  IconSparkles,
} from './icons.tsx';

/*
 * Composer "+" add / connectors menu (the user round-1 feedback #7 & #8, Claude
 * img3). `variant="attach"` shows just the file entries; `variant="full"` adds
 * the connectors/extensions/research/web-search block. Presentational — each
 * row calls its handler; the web-search row is a controlled toggle-check.
 *
 * Modality force-actions (spec §3.2): the `variant="full"` menu also carries a
 * generation block (Generate image / Generate video / Motion graphics / Find /
 * segment). These are "force actions" — selecting one pins the harness task
 * class for the next send (via the composer's `forcedClass` seam) instead of
 * merely toggling a tool, so "+ → Generate video" deterministically loads the
 * advanced-video preset regardless of what the prompt text reads like.
 */

/** The four modality force-actions, keyed for a stable dispatch + test list. */
export type GenActionKey = 'image' | 'video' | 'motion' | 'perception';

export interface GenActionDescriptor {
  readonly key: GenActionKey;
  readonly label: string;
  /** Stable `data-testid` on the rendered row. */
  readonly testid: string;
}

/**
 * The gen block's rows, in menu order. This is the single source of truth the
 * menu maps over (and the render test asserts against — the Radix menu content
 * lives in a portal, so the node/SSR test verifies the driving descriptor list
 * rather than the portalled DOM).
 */
export const COMPOSER_GEN_ACTIONS: readonly GenActionDescriptor[] = [
  { key: 'image', label: 'Generate image', testid: 'add-generate-image' },
  { key: 'video', label: 'Generate video', testid: 'add-generate-video' },
  { key: 'motion', label: 'Motion graphics', testid: 'add-generate-motion' },
  { key: 'perception', label: 'Find / segment in image or video', testid: 'add-perception' },
];

/** The subset of {@link ComposerAddMenuProps} the gen block dispatches to. */
export interface GenActionHandlers {
  onGenerateImage?: () => void;
  onGenerateVideo?: () => void;
  onGenerateMotion?: () => void;
  onPerception?: () => void;
}

/**
 * Pure dispatch: invoke the handler a gen-action key maps to (a no-op when that
 * handler is absent). The menu's `onSelect` and its unit test both call this, so
 * the "selecting a row invokes the right callback" wiring is covered without a
 * DOM (the descriptor→handler mapping is the whole behavior).
 */
export function selectGenAction(key: GenActionKey, handlers: GenActionHandlers): void {
  switch (key) {
    case 'image':
      handlers.onGenerateImage?.();
      break;
    case 'video':
      handlers.onGenerateVideo?.();
      break;
    case 'motion':
      handlers.onGenerateMotion?.();
      break;
    case 'perception':
      handlers.onPerception?.();
      break;
  }
}

/** Row icon per gen-action (video/motion share the film glyph family). */
const GEN_ACTION_ICON: Record<GenActionKey, ReactElement> = {
  image: <IconImage size={16} />,
  video: <IconFilm size={16} />,
  motion: <IconSparkles size={16} />,
  perception: <IconSearch size={16} />,
};

/**
 * A row the APP adds to the menu — a mode or a feature the composer does not
 * know about (Bobble help, Research, Workflows ›, Temporary chat: the W0-A
 * pre-wire's composer entries). They render as the menu's last group, in the
 * order given, and only when there are any — so a menu with none is exactly
 * the menu without the prop.
 */
export interface AddMenuEntry {
  /** Stable React key. */
  readonly key: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly testid?: string;
  readonly hint?: string;
  /** A mode that is on or off: the row is a checkbox (the Web search idiom). */
  readonly checked?: boolean;
  /** Something the person turns on or off: the row ends in a switch and the menu stays open. */
  readonly switchOn?: boolean;
  /** A rule between this entry's neighbours (label and handlers unused). */
  readonly separator?: true;
  /** A row that opens a submenu (`Workflows ›`). */
  readonly children?: readonly AddMenuEntry[];
  /** The row was picked (a checkbox row flips its mode here). */
  readonly onSelect?: () => void;
}

function renderEntry(entry: AddMenuEntry): ReactNode {
  if (entry.separator === true) return <DropdownMenuSeparator key={entry.key} />;
  if (entry.switchOn !== undefined) {
    return (
      <DropdownMenuSwitchItem
        key={entry.key}
        icon={entry.icon}
        checked={entry.switchOn}
        data-testid={entry.testid}
        onSelect={() => entry.onSelect?.()}
      >
        {entry.label}
      </DropdownMenuSwitchItem>
    );
  }
  if (entry.children !== undefined) {
    return (
      <DropdownMenuSub key={entry.key}>
        <DropdownMenuSubTrigger icon={entry.icon} data-testid={entry.testid}>
          {entry.label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>{entry.children.map(renderEntry)}</DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  if (entry.checked !== undefined) {
    return (
      <DropdownMenuCheckboxItem
        key={entry.key}
        checked={entry.checked}
        hint={entry.hint}
        data-testid={entry.testid}
        onCheckedChange={() => entry.onSelect?.()}
      >
        {entry.icon !== undefined ? <span className="pd-menu-icon">{entry.icon}</span> : null}
        {entry.label}
      </DropdownMenuCheckboxItem>
    );
  }
  return (
    <DropdownMenuItem
      key={entry.key}
      icon={entry.icon}
      hint={entry.hint}
      data-testid={entry.testid}
      onSelect={() => entry.onSelect?.()}
    >
      {entry.label}
    </DropdownMenuItem>
  );
}

export interface ComposerAddMenuProps {
  /** Trigger element; defaults to a "+" IconButton. */
  trigger?: ReactNode;
  variant?: 'attach' | 'full';
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  onAddFiles?: () => void;
  onTakeScreenshot?: () => void;
  onAddToProject?: () => void;
  onAddFromGitHub?: () => void;
  onSkills?: () => void;
  onAddConnector?: () => void;
  onAddPlugins?: () => void;
  onResearch?: () => void;
  webSearch?: boolean;
  onWebSearchChange?: (value: boolean) => void;
  /** Modality force-actions (spec §3.2) — `variant="full"` only. */
  onGenerateImage?: () => void;
  onGenerateVideo?: () => void;
  onGenerateMotion?: () => void;
  onPerception?: () => void;
  /** Rows the app adds, drawn as the last group (`variant="full"` only). */
  entries?: readonly AddMenuEntry[];
  /** Force-open for galleries/screenshots. */
  open?: boolean;
  defaultOpen?: boolean;
}

export function ComposerAddMenu({
  trigger,
  variant = 'full',
  side = 'top',
  align = 'start',
  onAddFiles,
  onTakeScreenshot,
  onAddToProject,
  onAddFromGitHub,
  onSkills,
  onAddConnector,
  onAddPlugins,
  onResearch,
  webSearch = false,
  onWebSearchChange,
  onGenerateImage,
  onGenerateVideo,
  onGenerateMotion,
  onPerception,
  entries,
  open,
  defaultOpen,
}: ComposerAddMenuProps) {
  const genHandlers: GenActionHandlers = {
    onGenerateImage,
    onGenerateVideo,
    onGenerateMotion,
    onPerception,
  };
  return (
    <DropdownMenu open={open} defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <IconButton aria-label="Add to message">
            <IconPlus />
          </IconButton>
        )}
      </DropdownMenuTrigger>
      {/*
        Round-10 (#11): the composer "+" menu opens/closes instantly.

        A ROW EXISTS ONLY IF IT CAN ACT. Every optional item used to render
        unconditionally with `onSelect={() => onThing?.()}` — so an absent
        handler produced a menu row that highlighted, accepted a click, closed
        the menu and did nothing. MEASURED by driving the built app: 8 of 13
        rows in the app's only capability surface were dead that way.

        An unimplemented row is worse than an absent one: it teaches the user
        the app is broken rather than that the feature is elsewhere. Gating on
        the handler also means wiring one up makes its row appear — nothing to
        re-add, and no way to ship a dead row again.
      */}
      {/*
        GROUPS, NOT A RIBBON OF SEPARATORS.
        The user, looking at the shipped menu: "this + menu has so many double lines
        and confusion." The user was seeing two rules in a row and one hanging off the
        end — the separators were UNCONDITIONAL while every group between them
        was conditional, so a build with no project/GitHub/skills handlers
        rendered separator, nothing, separator.
        Building the groups first and joining them means a rule can only ever
        appear BETWEEN two groups that both have something in them.
      */}
      <DropdownMenuContent className="pd-menu--instant" side={side} align={align}>
        {joinGroups([
          [
            <DropdownMenuItem
              key="add-files"
              icon={<IconPaperclip size={16} />}
              hint="⌘U"
              onSelect={() => onAddFiles?.()}
            >
              Add files or photos
            </DropdownMenuItem>,
            onTakeScreenshot !== undefined ? (
              <DropdownMenuItem
                key="screenshot"
                icon={<IconImage size={16} />}
                onSelect={onTakeScreenshot}
              >
                Take a screenshot
              </DropdownMenuItem>
            ) : null,
          ],
          variant !== 'full'
            ? []
            : [
                onAddToProject !== undefined ? (
                  <DropdownMenuItem
                    key="add-to-project"
                    icon={<IconFolderPlus size={16} />}
                    onSelect={onAddToProject}
                  >
                    Add to project
                  </DropdownMenuItem>
                ) : null,
                onAddFromGitHub !== undefined ? (
                  <DropdownMenuItem
                    key="github"
                    icon={<IconGithub size={16} />}
                    onSelect={onAddFromGitHub}
                  >
                    Add from GitHub
                  </DropdownMenuItem>
                ) : null,
                onSkills !== undefined ? (
                  <DropdownMenuItem
                    key="skills"
                    icon={<IconSparkles size={16} />}
                    onSelect={onSkills}
                  >
                    Skills
                  </DropdownMenuItem>
                ) : null,
                onAddConnector !== undefined ? (
                  <DropdownMenuItem
                    key="connector"
                    icon={<IconConnector size={16} />}
                    onSelect={onAddConnector}
                  >
                    Add connector
                  </DropdownMenuItem>
                ) : null,
                onAddPlugins !== undefined ? (
                  <DropdownMenuItem
                    key="plugins"
                    icon={<IconPuzzle size={16} />}
                    onSelect={onAddPlugins}
                  >
                    Add plugins…
                  </DropdownMenuItem>
                ) : null,
              ],
          variant !== 'full'
            ? []
            : COMPOSER_GEN_ACTIONS.map((action) => (
                <DropdownMenuItem
                  key={action.key}
                  data-testid={action.testid}
                  icon={GEN_ACTION_ICON[action.key]}
                  onSelect={() => selectGenAction(action.key, genHandlers)}
                >
                  {action.label}
                </DropdownMenuItem>
              )),
          variant !== 'full'
            ? []
            : [
                onResearch !== undefined ? (
                  <DropdownMenuItem
                    key="research"
                    icon={<IconSearch size={16} />}
                    onSelect={onResearch}
                  >
                    Research
                  </DropdownMenuItem>
                ) : null,
                onWebSearchChange !== undefined ? (
                  <DropdownMenuCheckboxItem
                    key="web-search"
                    checked={webSearch}
                    onCheckedChange={(next) => onWebSearchChange(next === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="pd-menu-icon">
                      <IconGlobe size={16} />
                    </span>
                    Web search
                  </DropdownMenuCheckboxItem>
                ) : null,
              ],
          variant !== 'full' || entries === undefined ? [] : entries.map(renderEntry),
        ])}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
