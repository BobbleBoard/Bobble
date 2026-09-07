import type { ReactElement, ReactNode } from 'react';

/**
 * Join menu groups with a rule between them — and only between two that are both
 * non-empty.
 *
 * THE BUG THIS EXISTS FOR: every group in this menu is conditional (a row only
 * renders when it has a handler) while the `<DropdownMenuSeparator />`s between
 * them were not. A build with no project/GitHub/skills handlers therefore
 * rendered separator, nothing, separator — two rules touching, plus one hanging
 * off the end. the user: "this + menu has so many double lines and confusion."
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
        the user, looking at the shipped menu: "this + menu has so many double lines
        and confusion." He was seeing two rules in a row and one hanging off the
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
        ])}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
